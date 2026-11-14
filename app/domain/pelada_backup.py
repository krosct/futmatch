"""Formato do arquivo de exportação e importação de uma pelada (JSON).

Funções puras: não acessam banco, HTTP nem relógio. Quem chama passa os dados e a data da exportação.
A senha mestra nunca entra no documento: o hash seria um alvo para força bruta offline.
"""
from typing import Any, Dict, List, Optional

BACKUP_FORMAT = "futmatch-pelada"
BACKUP_VERSION = 2  # v2: pool.parent_codes (lista); v1 trazia pool.parent_code (um pai)


def build_backup_document(
    *,
    code: str,
    name: str,
    created_at: str,
    description: str,
    config: Dict[str, Any],
    parent_codes: List[str],
    pool_chain: List[Dict[str, Any]],
    player_aliases: Dict[str, str],
    players: List[Dict[str, Any]],
    teams: List[Dict[str, Any]],
    fixtures: List[Dict[str, Any]],
    matches: List[Dict[str, Any]],
    exported_at: str,
) -> Dict[str, Any]:
    """Monta o documento de exportação. `pool_chain` lista as peladas anteriores (informativo)."""
    return {
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "exported_at": exported_at,
        "pelada": {
            "code": code,
            "name": name,
            "created_at": created_at,
            "description": description,
            "config": config,
        },
        "pool": {
            "parent_codes": parent_codes,
            "chain": pool_chain,
            "player_aliases": player_aliases,
        },
        "players": players,
        "teams": teams,
        "fixtures": fixtures,
        "matches": matches,
    }
