"""Formato do arquivo de exportação e importação de uma pelada (JSON).

Funções puras: não acessam banco, HTTP nem relógio. Quem chama passa os dados e a data da exportação.
A senha mestra nunca entra no documento: o hash seria um alvo para força bruta offline.
"""
from typing import Any, Dict, List, Optional

BACKUP_FORMAT = "futmatch-pelada"
BACKUP_VERSION = 1


def build_backup_document(
    *,
    code: str,
    name: str,
    created_at: str,
    description: str,
    config: Dict[str, Any],
    parent_code: Optional[str],
    pool_chain: List[Dict[str, Any]],
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
            "parent_code": parent_code,
            "chain": pool_chain,
        },
        "players": players,
        "teams": teams,
        "fixtures": fixtures,
        "matches": matches,
    }
