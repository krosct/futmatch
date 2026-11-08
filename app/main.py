from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
import os
import random
import string
import hashlib
import time

from app.domain.models import Player, Team, Match, SessionConfig, PeladaSession
from app.domain.matchmaker import MatchmakerService
from app.adapters.sqlite_repo import SQLiteMatchRepository

BRT = timezone(timedelta(hours=-3))

app = FastAPI(title="FutMatch API", description="Organizador Moderno de Peladas e Campeonatos")

repo = SQLiteMatchRepository("futmatch.db")

# Rate limit de 15 segundos para "assumir administração" (por IP ou por pelada)
# Estrutura: { f"{ip}:{code}": timestamp }
LOGIN_ATTEMPTS: Dict[str, float] = {}

def hash_password(password: str) -> str:
    return hashlib.sha256(password.strip().encode("utf-8")).hexdigest()

def generate_random_code(length: int = 5) -> str:
    # Código alfanumérico sem caracteres confusos (0/O, 1/I)
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(random.choice(chars) for _ in range(length))

# Serve arquivos estáticos (CSS, JS, assets)
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.on_event("startup")
async def on_startup():
    await repo.init_db()

# DTOs
class CreatePeladaRequest(BaseModel):
    name: Optional[str] = "Pelada dos Amigos"
    password: Optional[str] = ""

class SetPasswordRequest(BaseModel):
    password: str

class ClaimAdminRequest(BaseModel):
    password: str

class SetPoolRequest(BaseModel):
    parent_code: Optional[str] = None

class SyncPeladaStateRequest(BaseModel):
    players: List[Dict[str, Any]] = []
    teams: List[Dict[str, Any]] = []
    fixtures: List[Dict[str, Any]] = []
    config: Optional[Dict[str, Any]] = None

class BalanceTeamsRequest(BaseModel):
    players: List[Dict[str, Any]]
    players_per_team: int = 5

class GenerateScheduleRequest(BaseModel):
    teams: List[Dict[str, Any]]
    rounds: int = 1

class MatchSaveRequest(BaseModel):
    id: str
    round_number: int
    home_team_id: str
    home_team_name: str
    away_team_id: str
    away_team_name: str
    home_score: int
    away_score: int
    home_players: List[Dict[str, Any]]
    away_players: List[Dict[str, Any]]
    events: List[Dict[str, Any]] = []
    notes: Optional[str] = ""

class ConfigDTO(BaseModel):
    players_per_team: int = 5
    match_duration_minutes: int = 10
    total_rounds: int = 1
    championship_type: Optional[str] = "single"
    points_win: int = 3
    points_draw: int = 1

# Rotas de Peladas (Multi-pelada)
@app.post("/api/peladas/create")
async def create_pelada(req: CreatePeladaRequest):
    """Cria uma nova pelada com código único de 5 caracteres."""
    for _ in range(10):
        code = generate_random_code(5)
        existing = await repo.get_pelada(code)
        if not existing:
            break
    else:
        raise HTTPException(status_code=500, detail="Erro ao gerar código único para a pelada.")

    pwd_hash = hash_password(req.password) if req.password else ""
    pelada = await repo.create_pelada(code=code, password_hash=pwd_hash, name=req.name or "Pelada dos Amigos")
    return {
        "status": "ok",
        "code": pelada.code,
        "name": pelada.name,
        "created_at": pelada.created_at,
        "has_password": bool(pwd_hash)
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
async def link_pelada_pool(code: str, req: SetPoolRequest):
    """Vincula a pelada atual a uma pelada anterior na corrente (pool)."""
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada atual não encontrada.")

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
async def set_pelada_password(code: str, req: SetPasswordRequest):
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")
    if not req.password or len(req.password.strip()) < 3:
        raise HTTPException(status_code=400, detail="A senha deve ter no mínimo 3 caracteres.")

    # Se já tiver senha configurada, só pode atualizar se estiver definindo pela 1ª vez ou autenticado
    pwd_hash = hash_password(req.password)
    await repo.update_pelada_password(code, pwd_hash)
    return {"status": "ok", "message": "Senha mestra da pelada definida com sucesso!"}

@app.post("/api/peladas/{code}/claim-admin")
async def claim_admin(code: str, req: ClaimAdminRequest, request: Request):
    """Permite assumir administração da pelada digitando a senha, com rate limit de 15 segundos."""
    client_ip = request.client.host if request.client else "unknown"
    rate_key = f"{client_ip}:{code.upper()}"
    now = time.time()

    last_attempt = LOGIN_ATTEMPTS.get(rate_key)
    if last_attempt:
        elapsed = now - last_attempt
        if elapsed < 15:
            remaining = int(15 - elapsed) + 1
            raise HTTPException(
                status_code=429,
                detail=f"Muitas tentativas. Aguarde {remaining} segundo(s) antes de tentar novamente."
            )

    LOGIN_ATTEMPTS[rate_key] = now

    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")

    if not pelada.password_hash:
        raise HTTPException(status_code=400, detail="Esta pelada ainda não possui senha cadastrada.")

    submitted_hash = hash_password(req.password)
    if submitted_hash != pelada.password_hash:
        raise HTTPException(status_code=401, detail="Senha incorreta para esta pelada.")

    return {
        "status": "ok",
        "message": "Administração assumida com sucesso! Você agora é o líder desta pelada.",
        "admin_token": submitted_hash
    }

@app.post("/api/peladas/{code}/sync-state")
async def sync_pelada_state(code: str, req: SyncPeladaStateRequest):
    pelada = await repo.get_pelada(code)
    if not pelada:
        raise HTTPException(status_code=404, detail="Pelada não encontrada.")
    config = req.config or pelada.config or {}
    await repo.save_pelada_state(code, req.players, req.teams, req.fixtures, config)
    return {"status": "ok"}

# Rotas Principais
@app.get("/", response_class=HTMLResponse)
async def serve_home():
    return FileResponse("static/index.html")

@app.get("/manifest.json")
async def serve_manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json")

@app.get("/sw.js")
async def serve_service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript", headers={"Service-Worker-Allowed": "/"})

@app.get("/api/config")
async def get_config(pelada_code: Optional[str] = None):
    cfg = await repo.get_config(pelada_code)
    return cfg.__dict__

@app.post("/api/config")
async def update_config(req: ConfigDTO, pelada_code: Optional[str] = None):
    cfg = SessionConfig(**req.dict())
    await repo.save_config(cfg, pelada_code)
    return {"status": "ok", "config": cfg.__dict__}

@app.post("/api/balance-teams")
async def balance_teams(req: BalanceTeamsRequest):
    """Equilibra times a partir da lista de jogadores recebida."""
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
async def save_match_result(req: MatchSaveRequest, pelada_code: Optional[str] = None):
    """Salva o resultado final de uma partida com data e hora de Brasília e histórico detalhado."""
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
async def clear_all_matches(pelada_code: Optional[str] = None):
    await repo.delete_all_matches(pelada_code=pelada_code)
    return {"status": "ok", "message": "Histórico limpo com sucesso."}

@app.delete("/api/matches/{match_id}")
async def delete_single_match(match_id: str, pelada_code: Optional[str] = None):
    """Exclui uma partida finalizada do banco SQLite para permitir reedição ou correção."""
    success = await repo.delete_match(match_id, pelada_code=pelada_code)
    if not success:
        raise HTTPException(status_code=404, detail="Partida não encontrada.")
    return {"status": "ok", "message": "Partida removida do histórico com sucesso."}

@app.get("/api/dashboard")
async def get_dashboard(pelada_code: Optional[str] = None):
    metrics = await repo.get_dashboard_metrics(pelada_code=pelada_code)
    return metrics

