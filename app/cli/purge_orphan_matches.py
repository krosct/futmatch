"""Remove partidas órfãs (gravadas antes do escopo por pelada, com pelada_code vazio).

Essas linhas não são mais acessíveis pela API. Por padrão o comando só mostra a contagem e
exporta um backup JSON. A remoção exige --confirmar.

Exemplos (no servidor):
    .venv/bin/python -m app.cli.purge_orphan_matches --db ./futmatch.db --backup ./orfas.json
    .venv/bin/python -m app.cli.purge_orphan_matches --db ./futmatch.db --backup ./orfas.json --confirmar
"""
import argparse
import json
import os
import sqlite3
import sys
from typing import List, Optional


def _orphans(conn: sqlite3.Connection) -> List[dict]:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute("SELECT * FROM matches WHERE pelada_code = ''").fetchall()]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Remove partidas órfãs com backup prévio.")
    parser.add_argument("--db", default=os.path.join(os.getenv("DATA_DIR", "."), "futmatch.db"))
    parser.add_argument("--backup", required=True, help="Arquivo JSON onde os registros serão salvos antes da remoção")
    parser.add_argument("--confirmar", action="store_true", help="Apaga de fato (sem essa flag, só simula)")
    args = parser.parse_args(argv)

    if not os.path.exists(args.db):
        print(f"Banco não encontrado: {args.db}", file=sys.stderr)
        return 1
    if os.path.exists(args.backup):
        print("O arquivo de backup já existe; escolha outro caminho.", file=sys.stderr)
        return 2

    conn = sqlite3.connect(args.db)
    try:
        rows = _orphans(conn)
        print(f"Partidas órfãs encontradas: {len(rows)}")
        with open(args.backup, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=2)
        os.chmod(args.backup, 0o600)
        print(f"Backup gravado em {args.backup}")
        if not args.confirmar:
            print("Simulação: nada foi apagado. Repita com --confirmar para remover.")
            return 0
        conn.execute("DELETE FROM matches WHERE pelada_code = ''")
        conn.commit()
        print("Partidas órfãs removidas.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
