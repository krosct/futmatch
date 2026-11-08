import json
import aiosqlite
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
from app.domain.models import Match, SessionConfig, PeladaSession
from app.ports.repository import MatchRepositoryPort

BRT = timezone(timedelta(hours=-3))

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
                    config TEXT DEFAULT '{}',
                    parent_code TEXT DEFAULT NULL
                )
            """)
            # Migração caso a coluna parent_code não exista
            try:
                await db.execute("ALTER TABLE peladas ADD COLUMN parent_code TEXT DEFAULT NULL")
            except Exception:
                pass

            await db.execute("""
                CREATE TABLE IF NOT EXISTS matches (
                    id TEXT PRIMARY KEY,
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
                    pelada_code TEXT DEFAULT ''
                )
            """)
            # Migração caso a coluna pelada_code não exista
            try:
                await db.execute("ALTER TABLE matches ADD COLUMN pelada_code TEXT DEFAULT ''")
            except Exception:
                pass

            await db.execute("""
                CREATE TABLE IF NOT EXISTS configs (
                    key TEXT PRIMARY KEY,
                    val TEXT
                )
            """)
            await db.commit()

    async def create_pelada(self, code: str, password_hash: str, name: str = "Pelada dos Amigos") -> PeladaSession:
        created_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
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
                INSERT OR REPLACE INTO peladas (code, password_hash, created_at, name, players, teams, fixtures, config, parent_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """, (
                code.upper(),
                password_hash,
                created_at,
                name,
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
            name=name,
            players=[],
            teams=[],
            fixtures=[],
            config=default_config,
            parent_code=None
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
                name=row["name"] or "Pelada dos Amigos",
                players=json.loads(row["players"]) if row["players"] else [],
                teams=json.loads(row["teams"]) if row["teams"] else [],
                fixtures=json.loads(row["fixtures"]) if row["fixtures"] else [],
                config=json.loads(row["config"]) if row["config"] else {},
                parent_code=row["parent_code"] if "parent_code" in row.keys() and row["parent_code"] else None
            )

    async def set_pelada_parent_code(self, code: str, parent_code: Optional[str]) -> bool:
        p_code = parent_code.upper().strip() if parent_code else None
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "UPDATE peladas SET parent_code = ? WHERE code = ?",
                (p_code, code.upper())
            )
            await db.commit()
            return cursor.rowcount > 0

    async def get_pelada_chain_codes(self, code: str) -> List[str]:
        """Percorre a corrente de peladas (pool) a partir do código atual, evitando ciclos."""
        chain = []
        current = code.upper().strip() if code else None
        visited = set()

        while current and current not in visited:
            visited.add(current)
            chain.append(current)
            pelada = await self.get_pelada(current)
            if not pelada or not pelada.parent_code:
                break
            current = pelada.parent_code.upper().strip()

        return chain

    async def update_pelada_password(self, code: str, password_hash: str) -> bool:
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute(
                "UPDATE peladas SET password_hash = ? WHERE code = ?",
                (password_hash, code.upper())
            )
            await db.commit()
            return cursor.rowcount > 0

    async def save_pelada_state(self, code: str, players: List[Dict[str, Any]], teams: List[Dict[str, Any]], fixtures: List[Dict[str, Any]], config: Dict[str, Any]) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                UPDATE peladas
                SET players = ?, teams = ?, fixtures = ?, config = ?
                WHERE code = ?
            """, (
                json.dumps(players, ensure_ascii=False),
                json.dumps(teams, ensure_ascii=False),
                json.dumps(fixtures, ensure_ascii=False),
                json.dumps(config, ensure_ascii=False),
                code.upper()
            ))
            await db.commit()

    async def save_match(self, match: Match, pelada_code: Optional[str] = None) -> None:
        if not match.played_at:
            match.played_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")

        p_code = (pelada_code or "").upper()
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                INSERT OR REPLACE INTO matches (
                    id, round_number, home_team_id, home_team_name, away_team_id, away_team_name,
                    home_score, away_score, home_players, away_players, events,
                    winner_team_id, is_draw, finished, played_at, notes, pelada_code
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
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
                p_code
            ))
            await db.commit()

    async def get_match(self, match_id: str, pelada_code: Optional[str] = None) -> Optional[Match]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if pelada_code:
                cursor = await db.execute("SELECT * FROM matches WHERE id = ? AND pelada_code = ?", (match_id, pelada_code.upper()))
            else:
                cursor = await db.execute("SELECT * FROM matches WHERE id = ?", (match_id,))
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_match(row)

    async def list_matches(self, limit: int = 100, pelada_code: Optional[str] = None) -> List[Match]:
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            if pelada_code:
                # Busca as partidas de todas as peladas na corrente (pool)
                codes = await self.get_pelada_chain_codes(pelada_code)
                placeholders = ",".join("?" for _ in codes)
                cursor = await db.execute(
                    f"SELECT * FROM matches WHERE pelada_code IN ({placeholders}) ORDER BY rowid DESC LIMIT ?",
                    (*codes, limit)
                )
            else:
                cursor = await db.execute("SELECT * FROM matches ORDER BY rowid DESC LIMIT ?", (limit,))
            rows = await cursor.fetchall()
            return [self._row_to_match(r) for r in rows]

    async def delete_all_matches(self, pelada_code: Optional[str] = None) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            if pelada_code:
                await db.execute("DELETE FROM matches WHERE pelada_code = ?", (pelada_code.upper(),))
            else:
                await db.execute("DELETE FROM matches")
            await db.commit()

    async def delete_match(self, match_id: str, pelada_code: Optional[str] = None) -> bool:
        async with aiosqlite.connect(self.db_path) as db:
            if pelada_code:
                cursor = await db.execute("DELETE FROM matches WHERE id = ? AND pelada_code = ?", (match_id, pelada_code.upper()))
            else:
                cursor = await db.execute("DELETE FROM matches WHERE id = ?", (match_id,))
            await db.commit()
            return cursor.rowcount > 0

    async def save_config(self, config: SessionConfig, pelada_code: Optional[str] = None) -> None:
        key = f"session_config_{pelada_code.upper()}" if pelada_code else "session_config"
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute(
                "INSERT OR REPLACE INTO configs (key, val) VALUES (?, ?)",
                (key, json.dumps(config.__dict__))
            )
            await db.commit()

    async def get_config(self, pelada_code: Optional[str] = None) -> SessionConfig:
        key = f"session_config_{pelada_code.upper()}" if pelada_code else "session_config"
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("SELECT val FROM configs WHERE key = ?", (key,))
            row = await cursor.fetchone()
            if not row and pelada_code:
                cursor = await db.execute("SELECT val FROM configs WHERE key = 'session_config'")
                row = await cursor.fetchone()
            if row and row[0]:
                data = json.loads(row[0])
                valid_fields = SessionConfig.__dataclass_fields__.keys()
                filtered = {k: v for k, v in data.items() if k in valid_fields}
                if "championship_type" not in filtered:
                    filtered["championship_type"] = "double" if filtered.get("total_rounds") == 2 else "single"
                return SessionConfig(**filtered)
            return SessionConfig()

    async def get_dashboard_metrics(self, pelada_code: Optional[str] = None) -> Dict[str, Any]:
        """Calcula métricas agregadas por jogador, times, média de gols e estatísticas gerais da pelada."""
        matches = await self.list_matches(limit=1000, pelada_code=pelada_code)
        finished_matches = [m for m in matches if m.finished]

        total_matches = len(finished_matches)
        total_goals = sum(m.home_score + m.away_score for m in finished_matches)
        avg_goals_per_match = round(total_goals / total_matches, 2) if total_matches > 0 else 0.0

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
                pid, pname = p["id"], p["name"]
                init_player(pid, pname)
                player_stats[pid]["matches"] += 1
                if m.is_draw:
                    player_stats[pid]["draws"] += 1
                elif m.winner_team_id == m.home_team_id:
                    player_stats[pid]["wins"] += 1
                else:
                    player_stats[pid]["losses"] += 1

            for p in m.away_players:
                pid, pname = p["id"], p["name"]
                init_player(pid, pname)
                player_stats[pid]["matches"] += 1
                if m.is_draw:
                    player_stats[pid]["draws"] += 1
                elif m.winner_team_id == m.away_team_id:
                    player_stats[pid]["wins"] += 1
                else:
                    player_stats[pid]["losses"] += 1

            for ev in m.events:
                ev_pid = ev.get("player_id")
                ev_pname = ev.get("player_name", "Desconhecido")
                if ev_pid:
                    init_player(ev_pid, ev_pname)
                    if ev.get("event_type") == "goal":
                        player_stats[ev_pid]["goals"] += 1

        for p in player_stats.values():
            if p["matches"] > 0:
                p["win_rate"] = round((p["wins"] / p["matches"]) * 100, 1)

        players_list = list(player_stats.values())
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
                "total_players": len(player_stats),
                "total_teams": len(team_stats),
                "pool_count": len(chain_codes),
                "pool_codes": chain_codes
            },
            "top_scorers": top_scorers,
            "top_winners": top_winners,
            "leaderboard": leaderboard,
            "recent_matches": [self._match_to_dict(m) for m in finished_matches[:8]]
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
            "notes": m.notes
        }
