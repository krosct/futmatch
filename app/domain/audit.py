import json
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

BRT = timezone(timedelta(hours=-3))

ALLOWED_CATEGORIES = {"action", "navigation", "media", "api", "security"}
ALLOWED_STATUS = {"success", "error"}
MAX_METADATA_BYTES = 2048
MAX_EVENT_AGE_SECONDS = 24 * 3600
SENSITIVE_KEY_PARTS = ("password", "senha", "token", "secret", "cookie", "authorization")

_CODE_RE = re.compile(r"^[A-Z0-9]{5}$")
_SESSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


class AuditEvent(BaseModel):
    id: Optional[int] = None
    timestamp: str = Field(default_factory=lambda: datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S"))
    created_at_ts: float = Field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    pelada_code: Optional[str] = None
    session_id: Optional[str] = None
    category: str = "action"  # action, navigation, media, api, security
    action: str
    target: Optional[str] = None
    status: str = "success"
    duration_ms: float = 0.0
    client_ip: Optional[str] = None
    user_agent: Optional[str] = None
    metadata_json: Optional[str] = "{}"


def normalize_pelada_code(value: Any) -> Optional[str]:
    """Aceita apenas códigos de pelada válidos (5 caracteres alfanuméricos maiúsculos)."""
    if not isinstance(value, str):
        return None
    code = value.strip().upper()
    return code if _CODE_RE.match(code) else None


def _strip_sensitive(value: Any, depth: int = 0) -> Any:
    """Remove recursivamente chaves que possam carregar segredos."""
    if depth > 5:
        return None
    if isinstance(value, dict):
        clean: Dict[str, Any] = {}
        for key, val in value.items():
            key_str = str(key)
            if any(part in key_str.lower() for part in SENSITIVE_KEY_PARTS):
                continue
            clean[key_str[:64]] = _strip_sensitive(val, depth + 1)
        return clean
    if isinstance(value, list):
        return [_strip_sensitive(v, depth + 1) for v in value[:50]]
    if isinstance(value, str):
        return value[:200]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:200]


def sanitize_metadata(raw: Any) -> str:
    """Converte metadados enviados pelo cliente em JSON seguro e limitado em tamanho."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return "{}"
    if not isinstance(raw, dict):
        return "{}"
    text = json.dumps(_strip_sensitive(raw), ensure_ascii=False)
    if len(text.encode("utf-8")) > MAX_METADATA_BYTES:
        return json.dumps({"truncated": True})
    return text


def _as_float(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return min(max(number, low), high)


def sanitize_audit_event(
    item: Any,
    client_ip: str,
    user_agent: str,
    now_brt: str,
    now_ts: float,
) -> Optional[AuditEvent]:
    """Transforma um item enviado pelo navegador em AuditEvent confiável. Retorna None se inválido."""
    if not isinstance(item, dict):
        return None

    category = item.get("category")
    category = category if category in ALLOWED_CATEGORIES else "action"
    status = item.get("status")
    status = status if status in ALLOWED_STATUS else "success"

    action = str(item.get("action") or "unknown").strip()[:100] or "unknown"
    target_raw = item.get("target")
    target = str(target_raw).strip()[:100] if target_raw else None

    session_raw = item.get("session_id")
    session_id = session_raw if isinstance(session_raw, str) and _SESSION_RE.match(session_raw) else None

    # Horário do cliente só é aceito se for plausível; caso contrário usa o do servidor
    created_at_ts = _as_float(item.get("created_at_ts"), now_ts, now_ts - MAX_EVENT_AGE_SECONDS, now_ts + 60)

    return AuditEvent(
        timestamp=now_brt,
        created_at_ts=created_at_ts,
        pelada_code=normalize_pelada_code(item.get("pelada_code")),
        session_id=session_id,
        category=category,
        action=action,
        target=target,
        status=status,
        duration_ms=_as_float(item.get("duration_ms"), 0.0, 0.0, 3_600_000.0),
        client_ip=client_ip,
        user_agent=user_agent,
        metadata_json=sanitize_metadata(item.get("metadata", {})),
    )
