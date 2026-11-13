"""Identidade de jogadores entre peladas da pool (regras puras, sem banco nem HTTP).

Cada pelada gera ids próprios para os jogadores. Ao vincular uma pelada à pool, o admin
decide, jogador a jogador, se ele é um jogador já existente na pool (alias para o id dela)
ou um novo jogador (opcionalmente renomeado para não colidir com ninguém da pool).
"""
import copy
import re
from typing import Any, Dict, List, Optional, Tuple


def normalize_name(name: str) -> str:
    """Nome para comparação: espaços colapsados e sem diferença de maiúsculas."""
    return re.sub(r"\s+", " ", (name or "")).strip().lower()


def clean_name(name: str) -> str:
    """Nome para gravar: espaços colapsados nas pontas e no meio."""
    return re.sub(r"\s+", " ", (name or "")).strip()


def resolve_alias(player_id: str, aliases: Dict[str, str]) -> str:
    """Segue a cadeia de aliases até o id canônico (protegido contra ciclos)."""
    seen = set()
    current = str(player_id)
    while current in aliases and current not in seen:
        seen.add(current)
        current = str(aliases[current])
    return current


def find_pool_matches(name: str, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    target = normalize_name(name)
    return [c for c in candidates if normalize_name(c["name"]) == target]


def validate_pool_links(
    players: List[Dict[str, Any]],
    candidates: List[Dict[str, Any]],
    links: List[Dict[str, str]],
    renames: Dict[str, str],
) -> Tuple[Optional[str], Dict[str, str]]:
    """Confere o vínculo escolhido pelo admin. Devolve (erro, mapa current_id -> pool_id)."""
    current_ids = {str(p["id"]) for p in players}
    candidate_ids = {str(c["id"]) for c in candidates}

    link_map: Dict[str, str] = {}
    targets = set()
    for link in links:
        pid, target = str(link["player_id"]), str(link["pool_player_id"])
        if pid not in current_ids:
            return f"Jogador {pid} não está nesta pelada.", {}
        if target not in candidate_ids:
            return "O jogador escolhido não pertence à pool.", {}
        if target in targets:
            return "Um jogador da pool só pode ser vinculado a um jogador desta pelada.", {}
        if pid in link_map:
            return "Um jogador desta pelada só pode ser vinculado uma vez.", {}
        link_map[pid] = target
        targets.add(target)

    for pid in renames:
        if pid not in current_ids:
            return f"Jogador {pid} não está nesta pelada.", {}
        if pid in link_map:
            return "Jogador vinculado à pool não pode ser renomeado.", {}

    names_seen = set()
    for p in players:
        pid = str(p["id"])
        name = renames.get(pid, p["name"])
        key = normalize_name(name)
        if key in names_seen:
            return f"Já existe um jogador chamado '{clean_name(name)}' nesta pelada.", {}
        names_seen.add(key)
        if pid not in link_map and find_pool_matches(name, candidates):
            return (f"'{clean_name(name)}' já existe na pool: vincule ao jogador correspondente "
                    "ou renomeie o jogador desta pelada."), {}
    return None, link_map


def apply_renames(
    players: List[Dict[str, Any]],
    teams: List[Dict[str, Any]],
    fixtures: List[Dict[str, Any]],
    renames: Dict[str, str],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Troca o nome de jogadores na lista, nos times, nas partidas da tabela e nos eventos."""
    if not renames:
        return players, teams, fixtures
    new_players = copy.deepcopy(players)
    new_teams = copy.deepcopy(teams)
    new_fixtures = copy.deepcopy(fixtures)

    def rename_entries(entries: List[Dict[str, Any]]) -> None:
        for entry in entries or []:
            pid = str(entry.get("id"))
            if pid in renames:
                entry["name"] = renames[pid]

    rename_entries(new_players)
    for team in new_teams:
        rename_entries(team.get("players", []))
    for fixture in new_fixtures:
        rename_entries(fixture.get("home_players", []))
        rename_entries(fixture.get("away_players", []))
        for ev in fixture.get("events", []) or []:
            pid = ev.get("player_id")
            if pid is not None and str(pid) in renames:
                ev["player_name"] = renames[str(pid)]
    return new_players, new_teams, new_fixtures
