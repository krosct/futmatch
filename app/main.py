from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request, Response, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
import asyncio
import json
import os
import re
import secrets
import time

from app.domain.models import Player, Team, Match, SessionConfig, PeladaSession
from app.domain.audit import AuditEvent, normalize_pelada_code, sanitize_audit_event
from app.domain.matchmaker import MatchmakerService
from app.domain.team_colors import TEAM_COLORS, is_team_color
from app.domain.king_of_court import plan_next as king_plan_next
from app.domain.championship_integrity import is_modified as championship_is_modified, RULE_KEYS
from app.domain.fixture_moves import valid_drop_targets
from app.domain.player_identity import apply_renames, clean_name, normalize_name, resolve_alias, validate_pool_links

SAFE_ID_PATTERN = r"^[A-Za-z0-9_\-]{1,64}$"
from app.domain.state_rules import (
    aviso_times_sem_jogadores,
    find_empty_team_in_new_fixtures,
    find_state_inconsistency,
    times_sem_jogadores,
)
from app.domain.pool import PELADA_CREATED_AT_FORMAT, earliest_pelada_date
from app.domain.pelada_backup import BACKUP_FORMAT, BACKUP_VERSION, build_backup_document
from app.domain.pool_graph import MAX_POOLS_POR_PELADA
from app.domain.security import (
    hash_password,
    verify_password,
    needs_rehash,
    validate_password_value,
    create_admin_token,
    verify_admin_token,
    revoke_admin_token,
    revoke_admin_tokens_for_pelada,
    sync_admin_tokens,
    TOKEN_TTL_SECONDS,
    admin_token_remaining,
    rate_limiter
)
from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.adapters.sqlite_audit_repo import SQLiteAuditRepository
from app.adapters.http_guards import MaxBodySizeMiddleware, SameOriginWritesMiddleware
from app.services.audit_service import AuditService
from app.services.broadcaster import broadcaster

BRT = timezone(timedelta(hours=-3))

# Cookies de sessão administrativa: HttpOnly (JS não lê), SameSite=Strict (não vai em requisições cross-site).
# Em produção (HTTPS) o cookie é Secure. Só desligue com COOKIE_SECURE=0 em desenvolvimento local em HTTP.
# COOKIE_SECURE: "auto" (padrão) segue o esquema da requisição (HTTPS -> Secure); "1"/"0" forçam o valor.
COOKIE_SECURE_MODE = os.getenv("COOKIE_SECURE", "auto").strip().lower()
ADMIN_COOKIE_PREFIX = "fm_admin_"
MAX_BODY_BYTES = 5 * 1024 * 1024
AUDIT_RETENTION_DAYS = int(os.getenv("AUDIT_RETENTION_DAYS", "30"))

# Limites de abuso
API_RATE_LIMIT = (300, 60)            # requisições por IP, por minuto, em toda a API
PELADA_READ_LIMIT = (120, 60)         # consultas de pelada por IP/minuto (dificulta enumeração de códigos)
CLAIM_FAIL_LIMIT_PER_CLIENT = (5, 900)   # falhas de senha por IP + pelada em 15 min
CLAIM_FAIL_LIMIT_PER_PELADA = (50, 900)  # teto global por pelada: brute force distribuído, sem trancar o admin com 10 erros
ADMIN_RENEW_THRESHOLD_SECONDS = 6 * 3600  # renova o cookie quando faltarem menos de 6 horas
AUDIT_INGEST_LIMIT = (120, 60)        # lotes de telemetria por IP/minuto
MAX_SSE_PER_IP = 8

CSP_HEADER = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "font-src 'self'; "
    "img-src 'self' data: blob:; "
    "media-src 'self' blob:; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "manifest-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self'; "
    "form-action 'self'"
)

DATA_DIR = os.getenv("DATA_DIR", ".")
os.makedirs(DATA_DIR, exist_ok=True)
db_file = os.path.join(DATA_DIR, "futmatch.db")
repo = SQLiteMatchRepository(db_file)
audit_repo = SQLiteAuditRepository(db_file)
audit_service = AuditService(audit_repo, retention_days=AUDIT_RETENTION_DAYS)

_sse_connections_by_ip: Dict[str, int] = {}


def assert_single_worker() -> None:
    """Rate limit e bloqueios vivem na memória do processo: com vários workers o limite valeria N vezes.

    O deploy usa --workers 1. Para escalar horizontalmente é preciso mover esses contadores para um
    armazenamento compartilhado; até lá a aplicação recusa iniciar com mais de um worker.
    """
    workers = int(os.getenv("WEB_CONCURRENCY", "1") or "1")
    if workers > 1 and os.getenv("ALLOW_MULTI_WORKER", "0") != "1":
        raise RuntimeError(
            "FutMatch usa limites em memória de processo: rode com 1 worker (WEB_CONCURRENCY=1) "
            "ou defina ALLOW_MULTI_WORKER=1 assumindo o risco."
        )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    assert_single_worker()
    await repo.init_db()
    try:
        os.chmod(db_file, 0o600)  # banco com IPs e tokens: só o dono do processo lê
    except OSError:
        pass
    await audit_service.start()
    sync_admin_tokens(await repo.load_all_admin_tokens())
    yield
    await audit_service.stop()


app = FastAPI(
    title="FutMatch API",
    description="Organizador Moderno de Peladas e Campeonatos",
    lifespan=lifespan,
)
app.add_middleware(SameOriginWritesMiddleware)
app.add_middleware(MaxBodySizeMiddleware, max_bytes=MAX_BODY_BYTES)


# ==========================================
# HELPERS
# ==========================================
def get_client_ip(request: Request) -> str:
    """IP do cliente conforme o servidor. Não lê X-Forwarded-For diretamente: o uvicorn só aceita esse header
    de proxies confiáveis (--proxy-headers --forwarded-allow-ips), então o cliente não consegue forjá-lo."""
    return request.client.host if request.client else "unknown"


def _norm_code(code: str) -> str:
    return (code or "").strip().upper()


def _enforce_rate_limit(key: str, limit: tuple, detail: str) -> None:
    max_requests, window = limit
    allowed, retry_after = rate_limiter.check_rate_limit(key, max_requests=max_requests, window_seconds=window)
    if not allowed:
        raise HTTPException(status_code=429, detail=detail.format(retry_after))


def generate_random_code(length: int = 5) -> str:
    # Código alfanumérico sem caracteres confusos (0/O, 1/I). Gerado com CSPRNG.
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(chars) for _ in range(length))


def _cookie_name(code: str) -> str:
    return f"{ADMIN_COOKIE_PREFIX}{_norm_code(code)}"


def _cookie_secure(request: Request) -> bool:
    if COOKIE_SECURE_MODE in ("1", "true", "yes"):
        return True
    if COOKIE_SECURE_MODE in ("0", "false", "no"):
        return False
    return request.url.scheme == "https"


def _set_admin_cookie(response: Response, request: Request, code: str, token: str) -> None:
    response.set_cookie(
        key=_cookie_name(code),
        value=token,
        max_age=TOKEN_TTL_SECONDS,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="strict",
        path="/",
    )


def _clear_admin_cookie(response: Response, request: Request, code: str) -> None:
    response.delete_cookie(
        key=_cookie_name(code),
        path="/",
        secure=_cookie_secure(request),
        httponly=True,
        samesite="strict",
    )


async def _issue_admin_session(response: Response, request: Request, code: str) -> None:
    token = create_admin_token(code)
    await repo.save_admin_token(token, code, time.time() + TOKEN_TTL_SECONDS)
    _set_admin_cookie(response, request, code, token)


async def _require_pelada(code: str) -> PeladaSession:
    pelada = await repo.get_pelada(_norm_code(code))
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")
    return pelada


async def _is_admin(request: Request, code: str) -> bool:
    """Confere o cookie de sessão administrativa da pelada (memória primeiro, depois banco)."""
    clean_code = _norm_code(code)
    token = request.cookies.get(_cookie_name(clean_code))
    if not token:
        return False
    if verify_admin_token(token, clean_code):
        return True
    stored = await repo.get_admin_token(token)
    if stored and stored[0] == clean_code and time.time() <= stored[1]:
        sync_admin_tokens({token: stored})
        return True
    return False


async def require_admin_permission(request: Request, code: str) -> PeladaSession:
    """Exige pelada existente E sessão administrativa válida. Sempre fechado: não há modo aberto."""
    pelada = await _require_pelada(code)
    if not await _is_admin(request, code):
        raise HTTPException(
            status_code=403,
            detail="Acesso não autorizado: assuma a administração da pelada com a senha mestra."
        )
    return pelada


async def get_pool_started_at(chain_codes: List[str]) -> Optional[str]:
    """Data (dd/mm/aaaa) da pelada mais antiga da corrente da pool."""
    created_values = []
    for chain_code in chain_codes:
        chain_pelada = await repo.get_pelada(chain_code)
        if chain_pelada:
            created_values.append(chain_pelada.created_at)
    return earliest_pelada_date(created_values)


# ==========================================
# MIDDLEWARES
# ==========================================
@app.middleware("http")
async def api_rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        ip = get_client_ip(request)
        allowed, retry_after = rate_limiter.check_rate_limit(f"api:{ip}", *API_RATE_LIMIT)
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"detail": f"Muitas requisições. Aguarde {retry_after} segundo(s)."},
                headers={"Retry-After": str(retry_after)},
            )
    return await call_next(request)


@app.middleware("http")
async def audit_http_requests(request: Request, call_next):
    """Registra as chamadas da API (sem estáticos). Os registros são só para o desenvolvedor (ver app/cli/audit_logs.py)."""
    start_time = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start_time) * 1000, 2)

    path = request.url.path
    if not path.startswith("/api/") or path == "/api/audit/events":
        return response

    security_paths = ("/claim-admin", "/set-password", "/logout", "/api/matches")
    category = "security" if any(part in path for part in security_paths) and request.method != "GET" else "api"
    event = AuditEvent(
        timestamp=datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S"),
        created_at_ts=time.time(),
        pelada_code=normalize_pelada_code(request.query_params.get("pelada_code")),
        session_id=None,
        category=category,
        action=f"{request.method} {path}"[:200],
        target=path[:200],
        status="success" if response.status_code < 400 else "error",
        duration_ms=duration_ms,
        client_ip=get_client_ip(request),
        user_agent=request.headers.get("user-agent", "unknown")[:250],
        metadata_json=json.dumps({"status_code": response.status_code}),
    )
    audit_service.record_event(event)
    return response


@app.middleware("http")
async def renew_admin_session(request: Request, call_next):
    """Renova silenciosamente o cookie de admin enquanto ele estiver em uso (sessão deslizante)."""
    response = await call_next(request)
    if response.status_code >= 400:
        return response
    for name, token in request.cookies.items():
        if not name.startswith(ADMIN_COOKIE_PREFIX):
            continue
        code = name[len(ADMIN_COOKIE_PREFIX):]
        remaining = admin_token_remaining(token, code)
        if remaining is None or remaining >= ADMIN_RENEW_THRESHOLD_SECONDS:
            continue
        new_token = create_admin_token(code)
        await repo.save_admin_token(new_token, code, time.time() + TOKEN_TTL_SECONDS)
        await repo.delete_admin_token(token)
        revoke_admin_token(token)
        _set_admin_cookie(response, request, code, new_token)
    return response


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = CSP_HEADER
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# ==========================================
# DTOs com validação de limites de tamanho
# ==========================================
class CreatePeladaRequest(BaseModel):
    name: str = Field(..., min_length=3, max_length=60)
    password: str = Field(..., max_length=64)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        trimmed = (v or "").strip()
        if len(trimmed) < 3:
            raise ValueError("O nome da pelada deve conter no mínimo 3 caracteres.")
        return trimmed

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return validate_password_value(v)


class SetPasswordRequest(BaseModel):
    password: str = Field(..., max_length=64)

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        return validate_password_value(v)


class ClaimAdminRequest(BaseModel):
    password: str = Field(..., max_length=64)


class PoolLinkDTO(BaseModel):
    player_id: str = Field(..., pattern=SAFE_ID_PATTERN)       # jogador da pelada atual
    pool_player_id: str = Field(..., pattern=SAFE_ID_PATTERN)  # jogador já existente na pool


class PoolRenameDTO(BaseModel):
    player_id: str = Field(..., pattern=SAFE_ID_PATTERN)  # jogador novo da pelada atual
    name: str = Field(..., min_length=1, max_length=60)


class SetPoolRequest(BaseModel):
    # Lista completa das pools diretas da pelada (vazia = sem pool). Substitui a lista anterior.
    parent_codes: List[str] = Field(default_factory=list, max_length=MAX_POOLS_POR_PELADA)
    links: List[PoolLinkDTO] = Field(default_factory=list, max_length=300)
    renames: List[PoolRenameDTO] = Field(default_factory=list, max_length=300)


class SetDescriptionRequest(BaseModel):
    description: str = Field("", max_length=140)


# Identificadores gerados pelo app (ex.: "p_1700000_42", "team_1", "m_3"). Restringir o formato evita que um id
# com aspas ou símbolos seja interpolado em atributos HTML/JS no navegador.
SAFE_ID_RE = re.compile(SAFE_ID_PATTERN)
SAFE_ID_KEYS = ("id", "player_id", "team_id", "match_id", "home_team_id", "away_team_id")


def _validate_safe_ids(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for item in items:
        for key in SAFE_ID_KEYS:
            value = item.get(key)
            if value is not None and not SAFE_ID_RE.fullmatch(str(value)):
                raise ValueError(f"Identificador inválido em '{key}'.")
    return items


class PlayerDTO(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(..., min_length=1, max_length=64, pattern=SAFE_ID_PATTERN)
    name: str = Field(..., min_length=1, max_length=60)
    level: int = Field(3, ge=1, le=5)
    is_goalkeeper: bool = False

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        trimmed = v.strip()
        if not trimmed:
            raise ValueError("O nome do jogador não pode ser vazio.")
        return trimmed


class TeamDTO(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(..., min_length=1, max_length=64, pattern=SAFE_ID_PATTERN)
    name: str = Field(..., min_length=1, max_length=60)
    color: Optional[str] = Field(None, max_length=20)

    @field_validator("color")
    @classmethod
    def color_in_palette(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not is_team_color(v):
            raise ValueError("Cor de time fora da paleta do app.")
        return v.lower() if v else v
    players: List[PlayerDTO] = Field(default_factory=list, max_length=50)


class FixtureDTO(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str = Field(..., min_length=1, max_length=64, pattern=SAFE_ID_PATTERN)
    home_team_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    away_team_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)


class ConfigDTO(BaseModel):
    model_config = ConfigDict(extra="allow")
    players_per_team: int = Field(5, ge=2, le=20)
    match_duration_minutes: int = Field(10, ge=1, le=120)
    total_rounds: int = Field(1, ge=0, le=10)
    championship_type: Optional[str] = Field("single", max_length=20)
    points_win: int = Field(3, ge=1, le=10)
    points_draw: int = Field(1, ge=0, le=5)
    first_match_home_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    first_match_away_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    king_draw_rule: str = Field("both", pattern=r"^(both|fewer_points|fewer_goals|fewer_wins|more_points|more_goals|more_wins)$")
    king_max_consecutive_wins: int = Field(0, ge=0, le=50)
    balance_stars_pct: int = Field(40, ge=0, le=100)
    rules_baseline: Optional[Dict[str, Any]] = None

    @field_validator("rules_baseline")
    @classmethod
    def only_rule_keys(cls, v: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if v is None:
            return None
        clean = {k: val for k, val in v.items() if k in RULE_KEYS and (val is None or isinstance(val, (str, int)))}
        return {k: (val[:64] if isinstance(val, str) else val) for k, val in clean.items()}


class SyncPeladaStateRequest(BaseModel):
    players: List[PlayerDTO] = Field(default_factory=list, max_length=300)
    teams: List[TeamDTO] = Field(default_factory=list, max_length=50)
    fixtures: List[FixtureDTO] = Field(default_factory=list, max_length=500)
    config: Optional[ConfigDTO] = None


class BalancePlayerDTO(BaseModel):
    id: str = Field(..., min_length=1, max_length=64, pattern=SAFE_ID_PATTERN)
    name: str = Field(..., min_length=1, max_length=60)
    level: int = Field(3, ge=1, le=5)
    is_goalkeeper: bool = False


class BalanceTeamsRequest(BaseModel):
    players: List[BalancePlayerDTO] = Field(..., max_length=300)
    players_per_team: int = Field(5, ge=2, le=20)
    pelada_code: Optional[str] = Field(None, max_length=10)  # com pelada: usa histórico e % de estrelas configurado


class ScheduleTeamDTO(BaseModel):
    id: str = Field(..., min_length=1, max_length=64, pattern=SAFE_ID_PATTERN)
    name: str = Field(..., min_length=1, max_length=60)
    color: str = Field("#84cc16", max_length=20)
    players: List[BalancePlayerDTO] = Field(default_factory=list, max_length=50)


class GenerateScheduleRequest(BaseModel):
    teams: List[ScheduleTeamDTO] = Field(..., max_length=50)
    rounds: int = Field(1, ge=1, le=10)
    first_home_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    first_away_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)


class KingFixtureDTO(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field("", max_length=64)
    round_number: Optional[int] = Field(None, ge=0, le=100000)
    home_team_id: str = Field("", max_length=64)
    away_team_id: str = Field("", max_length=64)
    home_score: int = Field(0, ge=0, le=999)
    away_score: int = Field(0, ge=0, le=999)
    finished: bool = False


class KingNextMatchRequest(BaseModel):
    teams: List[ScheduleTeamDTO] = Field(..., max_length=50)
    fixtures: List[KingFixtureDTO] = Field(default_factory=list, max_length=1000)
    first_home_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    first_away_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    draw_rule: str = Field("both", pattern=r"^(both|fewer_points|fewer_goals|fewer_wins|more_points|more_goals|more_wins)$")
    max_consecutive_wins: int = Field(0, ge=0, le=50)
    points_win: int = Field(3, ge=1, le=10)
    points_draw: int = Field(1, ge=0, le=5)


class MatchSaveRequest(BaseModel):
    id: str = Field(..., max_length=64, pattern=SAFE_ID_PATTERN)
    round_number: int = Field(..., ge=1, le=100)
    home_team_id: str = Field(..., max_length=64, pattern=SAFE_ID_PATTERN)
    home_team_name: str = Field(..., max_length=60)
    away_team_id: str = Field(..., max_length=64, pattern=SAFE_ID_PATTERN)
    away_team_name: str = Field(..., max_length=60)
    home_score: int = Field(0, ge=0, le=999)
    away_score: int = Field(0, ge=0, le=999)
    home_players: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    away_players: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    events: List[Dict[str, Any]] = Field(default_factory=list, max_length=200)
    notes: Optional[str] = Field("", max_length=500)

    @field_validator("home_players", "away_players", "events")
    @classmethod
    def check_ids(cls, v: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return _validate_safe_ids(v)


class BatchAuditRequest(BaseModel):
    events: List[Dict[str, Any]] = Field(..., max_length=100)


# ---- Importação de pelada (arquivo JSON gerado pela exportação) ----
class MatchImportDTO(MatchSaveRequest):
    winner_team_id: Optional[str] = Field(None, max_length=64, pattern=SAFE_ID_PATTERN)
    is_draw: bool = False
    finished: bool = True
    played_at: Optional[str] = Field(None, max_length=32)


class PeladaBackupInfoDTO(BaseModel):
    code: str = Field(..., max_length=10)
    name: str = Field(..., min_length=3, max_length=60)
    created_at: str = Field(..., max_length=32)
    description: str = Field("", max_length=140)
    config: ConfigDTO = Field(default_factory=ConfigDTO)

    @field_validator("code")
    @classmethod
    def validate_code(cls, v: str) -> str:
        clean = _norm_code(v)
        if not re.fullmatch(r"[A-Z0-9]{1,10}", clean):
            raise ValueError("Código da pelada inválido no arquivo.")
        return clean

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        trimmed = v.strip()
        if len(trimmed) < 3:
            raise ValueError("O nome da pelada deve conter no mínimo 3 caracteres.")
        return trimmed

    @field_validator("created_at")
    @classmethod
    def validate_created_at(cls, v: str) -> str:
        try:
            datetime.strptime(v, PELADA_CREATED_AT_FORMAT)
        except ValueError:
            raise ValueError("Data de criação inválida no arquivo (esperado dd/mm/aaaa HH:MM:SS).")
        return v


class PeladaBackupPoolDTO(BaseModel):
    model_config = ConfigDict(extra="ignore")  # a lista 'chain' é só informativa na importação
    parent_codes: List[str] = Field(default_factory=list, max_length=MAX_POOLS_POR_PELADA)
    parent_code: Optional[str] = Field(None, max_length=10)  # formato v1 (um pai só), lido na importação
    player_aliases: Dict[str, str] = Field(default_factory=dict, max_length=300)


class PeladaBackupDTO(BaseModel):
    format: str = Field(..., pattern=f"^{BACKUP_FORMAT}$")
    version: int = Field(..., ge=1, le=BACKUP_VERSION)
    exported_at: Optional[str] = Field(None, max_length=32)
    pelada: PeladaBackupInfoDTO
    pool: PeladaBackupPoolDTO = Field(default_factory=PeladaBackupPoolDTO)
    players: List[PlayerDTO] = Field(default_factory=list, max_length=300)
    teams: List[TeamDTO] = Field(default_factory=list, max_length=50)
    fixtures: List[FixtureDTO] = Field(default_factory=list, max_length=500)
    matches: List[MatchImportDTO] = Field(default_factory=list, max_length=2000)

    @model_validator(mode="after")
    def check_unique_keys(self):
        names = [p.name.strip().lower() for p in self.players]
        if len(names) != len(set(names)):
            raise ValueError("O arquivo contém jogadores com o mesmo nome.")
        match_ids = [m.id for m in self.matches]
        if len(match_ids) != len(set(match_ids)):
            raise ValueError("O arquivo contém partidas com o mesmo identificador.")
        return self




# ==========================================
# ROTAS DE PELADAS
# ==========================================
@app.post("/api/peladas/create")
async def create_pelada(req: CreatePeladaRequest, request: Request, response: Response):
    """Cria uma nova pelada com código único de 5 caracteres e rate limit por IP."""
    client_ip = get_client_ip(request)
    _enforce_rate_limit(f"create:{client_ip}", (10, 60), "Limite de criação de peladas atingido. Aguarde {} segundo(s).")

    code = None
    for _ in range(10):
        candidate = generate_random_code(5)
        if not await repo.get_pelada(candidate):
            code = candidate
            break
    if code is None:
        raise HTTPException(status_code=500, detail="Erro ao gerar código único para a pelada.")

    pwd_hash = await asyncio.to_thread(hash_password, req.password)
    pelada = await repo.create_pelada(code=code, password_hash=pwd_hash, name=req.name)
    await _issue_admin_session(response, request, code)

    return {
        "status": "ok",
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
        "pool_started_at": earliest_pelada_date([pelada.created_at]),
        "description": pelada.description,
        "has_password": True,
        "is_admin": True,
    }


@app.get("/api/peladas/{code}")
async def get_pelada_info(code: str, request: Request):
    _enforce_rate_limit(f"pelada-read:{get_client_ip(request)}", PELADA_READ_LIMIT, "Muitas consultas. Aguarde {} segundo(s).")
    pelada = await _require_pelada(code)
    chain = await repo.get_pelada_chain_codes(pelada.code)
    return {
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
        "description": pelada.description,
        "pool_started_at": await get_pool_started_at(chain),
        "has_password": bool(pelada.password_hash),
        "is_admin": await _is_admin(request, pelada.code),
        "team_colors": list(TEAM_COLORS),
        "players": pelada.players,
        "teams": pelada.teams,
        "fixtures": pelada.fixtures,
        "config": (await repo.get_config(pelada.code)).__dict__,
        "parent_codes": await repo.get_pelada_parent_codes(pelada.code),
        "chain_codes": chain
    }


@app.get("/api/peladas/{code}/events")
async def pelada_live_events(code: str, request: Request):
    """
    Endpoint SSE (Server-Sent Events) para transmissão em tempo real das atualizações da pelada
    para espectadores e administradores. Mantém conexão persistente e resiliente.
    """
    clean_code = _norm_code(code)
    await _require_pelada(clean_code)

    client_ip = get_client_ip(request)
    if _sse_connections_by_ip.get(client_ip, 0) >= MAX_SSE_PER_IP:
        raise HTTPException(status_code=429, detail="Muitas conexões em tempo real abertas para este IP.")
    _sse_connections_by_ip[client_ip] = _sse_connections_by_ip.get(client_ip, 0) + 1

    async def event_generator():
        queue = await broadcaster.subscribe(clean_code)
        try:
            # Envia primeiro evento de boas-vindas / handshake de conexão estabelecida
            init_payload = {
                "event": "connected",
                "pelada_code": clean_code,
                "timestamp": datetime.now(BRT).isoformat()
            }
            yield f"event: connected\ndata: {json.dumps(init_payload)}\n\n"

            while True:
                # Se o cliente desconectar (fechar a aba, navegação, etc.), encerra o loop
                if await request.is_disconnected():
                    break

                try:
                    # Aguarda nova mensagem com timeout para envio de keepalive ping a cada 15 segundos
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                    event_type = payload.get("event", "message")
                    yield f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    # Envia ping de keep-alive para não derrubar a conexão por ociosidade em proxies/redes
                    yield f": ping\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            await broadcaster.unsubscribe(clean_code, queue)
            remaining = _sse_connections_by_ip.get(client_ip, 1) - 1
            if remaining > 0:
                _sse_connections_by_ip[client_ip] = remaining
            else:
                _sse_connections_by_ip.pop(client_ip, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


async def _pool_candidates(parent_codes: List[str]) -> List[Dict[str, Any]]:
    """Jogadores de todas as correntes das pools informadas, por id canônico, sem repetir."""
    chain: List[str] = []
    for parent in parent_codes:
        for code in await repo.get_pelada_chain_codes(parent):
            if code not in chain:  # peladas em comum entre pools contam uma vez
                chain.append(code)
    aliases: Dict[str, str] = {}
    for code in chain:
        aliases.update(await repo.get_player_aliases(code))
    candidates: Dict[str, Dict[str, Any]] = {}
    for code in chain:
        pelada = await repo.get_pelada(code)
        if not pelada:
            continue
        for p in pelada.players:
            canonical = resolve_alias(str(p.get("id")), aliases)
            if canonical not in candidates:
                candidates[canonical] = {"id": canonical, "name": clean_name(p.get("name", "")), "source": pelada.name}
    return sorted(candidates.values(), key=lambda c: normalize_name(c["name"]))


@app.get("/api/peladas/{code}/pool-candidates")
async def get_pool_candidates(code: str, request: Request, parent_code: List[str] = Query(default=[])):
    """Jogadores das pools informadas e os vínculos já gravados desta pelada (para a janela pré-preenchê-la)."""
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)
    parents = _normalizar_pais(parent_code, clean_code)
    if not parents:
        raise HTTPException(status_code=400, detail="Informe ao menos uma pelada anterior.")
    for parent in parents:
        await _require_pelada(parent)
    atuais = await repo.get_player_aliases(clean_code)
    candidatos = await _pool_candidates(parents)
    ids_candidatos = {c["id"] for c in candidatos}
    vinculos = {pid: alvo for pid, alvo in atuais.items() if alvo in ids_candidatos}
    return {"candidates": candidatos, "links": vinculos}


def _normalizar_pais(codigos: List[str], clean_code: str) -> List[str]:
    """Códigos das pools sem repetição, em maiúsculas. Recusa a própria pelada como pool."""
    parents: List[str] = []
    for bruto in codigos:
        parent = _norm_code(bruto) if bruto else ""
        if not parent:
            continue
        if parent == clean_code:
            raise HTTPException(status_code=400, detail="A pelada não pode ser vinculada a ela mesma.")
        if parent not in parents:
            parents.append(parent)
    if len(parents) > MAX_POOLS_POR_PELADA:
        raise HTTPException(status_code=400, detail=f"Uma pelada pode ter no máximo {MAX_POOLS_POR_PELADA} pools.")
    return parents


@app.post("/api/peladas/{code}/pool")
async def link_pelada_pool(code: str, req: SetPoolRequest, request: Request):
    """Define as pools diretas da pelada atual (grafo: várias pools). Exige administração."""
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)

    parents = _normalizar_pais(req.parent_codes, clean_code)
    renames_map: Dict[str, str] = {}
    link_map: Dict[str, str] = {}

    for parent in parents:
        if not await repo.get_pelada(parent):
            raise HTTPException(status_code=404, detail=f"A pelada anterior com código #{parent} não foi encontrada.")
        # Previne ciclo: a pelada atual não pode já estar na corrente de uma das novas pools
        if clean_code in await repo.get_pelada_chain_codes(parent):
            raise HTTPException(status_code=400, detail="Vínculo inválido: formaria um ciclo de corrente entre peladas.")

    if parents:
        current = await repo.get_pelada(clean_code)
        renames_map = {r.player_id: clean_name(r.name) for r in req.renames}
        error, link_map = validate_pool_links(
            current.players if current else [],
            await _pool_candidates(parents),
            [l.model_dump() for l in req.links],
            renames_map,
        )
        if error:
            raise HTTPException(status_code=400, detail=error)
        if renames_map and current:
            new_players, new_teams, new_fixtures = apply_renames(current.players, current.teams, current.fixtures, renames_map)
            await repo.save_pelada_state(clean_code, new_players, new_teams, new_fixtures)
            await broadcaster.broadcast(
                pelada_code=clean_code,
                event_type="state_updated",
                data={"players": new_players, "teams": new_teams, "fixtures": new_fixtures,
                      "config": (await repo.get_config(clean_code)).__dict__}
            )

    # Vínculos de identidade ficam nesta pelada; sem pool (ou ao desvincular) são removidos
    await repo.set_player_aliases(clean_code, link_map if parents else {})
    await repo.set_pelada_parent_codes(clean_code, parents)
    return await _resposta_pool(clean_code, parents)


@app.delete("/api/peladas/{code}/pool/{parent_code}")
async def remove_pelada_pool(code: str, parent_code: str, request: Request):
    """Remove uma pool específica. Vínculos de jogadores com ela são desfeitos; os das outras pools ficam."""
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)
    alvo = _norm_code(parent_code)
    atuais = await repo.get_pelada_parent_codes(clean_code)
    if alvo not in atuais:
        raise HTTPException(status_code=404, detail=f"Esta pelada não está vinculada à pool #{alvo}.")

    restantes = [p for p in atuais if p != alvo]
    ids_restantes = {c["id"] for c in await _pool_candidates(restantes)} if restantes else set()
    mantidos = {pid: destino for pid, destino in (await repo.get_player_aliases(clean_code)).items() if destino in ids_restantes}
    await repo.set_player_aliases(clean_code, mantidos)
    await repo.set_pelada_parent_codes(clean_code, restantes)
    return await _resposta_pool(clean_code, restantes)


async def _resposta_pool(clean_code: str, parents: List[str]) -> Dict[str, Any]:
    """Estado da corrente depois de uma mudança de pool; também avisa as outras abas pelo SSE."""
    updated_chain = await repo.get_pelada_chain_codes(clean_code)
    pool_started_at = await get_pool_started_at(updated_chain)
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="pool_updated",
        data={"parent_codes": parents, "chain_codes": updated_chain, "pool_started_at": pool_started_at}
    )
    return {
        "status": "ok",
        "message": f"Pool de peladas atualizado com sucesso! ({len(updated_chain)} pelada(s) encadeada(s))",
        "parent_codes": parents,
        "chain_codes": updated_chain,
        "pool_started_at": pool_started_at
    }


@app.post("/api/peladas/{code}/description")
async def set_pelada_description(code: str, req: SetDescriptionRequest, request: Request):
    """Salva a descrição livre da pelada (uma linha) e notifica os espectadores em tempo real."""
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)
    clean_description = " ".join(req.description.split())
    await repo.set_pelada_description(clean_code, clean_description)
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="info_updated",
        data={"description": clean_description}
    )
    return {"status": "ok", "description": clean_description}


@app.post("/api/peladas/{code}/set-password")
async def set_pelada_password(code: str, req: SetPasswordRequest, request: Request, response: Response):
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)

    pwd_hash = await asyncio.to_thread(hash_password, req.password)
    await repo.update_pelada_password(clean_code, pwd_hash)

    # Troca de senha invalida TODAS as sessões de admin dessa pelada (inclusive as antigas)
    await repo.delete_admin_tokens_for_pelada(clean_code)
    revoke_admin_tokens_for_pelada(clean_code)
    await _issue_admin_session(response, request, clean_code)
    return {
        "status": "ok",
        "message": "Senha mestra da pelada definida com sucesso! As sessões de admin anteriores foram encerradas.",
        "is_admin": True,
    }


@app.post("/api/peladas/{code}/claim-admin")
async def claim_admin(code: str, req: ClaimAdminRequest, request: Request, response: Response):
    """Permite assumir administração da pelada digitando a senha."""
    clean_code = _norm_code(code)
    client_ip = get_client_ip(request)

    # 1 tentativa a cada 15 segundos por IP e pelada
    _enforce_rate_limit(f"claim:{client_ip}:{clean_code}", (1, 15), "Muitas tentativas. Aguarde {} segundo(s) antes de tentar novamente.")

    # Falhas por IP + pelada, e teto global por pelada (contra brute force distribuído)
    for limit_key, limit in ((f"claimfail:{client_ip}:{clean_code}", CLAIM_FAIL_LIMIT_PER_CLIENT),
                             (f"claimfail:{clean_code}", CLAIM_FAIL_LIMIT_PER_PELADA)):
        blocked, retry_after = rate_limiter.is_limited(limit_key, *limit)
        if blocked:
            raise HTTPException(status_code=429, detail=f"Muitas senhas incorretas. Aguarde {retry_after} segundo(s).")

    pelada = await _require_pelada(clean_code)
    if not pelada.password_hash:
        raise HTTPException(status_code=400, detail="Esta pelada ainda não possui senha cadastrada.")

    valid = await asyncio.to_thread(verify_password, req.password, pelada.password_hash)
    if not valid:
        rate_limiter.record_failure(f"claimfail:{client_ip}:{clean_code}", CLAIM_FAIL_LIMIT_PER_CLIENT[1])
        rate_limiter.record_failure(f"claimfail:{clean_code}", CLAIM_FAIL_LIMIT_PER_PELADA[1])
        raise HTTPException(status_code=401, detail="Senha incorreta para esta pelada.")

    # Atualização transparente: hash legado ou com menos iterações é regenerado com os parâmetros atuais
    if needs_rehash(pelada.password_hash):
        upgraded_hash = await asyncio.to_thread(hash_password, req.password)
        await repo.update_pelada_password(clean_code, upgraded_hash)

    await _issue_admin_session(response, request, clean_code)
    return {
        "status": "ok",
        "message": "Administração assumida com sucesso! Você agora é o líder desta pelada.",
        "is_admin": True,
    }


@app.post("/api/peladas/{code}/logout")
async def logout_admin(code: str, request: Request, response: Response):
    """Encerra a sessão administrativa desta pelada neste navegador."""
    clean_code = _norm_code(code)
    token = request.cookies.get(_cookie_name(clean_code))
    if token:
        await repo.delete_admin_token(token)
        revoke_admin_token(token)
    _clear_admin_cookie(response, request, clean_code)
    return {"status": "ok", "is_admin": False}


@app.post("/api/peladas/{code}/sync-state")
async def sync_pelada_state(code: str, req: SyncPeladaStateRequest, request: Request):
    clean_code = _norm_code(code)
    _enforce_rate_limit(
        f"sync:{clean_code}:{get_client_ip(request)}", (60, 60),
        "Frequência de sincronização excedida. Aguarde {}s."
    )

    pelada = await require_admin_permission(request, clean_code)

    # Validação de nomes duplicados de jogadores
    seen_names = set()
    for p in req.players:
        clean_name = p.name.strip().lower()
        if clean_name in seen_names:
            raise HTTPException(
                status_code=400,
                detail=f"Não é permitido adicionar jogadores duplicados com o mesmo nome: '{p.name.strip()}'."
            )
        seen_names.add(clean_name)

    players = [p.model_dump() for p in req.players]
    teams = [t.model_dump() for t in req.teams]
    fixtures = [f.model_dump() for f in req.fixtures]
    inconsistency = find_state_inconsistency(players, teams, fixtures)
    if inconsistency:
        raise HTTPException(status_code=400, detail=inconsistency)
    known_fixture_ids = {f.get("id") for f in (pelada.fixtures or [])}
    empty_team_error = find_empty_team_in_new_fixtures(teams, fixtures, known_fixture_ids)
    if empty_team_error:
        raise HTTPException(status_code=400, detail=empty_team_error)
    await repo.save_pelada_state(clean_code, players, teams, fixtures)
    if req.config is not None:
        known = SessionConfig.__dataclass_fields__.keys()
        await repo.save_config(SessionConfig(**{k: v for k, v in req.config.model_dump().items() if k in known}), clean_code)

    # Notifica espectadores e clientes conectados em tempo real
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="state_updated",
        data={"players": players, "teams": teams, "fixtures": fixtures, "config": (await repo.get_config(clean_code)).__dict__}
    )
    return {"status": "ok"}


@app.get("/api/peladas/{code}/export")
async def export_pelada(code: str, request: Request):
    """Exporta a pelada completa em JSON (dados, configurações, pool e histórico). Nunca inclui a senha mestra."""
    _enforce_rate_limit(f"pelada-read:{get_client_ip(request)}", PELADA_READ_LIMIT, "Muitas consultas. Aguarde {} segundo(s).")
    pelada = await _require_pelada(code)

    pool_chain = []
    for chain_code in (await repo.get_pelada_chain_codes(pelada.code))[1:]:
        ancestor = await repo.get_pelada(chain_code)
        if ancestor:
            pool_chain.append({
                "code": ancestor.code,
                "name": ancestor.name,
                "created_at": ancestor.created_at,
                "description": ancestor.description,
            })

    config = await repo.get_config(pelada.code)
    matches = await repo.list_pelada_matches(pelada.code)
    document = build_backup_document(
        code=pelada.code,
        name=pelada.name,
        created_at=pelada.created_at,
        description=pelada.description,
        config=config.__dict__,
        parent_codes=await repo.get_pelada_parent_codes(pelada.code),
        pool_chain=pool_chain,
        player_aliases=await repo.get_player_aliases(pelada.code),
        players=pelada.players,
        teams=pelada.teams,
        fixtures=pelada.fixtures,
        matches=[repo._match_to_dict(m) for m in matches],
        exported_at=datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S"),
    )
    return JSONResponse(
        document,
        headers={
            "Content-Disposition": f'attachment; filename="futmatch-{pelada.code}.json"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/peladas/{code}/import")
async def import_pelada(code: str, backup: PeladaBackupDTO, request: Request):
    """Sobrescreve esta pelada com o conteúdo do arquivo exportado. Exige administração.

    Substitui nome, descrição, data de criação, configurações, jogadores, times, formações, vínculo de pool
    e todo o histórico. A senha mestra não muda. O vínculo de pool do arquivo é restaurado; se a pelada
    anterior não existir neste servidor, o vínculo é mantido e um aviso é devolvido.
    """
    clean_code = _norm_code(code)
    await require_admin_permission(request, clean_code)
    _enforce_rate_limit(f"import:{clean_code}:{get_client_ip(request)}", (5, 60), "Muitas importações. Aguarde {} segundo(s).")
    warnings: List[str] = []

    file_code = backup.pelada.code
    if file_code != clean_code:
        warnings.append(f"O arquivo é da pelada #{file_code}. Os dados foram gravados na pelada #{clean_code}.")

    # Arquivo v2 traz pool.parent_codes; arquivo v1 traz pool.parent_code (um pai só)
    brutos = list(backup.pool.parent_codes) + ([backup.pool.parent_code] if backup.pool.parent_code else [])
    parents: List[str] = []
    for parent in dict.fromkeys(_norm_code(b) for b in brutos if b):
        if parent == clean_code:
            continue  # uma pelada não pode ser vinculada a ela mesma
        if not await repo.get_pelada(parent):
            warnings.append(f"A pelada anterior #{parent} não existe neste servidor. O vínculo foi mantido, mas a corrente fica incompleta.")
        elif clean_code in await repo.get_pelada_chain_codes(parent):
            warnings.append(f"O vínculo com a pool #{parent} foi ignorado: formaria um ciclo de corrente.")
            continue
        parents.append(parent)

    config_fields = SessionConfig.__dataclass_fields__.keys()
    config = SessionConfig(**{k: v for k, v in backup.pelada.config.model_dump().items() if k in config_fields and v is not None})
    match_fields = Match.__dataclass_fields__.keys()
    matches = [Match(**{k: v for k, v in m.model_dump().items() if k in match_fields}) for m in backup.matches]

    # password_hash fica vazio aqui de propósito: o UPDATE do repositório não grava a senha
    pelada = PeladaSession(
        code=clean_code,
        password_hash="",
        created_at=backup.pelada.created_at,
        name=backup.pelada.name,
        players=[p.model_dump() for p in backup.players],
        teams=[t.model_dump() for t in backup.teams],
        fixtures=[f.model_dump() for f in backup.fixtures],
        config=config.__dict__,
        description=backup.pelada.description,
    )
    await repo.overwrite_pelada(pelada, config, matches)
    await repo.set_pelada_parent_codes(clean_code, parents)
    # Vínculos de identidade com a pool voltam junto com o vínculo de pool
    await repo.set_player_aliases(clean_code, dict(backup.pool.player_aliases) if parents else {})

    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="state_updated",
        data={"players": pelada.players, "teams": pelada.teams, "fixtures": pelada.fixtures, "config": config.__dict__}
    )
    return {
        "status": "ok",
        "code": clean_code,
        "name": pelada.name,
        "matches": len(matches),
        "warnings": warnings,
    }


# ==========================================
# ROTAS PRINCIPAIS
# ==========================================
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"}

def scan_audio_directory(subpath: str) -> List[str]:
    """Escaneia o diretório de áudio em static/{subpath} e retorna os caminhos dos arquivos válidos."""
    base_dir = os.path.join("static", subpath)
    if not os.path.exists(base_dir):
        return []
    files = []
    for entry in sorted(os.listdir(base_dir)):
        ext = os.path.splitext(entry)[1].lower()
        if ext in AUDIO_EXTENSIONS and not entry.startswith("."):
            files.append(f"/static/{subpath}/{entry}")
    return files

@app.get("/api/audio-catalog")
async def get_audio_catalog():
    """Retorna dinamicamente todas as músicas, efeitos e alarmes presentes no disco."""
    return {
        "abertura": scan_audio_directory("music"),
        "efeitos": scan_audio_directory("sounds"),
        "alarms": scan_audio_directory("alarms")
    }

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

@app.get("/", response_class=HTMLResponse)
async def serve_home():
    return FileResponse("static/index.html")

@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json")

@app.get("/favicon.ico", include_in_schema=False)
async def serve_favicon():
    return FileResponse("static/favicon.ico", media_type="image/x-icon")

@app.get("/sw.js")
async def serve_service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript", headers={"Service-Worker-Allowed": "/"})

# Montagem por último para não sombrear as rotas acima
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/api/config")
async def get_config(pelada_code: Optional[str] = Query(None, max_length=10)):
    if not pelada_code:
        return SessionConfig().__dict__  # Sem pelada: apenas os padrões, nada é lido nem gravado
    await _require_pelada(pelada_code)
    cfg = await repo.get_config(_norm_code(pelada_code))
    return cfg.__dict__

@app.post("/api/config")
async def update_config(req: ConfigDTO, request: Request, pelada_code: str = Query(..., max_length=10)):
    clean_code = _norm_code(pelada_code)
    await require_admin_permission(request, clean_code)
    known_fields = SessionConfig.__dataclass_fields__.keys()
    cfg = SessionConfig(**{k: v for k, v in req.model_dump().items() if k in known_fields})
    await repo.save_config(cfg, clean_code)
    return {"status": "ok", "config": cfg.__dict__}

@app.post("/api/balance-teams")
async def balance_teams(req: BalanceTeamsRequest):
    """Equilibra times a partir da lista de jogadores recebida (cálculo puro, sem gravação)."""
    players = [
        Player(id=p.id, name=p.name.strip(), level=p.level, is_goalkeeper=p.is_goalkeeper)
        for p in req.players
    ]
    if req.pelada_code:
        clean_code = _norm_code(req.pelada_code)
        await _require_pelada(clean_code)
        cfg = await repo.get_config(clean_code)
        stats = await repo.get_players_stats(pelada_code=clean_code)
        aliases = await repo.get_chain_player_aliases(clean_code)
        for pl in players:
            pl_stats = stats.get(resolve_alias(str(pl.id), aliases)) or stats.get(pl.name.strip().lower())
            pl.effective_level = MatchmakerService.calculate_effective_level(
                pl.level, pl_stats, stars_pct=cfg.balance_stars_pct
            )
    teams = MatchmakerService.balance_teams(players, req.players_per_team)
    return [
        {
            "id": t.id,
            "name": t.name,
            "color": t.color,
            "players": [p.__dict__ for p in t.players]
        }
        for t in teams
    ]

@app.post("/api/generate-schedule")
async def generate_schedule(req: GenerateScheduleRequest):
    """Gera a tabela completa de confrontos (turnos e jogos) para os times (cálculo puro, sem gravação)."""
    sem_jogadores = times_sem_jogadores([t.model_dump() for t in req.teams])
    if sem_jogadores:
        raise HTTPException(status_code=400, detail=aviso_times_sem_jogadores([t["name"] for t in sem_jogadores]))
    teams = [
        Team(
            id=t.id,
            name=t.name,
            color=t.color,
            players=[Player(id=p.id, name=p.name, level=p.level, is_goalkeeper=p.is_goalkeeper) for p in t.players],
        )
        for t in req.teams
    ]

    schedule = MatchmakerService.generate_round_robin_fixtures(
        teams, req.rounds, first_match=(req.first_home_id, req.first_away_id)
    )
    return [_match_to_dict(m) for m in schedule]


def _match_to_dict(m: Match) -> Dict[str, Any]:
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
            "played_at": m.played_at
        }


class ChampionshipCheckRequest(BaseModel):
    championship_type: str = Field("single", max_length=20)
    team_ids: List[str] = Field(default_factory=list, max_length=50)
    fixtures: List[KingFixtureDTO] = Field(default_factory=list, max_length=1000)
    draw_rule: str = Field("both", pattern=r"^(both|fewer_points|fewer_goals|fewer_wins|more_points|more_goals|more_wins)$")
    max_consecutive_wins: int = Field(0, ge=0, le=50)
    points_win: int = Field(3, ge=1, le=10)
    points_draw: int = Field(1, ge=0, le=5)
    rules: Dict[str, Any] = Field(default_factory=dict)
    rules_baseline: Optional[Dict[str, Any]] = None


@app.post("/api/championship/check")
async def championship_check(req: ChampionshipCheckRequest):
    """Informa se a tabela atual foge das regras do formato (cálculo puro, sem gravação)."""
    modified = championship_is_modified(
        req.championship_type, req.team_ids, [f.model_dump() for f in req.fixtures],
        rules=req.rules, rules_baseline=req.rules_baseline,
        draw_rule=req.draw_rule, max_consecutive_wins=req.max_consecutive_wins,
        points_win=req.points_win, points_draw=req.points_draw,
    )
    return {"modified": modified}


class ChampionshipDropTargetsRequest(ChampionshipCheckRequest):
    moved_id: str = Field(..., max_length=64)


@app.post("/api/championship/drop-targets")
async def championship_drop_targets(req: ChampionshipDropTargetsRequest):
    """Onde soltar a partida arrastada sem quebrar o formato (cálculo puro, sem gravação)."""
    return valid_drop_targets(
        req.championship_type, req.team_ids, [f.model_dump() for f in req.fixtures], req.moved_id,
        draw_rule=req.draw_rule, max_consecutive_wins=req.max_consecutive_wins,
        points_win=req.points_win, points_draw=req.points_draw,
    )


@app.post("/api/king/next-match")
async def king_next_match(req: KingNextMatchRequest):
    """Próxima partida do Rei da Pelada a partir do histórico (cálculo puro, sem gravação)."""
    teams_dict = [t.model_dump() for t in req.teams]
    teams = [
        Team(
            id=t.id,
            name=t.name,
            color=t.color,
            players=[Player(id=p.id, name=p.name, level=p.level, is_goalkeeper=p.is_goalkeeper) for p in t.players],
        )
        for t in req.teams
    ]
    match, queue = king_plan_next(
        teams, [f.model_dump() for f in req.fixtures],
        start_pair=[req.first_home_id, req.first_away_id],
        draw_rule=req.draw_rule,
        max_consecutive_wins=req.max_consecutive_wins,
        points_win=req.points_win,
        points_draw=req.points_draw,
    )
    if match:
        erro = find_empty_team_in_new_fixtures(teams_dict, [_match_to_dict(match)], set())
        if erro:
            raise HTTPException(status_code=400, detail=erro)
    return {"match": _match_to_dict(match) if match else None, "queue": queue}

@app.post("/api/matches/save")
async def save_match_result(req: MatchSaveRequest, request: Request, pelada_code: str = Query(..., max_length=10)):
    """Salva o resultado final de uma partida. Exige administração da pelada informada."""
    clean_code = _norm_code(pelada_code)
    await require_admin_permission(request, clean_code)

    played_at = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
    winner_id = None
    is_draw = req.home_score == req.away_score

    if not is_draw:
        winner_id = req.home_team_id if req.home_score > req.away_score else req.away_team_id

    match = Match(
        id=req.id,
        round_number=req.round_number,
        home_team_id=req.home_team_id,
        home_team_name=req.home_team_name,
        away_team_id=req.away_team_id,
        away_team_name=req.away_team_name,
        home_score=req.home_score,
        away_score=req.away_score,
        home_players=req.home_players,
        away_players=req.away_players,
        events=req.events,
        winner_team_id=winner_id,
        is_draw=is_draw,
        finished=True,
        played_at=played_at,
        notes=req.notes or ""
    )

    await repo.save_match(match, clean_code)
    match_dict = repo._match_to_dict(match)
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="match_saved",
        data={"match": match_dict}
    )
    return {"status": "ok", "match": match_dict}

@app.get("/api/matches")
async def list_matches(pelada_code: str = Query(..., max_length=10)):
    clean_code = _norm_code(pelada_code)
    await _require_pelada(clean_code)
    matches = await repo.list_matches(clean_code)
    return [repo._match_to_dict(m) for m in matches]

@app.delete("/api/matches")
async def clear_all_matches(request: Request, pelada_code: str = Query(..., max_length=10)):
    clean_code = _norm_code(pelada_code)
    await require_admin_permission(request, clean_code)
    await repo.delete_all_matches(clean_code)
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="matches_cleared",
        data={}
    )
    return {"status": "ok", "message": "Histórico limpo com sucesso."}

@app.delete("/api/matches/{match_id}")
async def delete_single_match(match_id: str, request: Request, pelada_code: str = Query(..., max_length=10)):
    """Exclui uma partida finalizada, dentro da pelada informada, para permitir reedição ou correção."""
    clean_code = _norm_code(pelada_code)
    await require_admin_permission(request, clean_code)
    success = await repo.delete_match(match_id, clean_code)
    if not success:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")
    await broadcaster.broadcast(
        pelada_code=clean_code,
        event_type="match_deleted",
        data={"match_id": match_id}
    )
    return {"status": "ok", "message": "Partida removida do histórico com sucesso."}

@app.get("/api/dashboard")
async def get_dashboard(pelada_code: str = Query(..., max_length=10)):
    clean_code = _norm_code(pelada_code)
    await _require_pelada(clean_code)
    return await repo.get_dashboard_metrics(pelada_code=clean_code)


# ==========================================
# ROTAS DE TELEMETRIA (ingestão apenas; leitura é feita só pelo CLI no servidor)
# ==========================================
@app.post("/api/audit/events")
async def ingest_audit_events(req: BatchAuditRequest, request: Request):
    """Recebe eventos de telemetria do navegador. Cada item é sanitizado antes de ser gravado."""
    client_ip = get_client_ip(request)
    _enforce_rate_limit(f"audit:{client_ip}", AUDIT_INGEST_LIMIT, "Muitos eventos de auditoria. Aguarde {} segundo(s).")

    user_agent = request.headers.get("user-agent", "unknown")[:250]
    now_brt = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
    now_ts = time.time()

    parsed_events: List[AuditEvent] = []
    for item in req.events:
        event = sanitize_audit_event(item, client_ip, user_agent, now_brt, now_ts)
        if event is not None:
            parsed_events.append(event)

    audit_service.record_events(parsed_events)
    return {"status": "ok", "ingested": len(parsed_events)}
