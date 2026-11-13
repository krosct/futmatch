"""Regras de consistência do estado da pelada: times precisam de jogadores e partidas precisam de times."""
from typing import Any, Dict, List, Optional, Set


def find_state_inconsistency(
    players: List[Dict[str, Any]],
    teams: List[Dict[str, Any]],
    fixtures: List[Dict[str, Any]],
) -> Optional[str]:
    """Devolve a mensagem do primeiro problema encontrado ou None se o estado é consistente."""
    player_ids = {p.get("id") for p in players}
    for t in teams:
        for p in t.get("players") or []:
            if p.get("id") not in player_ids:
                return f"O time '{t.get('name', '')}' tem o jogador '{p.get('name', '')}', que não está na lista de jogadores."
    team_ids = {t.get("id") for t in teams}
    for f in fixtures:
        for key in ("home_team_id", "away_team_id"):
            tid = f.get(key)
            if tid and tid not in team_ids:
                return "Há partidas com times que não existem. Crie os times antes das partidas."
    return None


def aviso_times_sem_jogadores(nomes: List[str]) -> str:
    """Mensagem única para bloquear partidas com times sem jogadores (usada em todos os caminhos de criação)."""
    return f"Não é possível criar partida com time sem jogadores: {', '.join(nomes)}."


def times_sem_jogadores(teams: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Times sem nenhum jogador (dicts com 'id' e 'name')."""
    return [t for t in teams if not (t.get("players") or [])]


def find_empty_team_in_new_fixtures(
    teams: List[Dict[str, Any]],
    fixtures: List[Dict[str, Any]],
    known_fixture_ids: Set[Any],
) -> Optional[str]:
    """Partida nova não pode envolver time sem jogadores.

    Partidas já existentes (ids em `known_fixture_ids`) não são barradas: editar ou remover
    continua permitido mesmo que um time tenha ficado sem jogadores depois.
    """
    vazios = {t.get("id"): t.get("name", "") for t in times_sem_jogadores(teams)}
    nomes: List[str] = []
    for f in fixtures:
        if f.get("id") in known_fixture_ids:
            continue
        for key in ("home_team_id", "away_team_id"):
            nome = vazios.get(f.get(key))
            if nome is not None and nome not in nomes:
                nomes.append(nome)
    return aviso_times_sem_jogadores(nomes) if nomes else None
