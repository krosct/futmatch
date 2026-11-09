import aiosqlite
import json
from typing import List, Optional
from app.domain.audit import AuditEvent
from app.ports.audit import AuditRepositoryPort

class SQLiteAuditRepository(AuditRepositoryPort):
    def __init__(self, db_path: str = "futmatch.db"):
        self.db_path = db_path

    async def init_audit_db(self) -> None:
        async with aiosqlite.connect(self.db_path) as db:
            await db.execute("""
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    created_at_ts REAL NOT NULL,
                    pelada_code TEXT,
                    session_id TEXT,
                    category TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target TEXT,
                    status TEXT DEFAULT 'success',
                    duration_ms REAL DEFAULT 0,
                    client_ip TEXT,
                    user_agent TEXT,
                    metadata_json TEXT
                )
            """)
            await db.execute("CREATE INDEX IF NOT EXISTS idx_audit_pelada ON audit_logs(pelada_code)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at_ts)")
            await db.commit()

    async def log_event(self, event: AuditEvent) -> None:
        await self.log_events_batch([event])

    async def log_events_batch(self, events: List[AuditEvent]) -> None:
        if not events:
            return
        async with aiosqlite.connect(self.db_path) as db:
            rows = [
                (
                    e.timestamp,
                    e.created_at_ts,
                    e.pelada_code,
                    e.session_id,
                    e.category,
                    e.action,
                    e.target,
                    e.status,
                    e.duration_ms,
                    e.client_ip,
                    e.user_agent,
                    e.metadata_json if isinstance(e.metadata_json, str) else json.dumps(e.metadata_json or {})
                )
                for e in events
            ]
            await db.executemany("""
                INSERT INTO audit_logs (
                    timestamp, created_at_ts, pelada_code, session_id,
                    category, action, target, status, duration_ms,
                    client_ip, user_agent, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, rows)
            await db.commit()

    async def list_audit_logs(
        self,
        pelada_code: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[AuditEvent]:
        query = "SELECT id, timestamp, created_at_ts, pelada_code, session_id, category, action, target, status, duration_ms, client_ip, user_agent, metadata_json FROM audit_logs"
        conditions = []
        params = []

        if pelada_code:
            conditions.append("pelada_code = ?")
            params.append(pelada_code.upper().strip())
        if category:
            conditions.append("category = ?")
            params.append(category)

        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        query += " ORDER BY id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()
                results = []
                for row in rows:
                    results.append(AuditEvent(
                        id=row[0],
                        timestamp=row[1],
                        created_at_ts=row[2],
                        pelada_code=row[3],
                        session_id=row[4],
                        category=row[5],
                        action=row[6],
                        target=row[7],
                        status=row[8],
                        duration_ms=row[9],
                        client_ip=row[10],
                        user_agent=row[11],
                        metadata_json=row[12]
                    ))
                return results

    async def purge_older_than(self, created_at_ts: float) -> int:
        """Remove eventos anteriores ao timestamp informado e retorna quantos foram apagados."""
        async with aiosqlite.connect(self.db_path) as db:
            cursor = await db.execute("DELETE FROM audit_logs WHERE created_at_ts < ?", (created_at_ts,))
            await db.commit()
            return cursor.rowcount

    async def count_audit_logs(self, pelada_code: Optional[str] = None) -> int:
        query = "SELECT COUNT(*) FROM audit_logs"
        params = []
        if pelada_code:
            query += " WHERE pelada_code = ?"
            params.append(pelada_code.upper().strip())
        async with aiosqlite.connect(self.db_path) as db:
            async with db.execute(query, params) as cursor:
                row = await cursor.fetchone()
                return row[0] if row else 0
