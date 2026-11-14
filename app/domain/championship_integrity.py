"""Detecta quando edições manuais da tabela fugiram das regras do formato do campeonato."""
from collections import Counter
from typing import Any, Dict, List, Optional, Sequence

from app.domain.king_of_court import compute_state


def _rounds_modified(fixtures: Sequence[Dict[str, Any]]) -> bool:
    """Rodadas: nenhum time joga duas vezes na mesma rodada e as rodadas são 1..R sem buracos.

    Sem `round_number` em todas as partidas (tabela antiga), não há o que comparar e não é [MOD].
    """
    numbers = [f.get("round_number") for f in fixtures]
    if any(not isinstance(r, int) for r in numbers):
        return False
    teams_by_round: Dict[int, set] = {}
    for f, r in zip(fixtures, numbers):
        teams = teams_by_round.setdefault(r, set())
        for tid in (f.get("home_team_id"), f.get("away_team_id")):
            if tid in teams:
                return True
            teams.add(tid)
    return sorted(teams_by_round) != list(range(1, len(teams_by_round) + 1))


def round_robin_modified(team_ids: Sequence[str], fixtures: Sequence[Dict[str, Any]], rounds: int) -> bool:
    """Turno único/duplo: cada par de times precisa aparecer exatamente `rounds` vezes, sem times desconhecidos,
    e cada rodada não pode repetir time nem deixar buracos."""
    if not fixtures:
        return False
    ids = list(team_ids)
    valid = set(ids)
    counts: Counter = Counter()
    for f in fixtures:
        h, a = f.get("home_team_id"), f.get("away_team_id")
        if h not in valid or a not in valid or h == a:
            return True
        counts[frozenset((h, a))] += 1
    expected = max(1, rounds)
    n = len(ids)
    if len(counts) != n * (n - 1) // 2:
        return True
    if any(c != expected for c in counts.values()):
        return True
    return _rounds_modified(fixtures)


def king_modified(team_ids: Sequence[str], fixtures: Sequence[Dict[str, Any]], **rules: Any) -> bool:
    """Rei da Pelada: cada partida precisa ser a que o histórico anterior determina (a abertura é livre)."""
    if not fixtures:
        return False
    ids = list(team_ids)
    valid = set(ids)
    for f in fixtures:
        if f.get("home_team_id") not in valid or f.get("away_team_id") not in valid:
            return True
    start = [fixtures[0].get("home_team_id"), fixtures[0].get("away_team_id")]
    for i in range(1, len(fixtures)):
        previous = fixtures[:i]
        if not all(p.get("finished") for p in previous):
            break  # não dá para prever depois de uma partida em aberto
        court = compute_state(ids, previous, start_pair=start, **rules)["court"]
        f = fixtures[i]
        if set(court) != {f.get("home_team_id"), f.get("away_team_id")}:
            return True
    return False


# Regras que valem para cada formato (o que muda o rumo de partidas já jogadas)
_RULES_BY_TYPE = {
    "single": ("championship_type", "first_match_home_id", "first_match_away_id"),
    "double": ("championship_type", "first_match_home_id", "first_match_away_id"),
    "king": ("championship_type", "first_match_home_id", "first_match_away_id",
             "king_draw_rule", "king_max_consecutive_wins"),
    "custom": ("championship_type",),
}
RULE_KEYS = tuple(sorted({k for keys in _RULES_BY_TYPE.values() for k in keys}))


def rules_changed(baseline: Optional[Dict[str, Any]], current: Dict[str, Any]) -> bool:
    """Compara as regras do formato com as vigentes quando a tabela foi montada (sem baseline = sem mudança)."""
    if not baseline:
        return False
    if (baseline.get("championship_type") or "single") != (current.get("championship_type") or "single"):
        return True
    keys = _RULES_BY_TYPE.get(current.get("championship_type") or "single", _RULES_BY_TYPE["single"])
    return any((baseline.get(k) or None) != (current.get(k) or None) for k in keys)


def format_modified(championship_type: str, team_ids: Sequence[str], fixtures: Sequence[Dict[str, Any]],
                    **king_rules: Any) -> bool:
    """A tabela foge do formato (sem considerar a troca de regras)."""
    if championship_type in ("single", "double"):
        return round_robin_modified(team_ids, fixtures, 2 if championship_type == "double" else 1)
    if championship_type == "king":
        return king_modified(team_ids, fixtures, **king_rules)
    return False  # formato livre não tem tabela a violar


def is_modified(championship_type: str, team_ids: Sequence[str], fixtures: Sequence[Dict[str, Any]], *,
                rules: Optional[Dict[str, Any]] = None, rules_baseline: Optional[Dict[str, Any]] = None,
                **king_rules: Any) -> bool:
    """[MOD]: a tabela foge do formato OU as regras mudaram depois de já haver partidas finalizadas."""
    if any(f.get("finished") for f in fixtures) and rules_changed(rules_baseline, rules or {"championship_type": championship_type}):
        return True
    return format_modified(championship_type, team_ids, fixtures, **king_rules)
