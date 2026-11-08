from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
import os
import random
import string
import time

from app.domain.models import Player, Team, Match, SessionConfig, PeladaSession
from app.domain.matchmaker import MatchmakerService
from app.domain.security import (
    hash_password,
    verify_password,
    is_legacy_hash,
    create_admin_token,
    verify_admin_token,
    rate_limiter
)
from app.adapters.sqlite_repo import SQLiteMatchRepository

BRT = timezone(timedelta(hours=-3))

app = FastAPI(title="FutMatch API", description="Organizador Moderno de Peladas e Campeonatos")

# ==========================================
# MIDDLEWARE: HEADERS DE SEGURANÇA HTTP
# ==========================================
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
        if not x_admin_token or not verify_admin_token(x_admin_token, pelada_code):
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

# DTOs com validação de limites de tamanho
class CreatePeladaRequest(BaseModel):
    name: Optional[str] = Field("Pelada dos Amigos", max_length=60)
    password: Optional[str] = Field("", max_length=64)

class SetPasswordRequest(BaseModel):
    password: str = Field(..., min_length=3, max_length=64)

class ClaimAdminRequest(BaseModel):
    password: str = Field(..., max_length=64)

class SetPoolRequest(BaseModel):
    parent_code: Optional[str] = Field(None, max_length=10)

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

    pwd_hash = hash_password(req.password) if req.password else ""
    pelada = await repo.create_pelada(code=code, password_hash=pwd_hash, name=req.name or "Pelada dos Amigos")
    admin_token = create_admin_token(code)

    return {
        "status": "ok",
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
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
        "has_password": bool(pelada.password_hash),
        "players": pelada.players,
        "teams": pelada.teams,
        "fixtures": pelada.fixtures,
        "config": pelada.config,
        "parent_code": pelada.parent_code,
        "chain_codes": chain
    }

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
    return {
        "status": "ok",
        "message": f"Pool de peladas atualizado com sucesso! ({len(updated_chain)} pelada(s) encadeada(s))",
        "parent_code": parent,
        "chain_codes": updated_chain
    }

@app.post("/api/peladas/{code}/set-password")
async def set_pelada_password(code: str, req: SetPasswordRequest, x_admin_token: Optional[str] = Header(None)):
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")
    if not req.password or len(req.password.strip()) < 3:
        raise HTTPException(status_code=400, detail="A senha deve ter no mínimo 3 caracteres.")

    # Se a pelada já tem senha, exige que o usuário já seja admin
    if pelada.password_hash and not verify_admin_token(x_admin_token, code):
        raise HTTPException(status_code=403, detail="Não autorizado: apenas o administrador atual pode alterar a senha mestra.")

    # Gera hash seguro PBKDF2 com salt
    pwd_hash = hash_password(req.password)
    await repo.update_pelada_password(code, pwd_hash)

    # Gera/renova token administrativo para o líder
    admin_token = create_admin_token(code)
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
    await repo.save_pelada_state(code, req.players, req.teams, req.fixtures, config)
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
    """Retorna dinamicamente todas as músicas e efeitos presentes no disco."""
    return {
        "abertura": scan_audio_directory("music"),
        "efeitos": scan_audio_directory("sounds")
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
        teams.append(Team(id=t["id"], name=t["name"], color=t.get("color", "#10b981"), players=plist))

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
    return {"status": "ok", "match": repo._match_to_dict(match)}

@app.get("/api/matches")
async def list_matches(pelada_code: Optional[str] = None):
    matches = await repo.list_matches(pelada_code=pelada_code)
    return [repo._match_to_dict(m) for m in matches]

@app.delete("/api/matches")
async def clear_all_matches(pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)
    await repo.delete_all_matches(pelada_code=pelada_code)
    return {"status": "ok", "message": "Histórico limpo com sucesso."}

@app.delete("/api/matches/{match_id}")
async def delete_single_match(match_id: str, pelada_code: Optional[str] = None, x_admin_token: Optional[str] = Header(None)):
    """Exclui uma partida finalizada do banco SQLite para permitir reedição ou correção."""
    if pelada_code:
        await require_admin_permission(pelada_code, x_admin_token)
    success = await repo.delete_match(match_id, pelada_code=pelada_code)
    if not success:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")
    return {"status": "ok", "message": "Partida removida do histórico com sucesso."}

@app.get("/api/dashboard")
async def get_dashboard(pelada_code: Optional[str] = None):
    metrics = await repo.get_dashboard_metrics(pelada_code=pelada_code)
    return metrics
