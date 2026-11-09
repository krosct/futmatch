from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
import asyncio
import json
import os
import random
import string
import time

from app.domain.models import Player, Team, Match, SessionConfig, PeladaSession
from app.domain.audit import AuditEvent
from app.domain.matchmaker import MatchmakerService
from app.domain.pool import earliest_pelada_date
from app.domain.security import (
    hash_password,
    verify_password,
    is_legacy_hash,
    create_admin_token,
    verify_admin_token,
    sync_admin_tokens,
    TOKEN_TTL_SECONDS,
    rate_limiter
)
from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.adapters.sqlite_audit_repo import SQLiteAuditRepository
from app.services.audit_service import AuditService
from app.services.broadcaster import broadcaster

BRT = timezone(timedelta(hours=-3))

app = FastAPI(title="FutMatch API", description="Organizador Moderno de Peladas e Campeonatos")

# ==========================================
# MIDDLEWARE: AUDITORIA DE REQUISIÇÕES HTTP
# ==========================================
@app.middleware("http")
async def audit_http_requests(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    duration_ms = round((time.time() - start_time) * 1000, 2)

    path = request.url.path
    method = request.method

    # Ignora requisições de estáticos puros e o próprio endpoint de ingestão de auditoria para evitar loops
    if not path.startswith("/static") and path != "/api/audit/events":
        pelada_code = request.query_params.get("pelada_code") or request.headers.get("x-pelada-code")
        client_ip = get_client_ip(request)
        user_agent = request.headers.get("user-agent", "unknown")[:250]
        now_brt = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")

        status_str = "success" if response.status_code < 400 else "error"
        category = "api"
        if "login" in path or "admin" in path or "password" in path:
            category = "security"

        event = AuditEvent(
            timestamp=now_brt,
            created_at_ts=time.time(),
            pelada_code=pelada_code,
            session_id=request.headers.get("x-session-id"),
            category=category,
            action=f"{method} {path}",
            target=path,
            status=status_str,
            duration_ms=duration_ms,
            client_ip=client_ip,
            user_agent=user_agent,
            metadata_json=json.dumps({"status_code": response.status_code})
        )
        audit_service.record_event(event)

    return response
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    # Proteção de tamanho de payload para prevenir DoS (máximo 5MB por requisição)
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 5 * 1024 * 1024:
        return Response(content="Payload Too Large (máximo 5MB permitido)", status_code=413)

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    return response

DATA_DIR = os.getenv("DATA_DIR", ".")
os.makedirs(DATA_DIR, exist_ok=True)
db_file = os.path.join(DATA_DIR, "futmatch.db")
repo = SQLiteMatchRepository(db_file)
audit_repo = SQLiteAuditRepository(db_file)
audit_service = AuditService(audit_repo)

def get_client_ip(request: Request) -> str:
    """Obtém o IP real do cliente mesmo atrás de proxy reverso."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"

def generate_random_code(length: int = 5) -> str:
    # Código alfanumérico sem caracteres confusos (0/O, 1/I)
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(chars) for _ in range(length))

async def require_admin_permission(pelada_code: str, x_admin_token: Optional[str] = None) -> PeladaSession:
    """
    Verifica se a pelada existe e se o requisitante tem permissão de escrita.
    Se a pelada tem senha configurada, exige um X-Admin-Token válido.
    """
    pelada = await repo.get_pelada(pelada_code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")

    # Se a pelada possui senha configurada, o token é obrigatório
    if pelada.password_hash:
        valid = verify_admin_token(x_admin_token, pelada_code)
        if not valid and x_admin_token:
            # Fallback direto ao banco de dados SQLite caso o processo tenha sido reiniciado
            db_token = await repo.get_admin_token(x_admin_token)
            if db_token:
                target_code, expires_at = db_token
                if time.time() <= expires_at and target_code == pelada_code.upper().strip():
                    valid = True
                    # Reabastece o cache em memória
                    sync_admin_tokens({x_admin_token: (target_code, expires_at)})

        if not valid:
            raise HTTPException(
                status_code=403,
                detail="Acesso não autorizado: Esta pelada possui senha mestra. Assuma a administração como líder para fazer alterações."
            )

    return pelada

# Serve arquivos estáticos (CSS, JS, assets)
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.on_event("startup")
async def on_startup():
    await repo.init_db()
    await audit_service.start()
    tokens = await repo.load_all_admin_tokens()
    sync_admin_tokens(tokens)

@app.on_event("shutdown")
async def on_shutdown():
    await audit_service.stop()

# DTOs com validação de limites de tamanho
class CreatePeladaRequest(BaseModel):
    name: str = Field(..., min_length=3, max_length=60)
    password: str = Field(..., min_length=3, max_length=64)

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        trimmed = (v or "").strip()
        if len(trimmed) < 3:
            raise ValueError("O nome da pelada deve conter no mínimo 3 caracteres.")
        return trimmed

class SetPasswordRequest(BaseModel):
    password: str = Field(..., min_length=3, max_length=64)

class ClaimAdminRequest(BaseModel):
    password: str = Field(..., max_length=64)

class SetPoolRequest(BaseModel):
    parent_code: Optional[str] = Field(None, max_length=10)

class SetDescriptionRequest(BaseModel):
    description: str = Field("", max_length=140)

class SyncPeladaStateRequest(BaseModel):
    players: List[Dict[str, Any]] = Field(default_factory=list, max_length=300)
    teams: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    fixtures: List[Dict[str, Any]] = Field(default_factory=list, max_length=500)
    config: Optional[Dict[str, Any]] = None

class BalanceTeamsRequest(BaseModel):
    players: List[Dict[str, Any]] = Field(..., max_length=300)
    players_per_team: int = Field(5, ge=2, le=20)
    pelada_code: Optional[str] = Field(None, max_length=10)

class GenerateScheduleRequest(BaseModel):
    teams: List[Dict[str, Any]] = Field(..., max_length=50)
    rounds: int = Field(1, ge=1, le=10)

class MatchSaveRequest(BaseModel):
    id: str = Field(..., max_length=100)
    round_number: int = Field(..., ge=1, le=100)
    home_team_id: str = Field(..., max_length=50)
    home_team_name: str = Field(..., max_length=60)
    away_team_id: str = Field(..., max_length=50)
    away_team_name: str = Field(..., max_length=60)
    home_score: int = Field(0, ge=0, le=999)
    away_score: int = Field(0, ge=0, le=999)
    home_players: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    away_players: List[Dict[str, Any]] = Field(default_factory=list, max_length=50)
    events: List[Dict[str, Any]] = Field(default_factory=list, max_length=200)
    notes: Optional[str] = Field("", max_length=500)

class ConfigDTO(BaseModel):
    players_per_team: int = Field(5, ge=2, le=20)
    match_duration_minutes: int = Field(10, ge=1, le=120)
    total_rounds: int = Field(1, ge=0, le=10)
    championship_type: Optional[str] = Field("single", max_length=20)
    points_win: int = Field(3, ge=1, le=10)
    points_draw: int = Field(1, ge=0, le=5)
    alarm_sound: Optional[str] = Field("standard-emergency-warning-signal.mp3", max_length=100)

async def get_pool_started_at(chain_codes: List[str]) -> Optional[str]:
    """Data (dd/mm/aaaa) da pelada mais antiga da corrente da pool."""
    created_values = []
    for chain_code in chain_codes:
        chain_pelada = await repo.get_pelada(chain_code)
        if chain_pelada:
            created_values.append(chain_pelada.created_at)
    return earliest_pelada_date(created_values)

# Rotas de Peladas (Multi-pelada)
@app.post("/api/peladas/create")
async def create_pelada(req: CreatePeladaRequest, request: Request):
    """Cria uma nova pelada com código único de 5 caracteres e rate limit por IP."""
    client_ip = get_client_ip(request)
    # Rate limit: máximo 10 criações de pelada por minuto por IP
    allowed, retry_after = rate_limiter.check_rate_limit(f"create:{client_ip}", max_requests=10, window_seconds=60)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Limite de criação de peladas atingido. Aguarde {retry_after} segundo(s)."
        )

    for _ in range(10):
        code = generate_random_code(5)
        existing = await repo.get_pelada(code)
        if not existing:
            break
    else:
        raise HTTPException(status_code=500, detail="Erro ao gerar código único para a pelada.")

    pwd_hash = hash_password(req.password)
    pelada = await repo.create_pelada(code=code, password_hash=pwd_hash, name=req.name)
    admin_token = create_admin_token(code)
    await repo.save_admin_token(admin_token, code, time.time() + TOKEN_TTL_SECONDS)

    return {
        "status": "ok",
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
        "pool_started_at": earliest_pelada_date([pelada.created_at]),
        "description": pelada.description,
        "has_password": bool(pwd_hash),
        "admin_token": admin_token
    }

@app.get("/api/peladas/{code}")
async def get_pelada_info(code: str):
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada. Verifique o código digitado.")
    chain = await repo.get_pelada_chain_codes(code)
    return {
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
        "description": pelada.description,
        "pool_started_at": await get_pool_started_at(chain),
        "has_password": bool(pelada.password_hash),
        "players": pelada.players,
        "teams": pelada.teams,
        "fixtures": pelada.fixtures,
        "config": pelada.config,
        "parent_code": pelada.parent_code,
        "chain_codes": chain
    }

@app.get("/api/peladas/{code}/events")
async def pelada_live_events(code: str, request: Request):
    """
    Endpoint SSE (Server-Sent Events) para transmissão em tempo real das atualizações da pelada
    para espectadores e administradores. Mantém conexão persistente e resiliente.
    """
    clean_code = code.strip().upper()
    pelada = await repo.get_pelada(clean_code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada para transmissão ao vivo.")

    queue = await broadcaster.subscribe(clean_code)

    async def event_generator():
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

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/peladas/{code}/pool")
async def link_pelada_pool(code: str, req: SetPoolRequest, x_admin_token: Optional[str] = Header(None)):
    """Vincula a pelada atual a uma pelada anterior na corrente (pool). Exige autorização se houver senha."""
    pelada = await require_admin_permission(code, x_admin_token)

    parent = req.parent_code.strip().upper() if req.parent_code else None

    if parent:
        if parent == code.upper():
            raise HTTPException(status_code=400, detail="A pelada não pode ser vinculada a ela mesma.")
        target = await repo.get_pelada(parent)
        if not target:
            raise HTTPException(status_code=404, detail=f"A pelada anterior com código #{parent} não foi encontrada.")
        
        # Previne ciclo: verifica se o código atual já está na corrente do alvo
        target_chain = await repo.get_pelada_chain_codes(parent)
        if code.upper() in target_chain:
            raise HTTPException(status_code=400, detail="Vínculo inválido: formaria um ciclo de corrente entre peladas.")

    await repo.set_pelada_parent_code(code, parent)
    updated_chain = await repo.get_pelada_chain_codes(code)
    pool_started_at = await get_pool_started_at(updated_chain)
    await broadcaster.broadcast(
        pelada_code=code,
        event_type="pool_updated",
        data={"parent_code": parent, "chain_codes": updated_chain, "pool_started_at": pool_started_at}
    )
    return {
        "status": "ok",
        "message": f"Pool de peladas atualizado com sucesso! ({len(updated_chain)} pelada(s) encadeada(s))",
        "parent_code": parent,
        "chain_codes": updated_chain,
        "pool_started_at": pool_started_at
    }

@app.post("/api/peladas/{code}/description")
async def set_pelada_description(code: str, req: SetDescriptionRequest, x_admin_token: Optional[str] = Header(None)):
    """Salva a descrição livre da pelada (uma linha) e notifica os espectadores em tempo real."""
    await require_admin_permission(code, x_admin_token)
    clean_description = " ".join(req.description.split())
    await repo.set_pelada_description(code, clean_description)
    await broadcaster.broadcast(
        pelada_code=code,
        event_type="info_updated",
        data={"description": clean_description}
    )
    return {"status": "ok", "description": clean_description}

@app.post("/api/peladas/{code}/set-password")
async def set_pelada_password(code: str, req: SetPasswordRequest, x_admin_token: Optional[str] = Header(None)):
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")
    if not req.password or len(req.password.strip()) < 3:
        raise HTTPException(status_code=400, detail="A senha deve ter no mínimo 3 caracteres.")

    # Se a pelada já tem senha, exige que o usuário já seja admin
    if pelada.password_hash:
        valid = verify_admin_token(x_admin_token, code)
        if not valid and x_admin_token:
            db_token = await repo.get_admin_token(x_admin_token)
            if db_token:
                target_code, expires_at = db_token
                if time.time() <= expires_at and target_code == code.upper().strip():
                    valid = True
                    sync_admin_tokens({x_admin_token: (target_code, expires_at)})
        if not valid:
            raise HTTPException(status_code=403, detail="Não autorizado: apenas o administrador atual pode alterar a senha mestra.")

    # Gera hash seguro PBKDF2 com salt
    pwd_hash = hash_password(req.password)
    await repo.update_pelada_password(code, pwd_hash)

    # Gera/renova token administrativo para o líder
    admin_token = create_admin_token(code)
    await repo.save_admin_token(admin_token, code, time.time() + TOKEN_TTL_SECONDS)
    return {
        "status": "ok",
        "message": "Senha mestra da pelada definida com sucesso!",
        "admin_token": admin_token
    }

@app.post("/api/peladas/{code}/claim-admin")
async def claim_admin(code: str, req: ClaimAdminRequest, request: Request):
    """Permite assumir administração da pelada digitando a senha, com rate limit por IP + código."""
    client_ip = get_client_ip(request)
    rate_key = f"claim:{client_ip}:{code.upper()}"

    # Rate limit estrito: 1 tentativa a cada 15 segundos por IP e código de pelada
    allowed, retry_after = rate_limiter.check_rate_limit(rate_key, max_requests=1, window_seconds=15)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Muitas tentativas. Aguarde {retry_after} segundo(s) antes de tentar novamente."
        )

    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")

    if not pelada.password_hash:
        raise HTTPException(status_code=400, detail="Esta pelada ainda não possui senha cadastrada.")

    if not verify_password(req.password, pelada.password_hash):
        raise HTTPException(status_code=401, detail="Senha incorreta para esta pelada.")

    # Atualização transparente: se a pelada ainda usava hash legado SHA-256, atualiza para PBKDF2
    if is_legacy_hash(pelada.password_hash):
        upgraded_hash = hash_password(req.password)
        await repo.update_pelada_password(code, upgraded_hash)

    # Gera token de administrador forte e aleatório
    token = create_admin_token(code)
    await repo.save_admin_token(token, code, time.time() + TOKEN_TTL_SECONDS)

    return {
        "status": "ok",
        "message": "Administração assumida com sucesso! Você agora é o líder desta pelada.",
        "admin_token": token
    }

@app.post("/api/peladas/{code}/sync-state")
async def sync_pelada_state(code: str, req: SyncPeladaStateRequest, request: Request, x_admin_token: Optional[str] = Header(None)):
    # Rate limit de sincronização por pelada (máximo 60 syncs por minuto para evitar spam no disco)
    client_ip = get_client_ip(request)
    allowed, retry_after = rate_limiter.check_rate_limit(f"sync:{code.upper()}:{client_ip}", max_requests=60, window_seconds=60)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Frequência de sincronização excedida. Aguarde {retry_after}s."
        )

    pelada = await require_admin_permission(code, x_admin_token)
    config = req.config or pelada.config or {}

    # Validação de nomes duplicados de jogadores
    seen_names = set()
    for p in req.players:
        raw_name = p.get("name")
        if not raw_name or not isinstance(raw_name, str):
            continue
        clean_name = raw_name.strip().lower()
        if clean_name in seen_names:
            raise HTTPException(
                status_code=400,
                detail=f"Não é permitido adicionar jogadores duplicados com o mesmo nome: '{raw_name.strip()}'."
            )
        seen_names.add(clean_name)

    await repo.save_pelada_state(code, req.players, req.teams, req.fixtures, config)

    # Notifica espectadores e clientes conectados em tempo real
    await broadcaster.broadcast(
        pelada_code=code,
        event_type="state_updated",
        data={
            "players": req.players,
            "teams": req.teams,
            "fixtures": req.fixtures,
            "config": config
        }
    )
    return {"status": "ok"}

# Rotas Principais
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

@app.get("/api/config")
async def get_config(pelada_code: Optional[str] = None):
    cfg = await repo.get_config(pelada_code)
    return cfg.__dict__

@app.post("/api/config")
async def update_config(req: ConfigDTO, pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)
    cfg = SessionConfig(**req.dict())
    await repo.save_config(cfg, pelada_code)
    return {"status": "ok", "config": cfg.__dict__}

@app.post("/api/balance-teams")
async def balance_teams(req: BalanceTeamsRequest, x_admin_token: Optional[str] = Header(None)):
    """Equilibra times a partir da lista de jogadores recebida."""
    if req.pelada_code:
        await require_admin_permission(req.pelada_code, x_admin_token)
    players = [
        Player(
            id=str(p.get("id") or i),
            name=str(p.get("name", f"Jogador {i+1}")).strip(),
            level=int(p.get("level", 3)),
            is_goalkeeper=bool(p.get("is_goalkeeper", False))
        )
        for i, p in enumerate(req.players)
    ]
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
    """Gera a tabela completa de confrontos (turnos e jogos) para os times."""
    teams = []
    for t in req.teams:
        plist = [
            Player(id=p["id"], name=p["name"], level=p.get("level", 3), is_goalkeeper=p.get("is_goalkeeper", False))
            for p in t.get("players", [])
        ]
        teams.append(Team(id=t["id"], name=t["name"], color=t.get("color", "#84cc16"), players=plist))

    schedule = MatchmakerService.generate_round_robin_fixtures(teams, req.rounds)
    return [
        {
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
        for m in schedule
    ]

@app.post("/api/matches/save")
async def save_match_result(req: MatchSaveRequest, pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    """Salva o resultado final de uma partida com validação de permissão de admin."""
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)

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

    await repo.save_match(match, pelada_code)
    match_dict = repo._match_to_dict(match)
    if pelada_code:
        await broadcaster.broadcast(
            pelada_code=pelada_code,
            event_type="match_saved",
            data={"match": match_dict}
        )
    return {"status": "ok", "match": match_dict}

@app.get("/api/matches")
async def list_matches(pelada_code: Optional[str] = None):
    matches = await repo.list_matches(pelada_code=pelada_code)
    return [repo._match_to_dict(m) for m in matches]

@app.delete("/api/matches")
async def clear_all_matches(pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)
    await repo.delete_all_matches(pelada_code=pelada_code)
    if pelada_code:
        await broadcaster.broadcast(
            pelada_code=pelada_code,
            event_type="matches_cleared",
            data={}
        )
    return {"status": "ok", "message": "Histórico limpo com sucesso."}

@app.delete("/api/matches/{match_id}")
async def delete_single_match(match_id: str, pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    """Exclui uma partida finalizada do banco SQLite para permitir reedição ou correção."""
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)
    success = await repo.delete_match(match_id, pelada_code=pelada_code)
    if not success:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")
    if pelada_code:
        await broadcaster.broadcast(
            pelada_code=pelada_code,
            event_type="match_deleted",
            data={"match_id": match_id}
        )
    return {"status": "ok", "message": "Partida removida do histórico com sucesso."}

class BatchAuditRequest(BaseModel):
    events: List[Dict[str, Any]] = Field(..., max_length=100)

@app.get("/api/dashboard")
async def get_dashboard(pelada_code: Optional[str] = None):
    metrics = await repo.get_dashboard_metrics(pelada_code=pelada_code)
    return metrics

# ==========================================
# ROTAS DE AUDITORIA E TELEMETRIA
# ==========================================
@app.post("/api/audit/events")
async def ingest_audit_events(req: BatchAuditRequest, request: Request):
    """Recebe eventos de telemetria e auditoria disparados pelo frontend."""
    client_ip = get_client_ip(request)
    user_agent = request.headers.get("user-agent", "unknown")[:250]
    now_brt = datetime.now(BRT).strftime("%d/%m/%Y %H:%M:%S")
    now_ts = datetime.now(timezone.utc).timestamp()

    parsed_events: List[AuditEvent] = []
    for item in req.events:
        metadata = item.get("metadata", {})
        # Sanitização: nunca permitir senhas em metadados de auditoria
        if isinstance(metadata, dict):
            metadata.pop("password", None)
            metadata_str = json.dumps(metadata, ensure_ascii=False)
        elif isinstance(metadata, str):
            metadata_str = metadata
        else:
            metadata_str = "{}"

        event = AuditEvent(
            timestamp=item.get("timestamp") or now_brt,
            created_at_ts=float(item.get("created_at_ts") or now_ts),
            pelada_code=item.get("pelada_code"),
            session_id=item.get("session_id"),
            category=item.get("category", "action"),
            action=str(item.get("action", "unknown"))[:100],
            target=str(item.get("target", ""))[:100] if item.get("target") else None,
            status=str(item.get("status", "success"))[:20],
            duration_ms=float(item.get("duration_ms", 0.0)),
            client_ip=client_ip,
            user_agent=user_agent,
            metadata_json=metadata_str
        )
        parsed_events.append(event)

    audit_service.record_events(parsed_events)
    return {"status": "ok", "ingested": len(parsed_events)}

@app.get("/api/audit/logs")
async def get_audit_logs(
    pelada_code: Optional[str] = None,
    category: Optional[str] = None,
    limit: int = 50,
    offset: int = 0
):
    """Retorna lista de logs auditados para análise e monitoramento."""
    limit = min(max(1, limit), 200)
    logs = await audit_repo.list_audit_logs(
        pelada_code=pelada_code,
        category=category,
        limit=limit,
        offset=offset
    )
    total = await audit_repo.count_audit_logs(pelada_code=pelada_code)
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "logs": [log.model_dump() for log in logs]
    }
