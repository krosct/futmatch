import pytest
import asyncio
from httpx import AsyncClient

async def test_security_headers_middleware(async_client: AsyncClient):
    """Verifica todos os headers de segurança HTTP obrigatórios nas respostas."""
    res = await async_client.get("/healthz")
    assert res.status_code == 200
    assert res.headers.get("x-content-type-options") == "nosniff"
    assert res.headers.get("x-frame-options") == "SAMEORIGIN"
    assert res.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert "geolocation=()" in res.headers.get("permissions-policy", "")
    assert res.headers.get("cross-origin-opener-policy") == "same-origin"

async def test_payload_size_limit(async_client: AsyncClient):
    """Garante bloqueio de payloads excessivos com código HTTP 413."""
    huge_data = {"name": "A" * (6 * 1024 * 1024)}
    res = await async_client.post("/api/peladas/create", json=huge_data)
    assert res.status_code == 413

async def test_create_pelada_flow(async_client: AsyncClient):
    """Testa criação de pelada com e sem senha mestra e validação de nome obrigatório."""
    # Validação: nome vazio ou com menos de 3 caracteres deve falhar com 422
    res_empty = await async_client.post("/api/peladas/create", json={"name": ""})
    assert res_empty.status_code == 422

    res_short = await async_client.post("/api/peladas/create", json={"name": "AB"})
    assert res_short.status_code == 422

    res_spaces = await async_client.post("/api/peladas/create", json={"name": "   "})
    assert res_spaces.status_code == 422

    # Senha mestra é obrigatória na criação
    res1 = await async_client.post("/api/peladas/create", json={"name": "Pelada Aberta"})
    assert res1.status_code == 422
    res_short_pwd = await async_client.post("/api/peladas/create", json={"name": "Pelada Aberta", "password": "ab"})
    assert res_short_pwd.status_code == 422

    res1 = await async_client.post("/api/peladas/create", json={"name": "Pelada Aberta", "password": "senha_aberta"})
    assert res1.status_code == 200
    d1 = res1.json()
    assert d1["name"] == "Pelada Aberta"
    assert d1["has_password"] is True
    assert d1["admin_token"] != ""

    # Com senha
    res2 = await async_client.post("/api/peladas/create", json={"name": "Pelada Fechada", "password": "senha_mestra"})
    assert res2.status_code == 200
    d2 = res2.json()
    assert d2["name"] == "Pelada Fechada"
    assert d2["has_password"] is True
    assert d2["admin_token"] != ""

async def test_protected_routes_authorization(async_client: AsyncClient):
    """Verifica proteção de rotas de escrita por X-Admin-Token."""
    res_create = await async_client.post("/api/peladas/create", json={"name": "Privada", "password": "lider_password"})
    data = res_create.json()
    code = data["code"]
    token = data["admin_token"]

    # Tentativa de sincronização sem token
    res_sync_unauth = await async_client.post(f"/api/peladas/{code}/sync-state", json={"players": []})
    assert res_sync_unauth.status_code == 403

    # Tentativa de sincronização com token válido
    res_sync_auth = await async_client.post(
        f"/api/peladas/{code}/sync-state",
        json={"players": [{"id": "p1", "name": "Pelé"}]},
        headers={"X-Admin-Token": token}
    )
    assert res_sync_auth.status_code == 200

    # Tentativa de salvar partida sem token
    match_payload = {
        "id": "m1",
        "round_number": 1,
        "home_team_id": "t1",
        "home_team_name": "A",
        "away_team_id": "t2",
        "away_team_name": "B",
        "home_score": 1,
        "away_score": 0,
        "home_players": [],
        "away_players": [],
        "events": []
    }
    res_save_unauth = await async_client.post(f"/api/matches/save?pelada_code={code}", json=match_payload)
    assert res_save_unauth.status_code == 403

    # Salvar partida com token
    res_save_auth = await async_client.post(
        f"/api/matches/save?pelada_code={code}",
        json=match_payload,
        headers={"X-Admin-Token": token}
    )
    assert res_save_auth.status_code == 200

    # Limpar histórico sem token
    res_clear_unauth = await async_client.delete(f"/api/matches?pelada_code={code}")
    assert res_clear_unauth.status_code == 403

    # Limpar histórico com token
    res_clear_auth = await async_client.delete(f"/api/matches?pelada_code={code}", headers={"X-Admin-Token": token})
    assert res_clear_auth.status_code == 200

async def test_claim_admin_and_rate_limit(async_client: AsyncClient):
    """Testa assumir liderança com senha e acionamento de rate limit em tentativas rápidas."""
    res_create = await async_client.post("/api/peladas/create", json={"name": "Claim Pelada", "password": "senhacorreta123"})
    code = res_create.json()["code"]

    # Tentativa com senha errada
    res_wrong = await async_client.post(f"/api/peladas/{code}/claim-admin", json={"password": "senhaerrada"})
    assert res_wrong.status_code == 401

    # Segunda tentativa imediata deve disparar 429
    res_rate = await async_client.post(f"/api/peladas/{code}/claim-admin", json={"password": "senhacorreta123"})
    assert res_rate.status_code == 429

async def test_balance_and_schedule_endpoints(async_client: AsyncClient):
    """Testa endpoints utilitários de sorteio de times e confrontos."""
    players = [
        {"id": "1", "name": "P1", "level": 4, "is_goalkeeper": False},
        {"id": "2", "name": "P2", "level": 3, "is_goalkeeper": False},
        {"id": "3", "name": "P3", "level": 3, "is_goalkeeper": True},
        {"id": "4", "name": "P4", "level": 4, "is_goalkeeper": True}
    ]
    res_balance = await async_client.post("/api/balance-teams", json={"players": players, "players_per_team": 2})
    assert res_balance.status_code == 200
    teams = res_balance.json()
    assert len(teams) == 2

    res_sched = await async_client.post("/api/generate-schedule", json={"teams": teams, "rounds": 1})
    assert res_sched.status_code == 200
    fixtures = res_sched.json()
    assert len(fixtures) >= 1

async def test_audio_catalog_endpoint(async_client: AsyncClient):
    """Verifica se o catálogo de áudios escaneia dinamicamente os diretórios de música e efeitos."""
    res = await async_client.get("/api/audio-catalog")
    assert res.status_code == 200
    data = res.json()
    assert "abertura" in data
    assert "efeitos" in data
    assert isinstance(data["abertura"], list)
    assert isinstance(data["efeitos"], list)
    assert len(data["abertura"]) > 0
    assert len(data["efeitos"]) > 0
    assert all(item.startswith("/static/music/") for item in data["abertura"])
    assert all(item.startswith("/static/sounds/") for item in data["efeitos"])

async def test_duplicate_player_names_rejected(async_client: AsyncClient):
    """Garante que a sincronização de estado rejeita jogadores com nomes duplicados."""
    res_create = await async_client.post("/api/peladas/create", json={"name": "Pelada Unicidade", "password": "senha_teste"})
    code = res_create.json()["code"]
    token = res_create.json()["admin_token"]

    duplicate_players = [
        {"id": "p1", "name": "Neymar Jr", "level": 5, "is_goalkeeper": False},
        {"id": "p2", "name": "neymar jr", "level": 4, "is_goalkeeper": False}
    ]

    res_sync = await async_client.post(
        f"/api/peladas/{code}/sync-state",
        json={"players": duplicate_players},
        headers={"X-Admin-Token": token}
    )
    assert res_sync.status_code == 400
    assert "Não é permitido adicionar jogadores duplicados" in res_sync.json()["detail"]

async def test_broadcaster_pub_sub():
    """Garante que o serviço broadcaster de pub/sub assíncrono entrega mensagens corretamente."""
    from app.services.broadcaster import broadcaster
    queue = await broadcaster.subscribe("TESTCODE")
    try:
        await broadcaster.broadcast("TESTCODE", "state_updated", {"teams": ["A", "B"]})
        item = await asyncio.wait_for(queue.get(), timeout=1.0)
        assert item["event"] == "state_updated"
        assert item["pelada_code"] == "TESTCODE"
        assert item["data"]["teams"] == ["A", "B"]
    finally:
        await broadcaster.unsubscribe("TESTCODE", queue)

async def test_pelada_description_and_pool_start_date(async_client: AsyncClient):
    """Descrição é salva pelo líder, aparece nas consultas e a data de início segue a pelada mais antiga da corrente."""
    res_create = await async_client.post("/api/peladas/create", json={"name": "Pelada Teste", "password": "senha_teste"})
    assert res_create.status_code == 200
    data = res_create.json()
    code = data["code"]
    token = data["admin_token"]
    assert data["description"] == ""
    assert data["pool_started_at"]
    assert data["has_password"] is True

    # O líder (com token) salva a descrição
    res_set = await async_client.post(f"/api/peladas/{code}/description", json={"description": "Quadra do parque"}, headers={"X-Admin-Token": token})
    assert res_set.status_code == 200
    assert res_set.json()["description"] == "Quadra do parque"

    info = await async_client.get(f"/api/peladas/{code}")
    assert info.json()["description"] == "Quadra do parque"
    assert info.json()["pool_started_at"] == data["pool_started_at"]

    # Espaços excessivos são normalizados e descrição longa é rejeitada
    res_spaces = await async_client.post(f"/api/peladas/{code}/description", json={"description": "  Quadra   do  parque  "}, headers={"X-Admin-Token": token})
    assert res_spaces.json()["description"] == "Quadra do parque"
    res_long = await async_client.post(f"/api/peladas/{code}/description", json={"description": "A" * 141}, headers={"X-Admin-Token": token})
    assert res_long.status_code == 422
