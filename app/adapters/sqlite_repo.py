import json
import re
import aiosqlite
from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timezone, timedelta
from app.domain.models import Match, SessionConfig, PeladaSession
from app.ports.repository import MatchRepositoryPort
from app.domain.player_identity import resolve_alias
from app.domain.pool_graph import pool_chain

BRT = timezone(timedelta(hours=-3))

# A chave é composta: o mesmo id pode existir em peladas diferentes sem uma sobrescrever a outra.
MATCHES_SCHEMA = """
    CREATE TABLE IF NOT EXISTS matches (
        pelada_code TEXT NOT NULL DEFAULT '',
        id TEXT NOT NULL,
        round_number INTEGER,
        home_team_id TEXT,
        home_team_name TEXT,
        away_team_id TEXT,
        away_team_name TEXT,
        home_score INTEGER,
        away_score INTEGER,
        home_players TEXT,
        away_players TEXT,
        events TEXT,
        winner_team_id TEXT,
        is_draw INTEGER,
        finished INTEGER,
        played_at TEXT,
        notes TEXT,
        PRIMARY KEY (pelada_code, id)
    )
"""
MATCH_COLUMNS = (
    "pelada_code", "id", "round_number", "home_team_id", "home_team_name", "away_team_id",
    "away_team_name", "home_score", "away_score", "home_players", "away_players", "events",
    "winner_team_id", "is_draw", "finished", "played_at", "notes",
)
MATCH_INSERT_SQL = """
    INSERT OR REPLACE INTO matches (
        id, round_number, home_team_id, home_team_name, away_team_id, away_team_name,
        home_score, away_score, home_players, away_players, events,
        winner_team_id, is_draw, finished, played_at, notes, pelada_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def _match_params(match: Match, pelada_code: str) -> Tuple[Any, ...]:
    """Valores de uma partida na ordem de MATCH_INSERT_SQL."""
    return (
        match.id,
        match.round_number,
        match.home_team_id,
        match.home_team_name,
        match.away_team_id,
        match.away_team_name,
        match.home_score,
        match.away_score,
        json.dumps(match.home_players, ensure_ascii=False),
        json.dumps(match.away_players, ensure_ascii=False),
        json.dumps(match.events, ensure_ascii=False),
        match.winner_team_id,
        1 if match.is_draw else 0,
        1 if match.finished else 0,
        match.played_at,
        match.notes,
        pelada_code.upper().strip(),
    )

class SQLiteMatchRepository(MatchRepositoryPort):
    def __init__(self, db_path: str = "futmatch.db"):
        self.db_path = db_path

    async def init_db(self) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS peladas (
                    code TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    name TEXT,
                    players TEXT DEFAULT '[]',
                    teams TEXT DEFAULT '[]',
                    fixtures TEXT DEFAULT '[]',
                    config TEXT DEFAULT '{}'
                )
            """)
            # Vínculos de pool (grafo: uma pelada pode ter várias peladas anteriores)
            await db.execute("""
                CREATE TABLE IF NOT EXISTS pelada_pool_links (
                    child_code TEXT NOT NULL,
                    parent_code TEXT NOT NULL,
                    PRIMARY KEY (child_code, parent_code)
                )
            """)
            # Migração: o antigo peladas.parent_code (um pai só) vira uma linha em pelada_pool_links
            cursor = await db.execute("PRAGMA table_info(peladas)")
            colunas = {linha[1] for linha in await cursor.fetchall()}
            if "parent_code" in colunas:
                await db.execute("""
                    INSERT OR IGNORE INTO pelada_pool_links (child_code, parent_code)
                    SELECT code, UPPER(TRIM(parent_code)) FROM peladas
                    WHERE parent_code IS NOT NULL AND TRIM(parent_code) <> ''
                """)
                await db.commit()  # fecha a transação do INSERT antes do DDL (e do BEGIN das migrações seguintes)
                await db.execute("ALTER TABLE peladas DROP COLUMN parent_code")
                await db.commit()
            # Migração caso a coluna description não exista
            try:
                await db.execute("ALTER TABLE peladas ADD COLUMN description TEXT DEFAULT ''")
            except Exception:
                pass

            await self._migrate_matches_table(db)

            # Cor branca saiu da paleta: times salvos com ela passam para magenta claro (idempotente)
            await db.execute(
                "UPDATE peladas SET teams = REPLACE(REPLACE(teams, '#e2e8f0', '#f0abfc'), '#E2E8F0', '#f0abfc') "
                "WHERE teams LIKE '%e2e8f0%' OR teams LIKE '%E2E8F0%'"
            )

            await db.execute("""
                CREATE TABLE IF NOT EXISTS configs (
                    key TEXT PRIMARY KEY,
                    val TEXT
                )
            """)

            await db.execute("""
                CREATE TABLE IF NOT EXISTS admin_tokens (
                    token TEXT PRIMARY KEY,
                    pelada_code TEXT NOT NULL,
                    expires_at REAL NOT NULL
                )
            """)
            await db.commit()

    async def _migrate_matches_table(self, db: aiosqlite.Connection) -> None:
        """Cria ou reconstrói `matches` com chave (pelada_code, id), preservando as linhas existentes."""
        cursor = await db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'matches'")
        row = await cursor.fetchone()
        if row is None:
            await db.execute(MATCHES_SCHEMA)
            return
        normalized_sql = re.sub(r"\s+", "", row[0] or "").lower()
        if "primarykey(pelada_code,id)" in normalized_sql:
            return

        cursor = await db.execute("PRAGMA table_info(matches)")
        existing = {r[1] for r in await cursor.fetchall()}
        source = ", ".join(
            ("COALESCE(pelada_code, '')" if c == "pelada_code" else c) if c in existing else ("''" if c == "pelada_code" else "NULL")
            for c in MATCH_COLUMNS
        )
        await db.execute("BEGIN")
        try:
            await db.execute("ALTER TABLE matches RENAME TO matches_legacy")
            await db.execute(MATCHES_SCHEMA)
            await db.execute(
                f"INSERT INTO matches ({', '.join(MATCH_COLUMNS)}) SELECT {source} FROM matches_legacy"
            )
            await db.execute("DROP TABLE matches_legacy")
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    async def create_pelada(self, code: str, password_hash: str, name: str) -> PeladaSession:
        created_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
        clean_name = name.strip()
        default_config = {
            "players_per_team": 5,
            "match_duration_minutes": 10,
            "total_rounds": 1,
            "championship_type": "single",
            "points_win": 3,
            "points_draw": 1
        }
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT INTO peladas (code, password_hash, created_at, name, players, teams, fixtures, config)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                code.upper(),
                password_hash,
                created_at,
                clean_name,
                "[]",
                "[]",
                "[]",
                json.dumps(default_config)
            ))
            await db.commit()

        return PeladaSession(
            code=code.upper(),
            password_hash=password_hash,
            created_at=created_at,
            name=clean_name,
            players=[],
            teams=[],
            fixtures=[],
            config=default_config,
            description=""
        )

    async def get_pelada(self, code: str) -> Optional[PeladaSession]:
        if not code:
            return None
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM peladas WHERE code = ?", (code.upper(),))
            row = await cursor.fetchone()
            if not row:
                return None
            return PeladaSession(
                code=row["code"],
                password_hash=row["password_hash"],
                created_at=row["created_at"],
                name=row["name"] or "",
                players=json.loads(row["players"]) if row["players"] else [],
                teams=json.loads(row["teams"]) if row["teams"] else [],
                fixtures=json.loads(row["fixtures"]) if row["fixtures"] else [],
                config=json.loads(row["config"]) if row["config"] else {},
                description=row["description"] if "description" in row.keys() and row["description"] else ""
            )

    async def set_pelada_description(self, code: str, description: str) -> bool:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "UPDATE peladas SET description = ? WHERE code = ?",
                (description, code.upper())
            )
            await db.commit()
            return cursor.rowcount > 0

    async def set_pelada_parent_codes(self, code: str, parent_codes: List[str]) -> None:
        # Substitui todos os pais da pelada de forma atômica (ou grava tudo, ou nada)
        filha = code.upper().strip()
        pais = list(dict.fromkeys(p.upper().strip() for p in parent_codes if p and p.strip()))
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM pelada_pool_links WHERE child_code = ?", (filha,))
            await db.executemany(
                "INSERT INTO pelada_pool_links (child_code, parent_code) VALUES (?, ?)",
                [(filha, pai) for pai in pais if pai != filha]
            )
            await db.commit()

    async def get_pelada_parent_codes(self, code: str) -> List[str]:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "SELECT parent_code FROM pelada_pool_links WHERE child_code = ? ORDER BY rowid",
                (code.upper().strip(),)
            )
            return [linha[0] for linha in await cursor.fetchall()]

    async def get_pelada_chain_codes(self, code: str) -> List[str]:
        """Percorre a corrente de peladas (pool) a partir do código atual, evitando ciclos."""
        if not code:
            return []
        # Carrega todos os vínculos de uma vez; o percurso do grafo deduplica nós e tolera ciclos
        parents: Dict[str, List[str]] = {}
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT child_code, parent_code FROM pelada_pool_links ORDER BY rowid")
            for filha, pai in await cursor.fetchall():
                parents.setdefault(filha, []).append(pai)
        return pool_chain(code.upper().strip(), parents)

    async def update_pelada_password(self, code: str, password_hash: str) -> bool:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "UPDATE peladas SET password_hash = ? WHERE code = ?",
                (password_hash, code.upper())
            )
            await db.commit()
            return cursor.rowcount > 0

    async def save_pelada_state(self, code: str, players: List[Dict[str, Any]], teams: List[Dict[str, Any]], fixtures: List[Dict[str, Any]]) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                UPDATE peladas
                SET players = ?, teams = ?, fixtures = ?
                WHERE code = ?
            """, (
                json.dumps(players, ensure_ascii=False),
                json.dumps(teams, ensure_ascii=False),
                json.dumps(fixtures, ensure_ascii=False),
                code.upper()
            ))
            await db.commit()

    async def save_match(self, match: Match, pelada_code: str) -> None:
        if not match.played_at:
            match.played_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")

        async with aiosqlite.connect(self.db_path) as db:
            # Substitui apenas a partida desta pelada (chave composta pelada_code + id)
            await db.execute(MATCH_INSERT_SQL, _match_params(match, pelada_code))
            await db.commit()

    async def overwrite_pelada(self, pelada: PeladaSession, config: SessionConfig, matches: List[Match]) -> None:
        code = pelada.code.upper().strip()
        async with aiosqlite.connect(self.db_path) as db:
            # Tudo na mesma conexão: se qualquer passo falhar, nada é gravado (o commit só vem no fim).
            # password_hash não entra no UPDATE: a senha mestra da pelada continua a mesma.
            await db.execute("""
                UPDATE peladas
                SET name = ?, created_at = ?, players = ?, teams = ?, fixtures = ?,
                    config = ?, description = ?
                WHERE code = ?
            """, (
                pelada.name,
                pelada.created_at,
                json.dumps(pelada.players, ensure_ascii=False),
                json.dumps(pelada.teams, ensure_ascii=False),
                json.dumps(pelada.fixtures, ensure_ascii=False),
                json.dumps(config.__dict__),
                pelada.description,
                code,
            ))
            await db.execute(
                "INSERT OR REPLACE INTO configs (key, val) VALUES (?, ?)",
                (f"session_config_{code}", json.dumps(config.__dict__))
            )
            await db.execute("DELETE FROM matches WHERE pelada_code = ?", (code,))
            for match in matches:
                if not match.played_at:
                    match.played_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
                await db.execute(MATCH_INSERT_SQL, _match_params(match, code))
            await db.commit()

    async def list_pelada_matches(self, pelada_code: str) -> List[Match]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM matches WHERE pelada_code = ? ORDER BY rowid ASC",
                (pelada_code.upper().strip(),)
            )
            rows = await cursor.fetchall()
            return [self._row_to_match(r) for r in rows]

    async def get_match(self, match_id: str, pelada_code: str) -> Optional[Match]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM matches WHERE id = ? AND pelada_code = ?", (match_id, pelada_code.upper().strip())
            )
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_match(row)

    async def list_matches(self, pelada_code: str, limit: int = 100) -> List[Match]:
        # Histórico = união das tabelas de jogos (fixtures) das peladas da corrente (pool).
        # Uma partida só conta se ainda estiver na tabela da sua pelada: apagar do jogo remove do histórico.
        codes = await self.get_pelada_chain_codes(pelada_code)
        if not codes:
            return []
        table_ids: Dict[str, set] = {}
        for code in codes:
            pelada = await self.get_pelada(code)
            table_ids[code] = {str(f.get("id")) for f in (pelada.fixtures if pelada else []) if f.get("id") is not None}
        placeholders = ",".join("?" for _ in codes)
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                f"SELECT * FROM matches WHERE pelada_code IN ({placeholders}) ORDER BY rowid DESC",
                tuple(codes)
            )
            rows = await cursor.fetchall()
        visible = [r for r in rows if str(r["id"]) in table_ids.get(r["pelada_code"], set())]
        return [self._row_to_match(r) for r in visible[:limit]]

    async def delete_all_matches(self, pelada_code: str) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM matches WHERE pelada_code = ?", (pelada_code.upper().strip(),))
            await db.commit()

    async def delete_match(self, match_id: str, pelada_code: str) -> bool:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "DELETE FROM matches WHERE id = ? AND pelada_code = ?", (match_id, pelada_code.upper().strip())
            )
            await db.commit()
            return cursor.rowcount > 0

    async def save_config(self, config: SessionConfig, pelada_code: str) -> None:
        key = f"session_config_{pelada_code.upper().strip()}"
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT OR REPLACE INTO configs (key, val) VALUES (?, ?)",
                (key, json.dumps(config.__dict__))
            )
            await db.commit()

    async def get_config(self, pelada_code: str) -> SessionConfig:
        key = f"session_config_{pelada_code.upper().strip()}"
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT val FROM configs WHERE key = ?", (key,))
            row = await cursor.fetchone()
            if row and row[0]:
                data = json.loads(row[0])
                valid_fields = SessionConfig.__dataclass_fields__.keys()
                filtered = {k: v for k, v in data.items() if k in valid_fields}
                if "championship_type" not in filtered:
                    filtered["championship_type"] = "double" if filtered.get("total_rounds") == 2 else "single"
                return SessionConfig(**filtered)
            return SessionConfig()

    async def get_player_aliases(self, pelada_code: str) -> Dict[str, str]:
        """Aliases gravados por esta pelada: id do jogador nela -> id do mesmo jogador na pool."""
        key = f"player_aliases_{pelada_code.upper().strip()}"
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT val FROM configs WHERE key = ?", (key,))
            row = await cursor.fetchone()
        if row and row[0]:
            return {str(k): str(v) for k, v in json.loads(row[0]).items()}
        return {}

    async def set_player_aliases(self, pelada_code: str, aliases: Dict[str, str]) -> None:
        key = f"player_aliases_{pelada_code.upper().strip()}"
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT OR REPLACE INTO configs (key, val) VALUES (?, ?)",
                (key, json.dumps(aliases, ensure_ascii=False))
            )
            await db.commit()

    async def get_chain_player_aliases(self, pelada_code: str) -> Dict[str, str]:
        """Aliases de todas as peladas da corrente (ids são únicos, então podem ser unidos)."""
        merged: Dict[str, str] = {}
        for code in await self.get_pelada_chain_codes(pelada_code):
            merged.update(await self.get_player_aliases(code))
        return merged

    async def get_players_stats(self, pelada_code: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        """Calcula métricas detalhadas de cada jogador a partir das partidas finalizadas da pelada e do pool."""
        matches = await self.list_matches(limit=1000, pelada_code=pelada_code)
        finished_matches = [m for m in matches if m.finished]
        aliases = await self.get_chain_player_aliases(pelada_code) if pelada_code else {}

        player_stats: Dict[str, Dict[str, Any]] = {}

        def init_player(pid: str, name: str):
            if pid not in player_stats:
                player_stats[pid] = {
                    "id": pid,
                    "name": name,
                    "matches": 0,
                    "wins": 0,
                    "draws": 0,
                    "losses": 0,
                    "goals": 0,
                    "win_rate": 0.0
                }

        for m in finished_matches:
            for p in m.home_players:
                pid, pname = resolve_alias(str(p.get("id")), aliases), p.get("name", "Jogador")
                init_player(pid, pname)
                player_stats[pid]["matches"] += 1
                if m.is_draw:
                    player_stats[pid]["draws"] += 1
                elif m.winner_team_id == m.home_team_id:
                    player_stats[pid]["wins"] += 1
                else:
                    player_stats[pid]["losses"] += 1

            for p in m.away_players:
                pid, pname = resolve_alias(str(p.get("id")), aliases), p.get("name", "Jogador")
                init_player(pid, pname)
                player_stats[pid]["matches"] += 1
                if m.is_draw:
                    player_stats[pid]["draws"] += 1
                elif m.winner_team_id == m.away_team_id:
                    player_stats[pid]["wins"] += 1
                else:
                    player_stats[pid]["losses"] += 1

            for ev in m.events:
                ev_pid = resolve_alias(str(ev.get("player_id")), aliases) if ev.get("player_id") is not None else None
                ev_pname = ev.get("player_name", "Desconhecido")
                if ev_pid:
                    init_player(ev_pid, ev_pname)
                    if ev.get("event_type") == "goal":
                        player_stats[ev_pid]["goals"] += 1

        lookup: Dict[str, Dict[str, Any]] = {}
        for pid, p in player_stats.items():
            if p["matches"] > 0:
                p["win_rate"] = round((p["wins"] / p["matches"]) * 100, 1)
            lookup[pid] = p
            if p.get("name"):
                lookup[p["name"].strip().lower()] = p

        return lookup

    async def get_dashboard_metrics(self, pelada_code: Optional[str] = None) -> Dict[str, Any]:
        """Calcula métricas agregadas por jogador, times, média de gols e estatísticas gerais da pelada."""
        matches = await self.list_matches(limit=1000, pelada_code=pelada_code)
        finished_matches = [m for m in matches if m.finished]

        total_matches = len(finished_matches)
        total_goals = sum(m.home_score + m.away_score for m in finished_matches)
        avg_goals_per_match = round(total_goals / total_matches, 2) if total_matches > 0 else 0.0

        players_lookup = await self.get_players_stats(pelada_code=pelada_code)
        # Extrai registros únicos por id
        unique_players = {v["id"]: v for k, v in players_lookup.items() if k == v["id"]}
        players_list = list(unique_players.values())
        top_scorers = sorted(players_list, key=lambda x: (x["goals"], x["wins"]), reverse=True)[:10]
        top_winners = sorted(players_list, key=lambda x: (x["wins"], x["win_rate"]), reverse=True)[:10]

        team_stats: Dict[str, Dict[str, Any]] = {}
        def init_team(tid: str, tname: str):
            if tid not in team_stats:
                team_stats[tid] = {
                    "team_id": tid,
                    "name": tname,
                    "matches": 0,
                    "wins": 0,
                    "draws": 0,
                    "losses": 0,
                    "goals_scored": 0,
                    "goals_conceded": 0,
                    "points": 0
                }

        for m in finished_matches:
            init_team(m.home_team_id, m.home_team_name)
            init_team(m.away_team_id, m.away_team_name)

            ht = team_stats[m.home_team_id]
            at = team_stats[m.away_team_id]

            ht["matches"] += 1
            at["matches"] += 1
            ht["goals_scored"] += m.home_score
            ht["goals_conceded"] += m.away_score
            at["goals_scored"] += m.away_score
            at["goals_conceded"] += m.home_score

            if m.is_draw:
                ht["draws"] += 1
                at["draws"] += 1
                ht["points"] += 1
                at["points"] += 1
            elif m.winner_team_id == m.home_team_id:
                ht["wins"] += 1
                at["losses"] += 1
                ht["points"] += 3
            else:
                at["wins"] += 1
                ht["losses"] += 1
                at["points"] += 3

        leaderboard = sorted(
            team_stats.values(),
            key=lambda t: (t["points"], t["wins"], (t["goals_scored"] - t["goals_conceded"]), t["goals_scored"]),
            reverse=True
        )

        chain_codes = await self.get_pelada_chain_codes(pelada_code) if pelada_code else []

        return {
            "summary": {
                "total_matches": total_matches,
                "total_goals": total_goals,
                "avg_goals_per_match": avg_goals_per_match,
                "total_players": len(unique_players),
                "total_teams": len(team_stats),
                "pool_count": len(chain_codes),
                "pool_codes": chain_codes
            },
            "top_scorers": top_scorers,
            "top_winners": top_winners,
            "leaderboard": leaderboard,
            "recent_matches": [self._match_to_dict(m) for m in finished_matches[:8]],
            "all_matches": [self._match_to_dict(m) for m in finished_matches]
        }


    def _row_to_match(self, row: Any) -> Match:
        return Match(
            id=row["id"],
            round_number=row["round_number"],
            home_team_id=row["home_team_id"],
            home_team_name=row["home_team_name"],
            away_team_id=row["away_team_id"],
            away_team_name=row["away_team_name"],
            home_score=row["home_score"],
            away_score=row["away_score"],
            home_players=json.loads(row["home_players"]) if row["home_players"] else [],
            away_players=json.loads(row["away_players"]) if row["away_players"] else [],
            events=json.loads(row["events"]) if row["events"] else [],
            winner_team_id=row["winner_team_id"],
            is_draw=bool(row["is_draw"]),
            finished=bool(row["finished"]),
            played_at=row["played_at"],
            notes=row["notes"] or ""
        )

    def _match_to_dict(self, m: Match) -> Dict[str, Any]:
        return {
            "id": m.id,
            "round_number": m.round_number,
            "home_team_id": m.home_team_id,
            "home_team_name": m.home_team_name,
            "away_team_id": m.away_team_id,
            "away_team_name": m.away_team_name,
            "home_score": m.home_score,
            "away_score": m.away_score,
            "home_players": m.home_players,
            "away_players": m.away_players,
            "events": m.events,
            "winner_team_id": m.winner_team_id,
            "is_draw": m.is_draw,
            "finished": m.finished,
            "played_at": m.played_at,
            "notes": m.notes,
            "started_at": m.started_at,
            "timer_status": m.timer_status,
            "timer_elapsed_seconds": m.timer_elapsed_seconds,
            "timer_updated_at": m.timer_updated_at
        }

    async def save_admin_token(self, token: str, pelada_code: str, expires_at: float) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO admin_tokens (token, pelada_code, expires_at)
                VALUES (?, ?, ?)
            """, (token, pelada_code.upper().strip(), expires_at))
            await db.commit()

    async def get_admin_token(self, token: str) -> Optional[Tuple[str, float]]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT pelada_code, expires_at FROM admin_tokens WHERE token = ?", (token,))
            row = await cursor.fetchone()
            if not row:
                return None
            return (row["pelada_code"], float(row["expires_at"]))

    async def delete_admin_token(self, token: str) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM admin_tokens WHERE token = ?", (token,))
            await db.commit()

    async def delete_admin_tokens_for_pelada(self, pelada_code: str) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("DELETE FROM admin_tokens WHERE pelada_code = ?", (pelada_code.upper().strip(),))
            await db.commit()

    async def load_all_admin_tokens(self) -> Dict[str, Tuple[str, float]]:
        import time
        now = time.time()
        tokens: Dict[str, Tuple[str, float]] = {}
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            # Limpa expirados
            await db.execute("DELETE FROM admin_tokens WHERE expires_at < ?", (now,))
            await db.commit()
            cursor = await db.execute("SELECT token, pelada_code, expires_at FROM admin_tokens")
            rows = await cursor.fetchall()
            for r in rows:
                tokens[r["token"]] = (r["pelada_code"], float(r["expires_at"]))
        return tokens
