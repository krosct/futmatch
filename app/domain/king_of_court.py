"""Formato "Rei da Pelada": o vencedor fica em campo e o próximo da fila entra.

Lógica pura (sem FastAPI/SQLite). O estado (quem está em campo, a fila e as
sequências de vitórias) é sempre reconstruído a partir do histórico de partidas
finalizadas, então não há nada extra para persistir.
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

from app.domain.models import Match, Team

# Critérios para decidir quem sai em caso de empate
DRAW_RULES = (
    "both",          # os dois times saem
    "fewer_points",  # sai quem tem menos pontos
    "fewer_goals",   # sai quem tem menos gols
    "fewer_wins",    # sai quem tem menos vitórias
    "more_points",   # sai quem tem mais pontos
    "more_goals",    # sai quem tem mais gols
    "more_wins",     # sai quem tem mais vitórias
)
DEFAULT_DRAW_RULE = "both"


def _pick_leaver(home: str, away: str, rule: str, stats: Dict[str, Dict[str, int]], since: Dict[str, int]) -> str:
    """Escolhe quem sai num empate pelo critério; persistindo o empate, sai quem está há mais jogos em campo."""
    metric = {"points": "points", "goals": "goals", "wins": "wins"}[rule.split("_", 1)[1]]
    pick = min if rule.startswith("fewer") else max
    h_val, a_val = stats[home][metric], stats[away][metric]
    if h_val != a_val:
        return home if pick(h_val, a_val) == h_val else away
    if since[home] != since[away]:
        return home if since[home] > since[away] else away
    return home


def compute_state(
    team_ids: Sequence[str],
    history: Sequence[Dict[str, Any]],
    *,
    start_pair: Optional[Sequence[str]] = None,
    draw_rule: str = DEFAULT_DRAW_RULE,
    max_consecutive_wins: int = 0,
    points_win: int = 3,
    points_draw: int = 1,
) -> Dict[str, Any]:
    """Reproduz as partidas finalizadas (em ordem) e devolve quem está em campo e a fila de espera."""
    ids = list(team_ids)
    valid = set(ids)
    if draw_rule not in DRAW_RULES:
        draw_rule = DEFAULT_DRAW_RULE

    pair = list(start_pair or [])
    if len(pair) != 2 or pair[0] == pair[1] or not all(p in valid for p in pair):
        pair = ids[:2]
    court = list(pair)
    queue = [i for i in ids if i not in court]

    stats = {i: {"points": 0, "goals": 0, "wins": 0} for i in ids}
    streak = {i: 0 for i in ids}  # vitórias seguidas
    since = {i: 0 for i in ids}   # jogos seguidos em campo

    for m in history:
        h, a = m.get("home_team_id"), m.get("away_team_id")
        if h not in valid or a not in valid:
            continue
        hs, as_ = int(m.get("home_score", 0)), int(m.get("away_score", 0))
        stats[h]["goals"] += hs
        stats[a]["goals"] += as_
        for t in (h, a):
            since[t] += 1

        if hs == as_:
            stats[h]["points"] += points_draw
            stats[a]["points"] += points_draw
            streak[h] = streak[a] = 0
            if draw_rule == "both":
                leaving = [h, a]
            else:
                leaving = [_pick_leaver(h, a, draw_rule, stats, since)]
        else:
            winner, loser = (h, a) if hs > as_ else (a, h)
            stats[winner]["points"] += points_win
            stats[winner]["wins"] += 1
            streak[winner] += 1
            streak[loser] = 0
            leaving = [loser]
            if max_consecutive_wins > 0 and streak[winner] >= max_consecutive_wins:
                leaving.append(winner)

        for t in leaving:
            streak[t] = 0
            since[t] = 0
            # Histórico fora de ordem: quem não está em campo não entra na fila de novo
            if t in court:
                court.remove(t)
                queue.append(t)
        # Quem está em campo mas não estava na partida (histórico fora de ordem) é ignorado
        while len(court) < 2 and queue:
            court.append(queue.pop(0))

    return {"court": court, "queue": queue, "streak": streak, "stats": stats}


def plan_next(
    teams: Sequence[Team],
    fixtures: Sequence[Dict[str, Any]],
    *,
    start_pair: Optional[Sequence[str]] = None,
    draw_rule: str = DEFAULT_DRAW_RULE,
    max_consecutive_wins: int = 0,
    points_win: int = 3,
    points_draw: int = 1,
) -> Tuple[Optional[Match], List[str]]:
    """Monta a próxima partida do Rei da Pelada e devolve também a fila de espera (ids)."""
    if len(teams) < 2:
        return None, []
    by_id = {t.id: t for t in teams}
    finished = [f for f in fixtures if f.get("finished")]
    st = compute_state(
        list(by_id.keys()), finished,
        start_pair=start_pair, draw_rule=draw_rule, max_consecutive_wins=max_consecutive_wins,
        points_win=points_win, points_draw=points_draw,
    )
    if len(st["court"]) < 2:
        return None, []
    home, away = by_id[st["court"][0]], by_id[st["court"][1]]

    used = []
    for f in fixtures:
        fid = str(f.get("id", ""))
        if fid.startswith("m_") and fid[2:].isdigit():
            used.append(int(fid[2:]))
    number = max(used, default=0) + 1
    match = Match(
        id=f"m_{number}",
        round_number=min(len(fixtures) + 1, 100),
        home_team_id=home.id,
        home_team_name=home.name,
        away_team_id=away.id,
        away_team_name=away.name,
        home_players=[{"id": p.id, "name": p.name} for p in home.players],
        away_players=[{"id": p.id, "name": p.name} for p in away.players],
    )
    return match, st["queue"]


def next_match(teams: Sequence[Team], fixtures: Sequence[Dict[str, Any]], **rules: Any) -> Optional[Match]:
    """Atalho: apenas a próxima partida (ou None se faltarem times)."""
    return plan_next(teams, fixtures, **rules)[0]
