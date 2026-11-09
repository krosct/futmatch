"""Leitura dos logs de auditoria para o desenvolvedor, direto no banco do servidor.

Não existe rota HTTP para isto: quem lê precisa de acesso ao servidor (shell/SSH) e ao arquivo do banco.
O banco é aberto em modo somente leitura (SQLite URI mode=ro), então o CLI não altera nada.

Exemplos (no servidor, com o venv do projeto):
    DATA_DIR=/srv/futmatch/data .venv/bin/python -m app.cli.audit_logs --limite 50
    .venv/bin/python -m app.cli.audit_logs --db ./futmatch.db --pelada ABCDE --categoria security
    .venv/bin/python -m app.cli.audit_logs --horas 24 --json
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from typing import Any, Dict, List, Optional

from app.domain.audit import normalize_pelada_code

CATEGORIES = ("action", "navigation", "media", "api", "security")
COLUMNS = (
    "id", "timestamp", "pelada_code", "category", "action", "target", "status",
    "duration_ms", "client_ip", "user_agent", "session_id", "metadata_json",
)


def query_logs(
    db_path: str,
    limit: int = 50,
    pelada_code: Optional[str] = None,
    category: Optional[str] = None,
    since_hours: Optional[float] = None,
) -> List[Dict[str, Any]]:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Banco não encontrado: {db_path}")

    conditions: List[str] = []
    params: List[Any] = []
    if pelada_code:
        conditions.append("pelada_code = ?")
        params.append(pelada_code)
    if category:
        conditions.append("category = ?")
        params.append(category)
    if since_hours is not None:
        conditions.append("created_at_ts >= ?")
        params.append(time.time() - since_hours * 3600)

    query = f"SELECT {', '.join(COLUMNS)} FROM audit_logs"
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    # mode=ro: o CLI nunca escreve no banco de produção
    uri = f"file:{os.path.abspath(db_path)}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        connection.row_factory = sqlite3.Row
        rows = connection.execute(query, params).fetchall()
    finally:
        connection.close()
    return [dict(row) for row in rows]


def _format_table(rows: List[Dict[str, Any]]) -> str:
    if not rows:
        return "Nenhum registro encontrado."
    headers = ("id", "data/hora (BRT)", "pelada", "categoria", "ação", "status", "IP", "sessão")
    lines = [" | ".join(headers)]
    for r in rows:
        lines.append(" | ".join(str(v if v is not None else "-") for v in (
            r["id"], r["timestamp"], r["pelada_code"], r["category"], r["action"],
            r["status"], r["client_ip"], r["session_id"],
        )))
    return "\n".join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Consulta os logs de auditoria do FutMatch (somente leitura).")
    default_db = os.path.join(os.getenv("DATA_DIR", "."), "futmatch.db")
    parser.add_argument("--db", default=default_db, help=f"Caminho do banco (padrão: {default_db})")
    parser.add_argument("--limite", type=int, default=50, help="Quantidade máxima de registros (1 a 1000)")
    parser.add_argument("--pelada", help="Filtra por código da pelada")
    parser.add_argument("--categoria", choices=CATEGORIES, help="Filtra por categoria")
    parser.add_argument("--horas", type=float, help="Somente eventos das últimas N horas")
    parser.add_argument("--json", action="store_true", help="Saída em JSON")
    args = parser.parse_args(argv)

    pelada = None
    if args.pelada:
        pelada = normalize_pelada_code(args.pelada)
        if pelada is None:
            print("Código de pelada inválido (esperado 5 caracteres alfanuméricos).", file=sys.stderr)
            return 2

    try:
        rows = query_logs(
            args.db,
            limit=min(max(1, args.limite), 1000),
            pelada_code=pelada,
            category=args.categoria,
            since_hours=args.horas,
        )
    except (FileNotFoundError, sqlite3.Error) as exc:
        print(f"Erro ao ler o banco: {exc}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print(_format_table(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
