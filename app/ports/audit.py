from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any
from app.domain.audit import AuditEvent

class AuditRepositoryPort(ABC):
    @abstractmethod
    async def init_audit_db(self) -> None:
        pass

    @abstractmethod
    async def log_event(self, event: AuditEvent) -> None:
        pass

    @abstractmethod
    async def log_events_batch(self, events: List[AuditEvent]) -> None:
        pass

    @abstractmethod
    async def list_audit_logs(
        self,
        pelada_code: Optional[str] = None,
        category: Optional[str] = None,
        limit: int = 100,
        offset: int = 0
    ) -> List[AuditEvent]:
        pass

    @abstractmethod
    async def count_audit_logs(self, pelada_code: Optional[str] = None) -> int:
        pass

    @abstractmethod
    async def purge_older_than(self, created_at_ts: float) -> int:
        pass
