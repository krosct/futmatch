"""Movimento manual de partidas na tabela (arrastar um card).

Duas operações, ambas mudam só o `round_number` das partidas:
- trocar: o card solto sobre outro card troca de rodada/posição com ele (todos os formatos);
- mover: o card solto sobre uma rodada passa a fazer parte dela (turno único/duplo e livre).

`valid_drop_targets` diz onde a movimentação preserva o formato (a dica piscante no front).
Formato livre não tem regra, então não há dica.
"""
from typing import Any, Dict, List, Optional, Sequence

from app.domain.championship_integrity import format_modified

ROUND_ROBIN = ("single", "double")


def _ordenadas(fixtures: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Cópias das partidas na ordem da tabela (rodada; empates mantêm a ordem atual)."""
    return sorted((dict(f) for f in fixtures), key=lambda f: f.get("round_number") or 0)


def trocar_partidas(fixtures: Sequence[Dict[str, Any]], a_id: str, b_id: str) -> List[Dict[str, Any]]:
    """Nova tabela em que as duas partidas trocam de posição (slot) e de rodada.

    A lista já vem ordenada por rodada; trocar as posições e as rodadas mantém essa ordem sem reordenar,
    então cada partida ocupa exatamente o slot da outra (como o usuário vê na tela).
    """
    copias = [dict(f) for f in fixtures]
    i = next(k for k, f in enumerate(copias) if f.get("id") == a_id)
    j = next(k for k, f in enumerate(copias) if f.get("id") == b_id)
    a, b = copias[i], copias[j]
    a["round_number"], b["round_number"] = b.get("round_number"), a.get("round_number")
    copias[i], copias[j] = b, a
    return copias


def mover_partida(fixtures: Sequence[Dict[str, Any]], match_id: str, rodada: int) -> List[Dict[str, Any]]:
    """Nova tabela em que a partida passa a fazer parte da rodada indicada."""
    copias = [dict(f) for f in fixtures]
    next(f for f in copias if f.get("id") == match_id)["round_number"] = rodada
    return _ordenadas(copias)


def valid_drop_targets(championship_type: str, team_ids: Sequence[str], fixtures: Sequence[Dict[str, Any]],
                       moved_id: str, **king_rules: Any) -> Dict[str, List[Any]]:
    """Alvos em que soltar `moved_id` preserva o formato.

    Devolve {"cards": [ids de partidas que podem ser trocadas], "rounds": [rodadas que podem receber a partida]}.
    Simula cada movimento e usa a mesma checagem do [MOD], sem a parte de troca de regras.
    """
    vazio: Dict[str, List[Any]] = {"cards": [], "rounds": []}
    if championship_type not in ROUND_ROBIN + ("king",):
        return vazio
    atual = next((f for f in fixtures if f.get("id") == moved_id), None)
    if atual is None:
        return vazio
    rodada_atual = atual.get("round_number")

    cards = []
    for f in fixtures:
        if f.get("id") == moved_id or f.get("round_number") == rodada_atual:
            continue
        nova = trocar_partidas(fixtures, moved_id, f["id"])
        if not format_modified(championship_type, team_ids, nova, **king_rules):
            cards.append(f["id"])

    rounds: List[int] = []
    if championship_type in ROUND_ROBIN:
        existentes = sorted({f.get("round_number") for f in fixtures if isinstance(f.get("round_number"), int)})
        for rodada in existentes:  # a rodada de origem também é alvo: é onde a partida "deveria" ficar
            nova = mover_partida(fixtures, moved_id, rodada)
            if not format_modified(championship_type, team_ids, nova, **king_rules):
                rounds.append(rodada)
    return {"cards": cards, "rounds": rounds}
