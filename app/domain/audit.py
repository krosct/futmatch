from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
from datetime import datetime, timezone, timedelta

BRT = timezone(timedelta(hours=-3))

class AuditEvent(BaseModel):
    id: Optional[int] = None
    timestamp: str = Field(default_factory=lambda: datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S"))
    created_at_ts: float = Field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    pelada_code: Optional[str] = None
    session_id: Optional[str] = None
    category: str = "action" # action, navigation, media, api, security
    action: str
    target: Optional[str] = None
    status: str = "success"
    duration_ms: float = 0.0
    client_ip: Optional[str] = None
    user_agent: Optional[str] = None
    metadata_json: Optional[str] = "{}"
