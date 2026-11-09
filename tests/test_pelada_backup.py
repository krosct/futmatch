"""Exportação e importação (sobrescrita) de uma pelada em arquivo JSON."""
import aiosqlite
from httpx import ASGITransport, AsyncClient

from app.main import app


PLAYERS = [{"id": f"p_{i}", "name": n, "level": 3, "is_goalkeeper": i == 1}
           for i, n in enumerate(["Ana", "Bruno", "Carla", "Diego"], start=1)]
TEAMS = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": PLAYERS[:2]},
         {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": PLAYERS[2:]}]
FIXTURES = [{"id": "f_1", "round_number": 1, "home_team_id": "team_1", "away_team_id": "team_2"}]
MATCH = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "home_team_name": "Verde",
         "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 2, "away_score": 1,
         "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
         "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}],
         "notes": "Jogo com chuva"}
MATCH_2 = {**MATCH, "id": "m_2", "home_score": 0, "away_score": 0, "notes": "Depois da exportação"}
CONFIG = {"players_per_team": 6, "match_duration_minutes": 12, "total_rounds": 2,
          "championship_type": "double", "points_win": 3, "points_draw": 1, "alarm_sound": "standard-emergency-warning-signal.mp3"}


async def _criar_pelada_com_historico(client, name="Pelada Origem"):
    code = (await client.post("/api/peladas/create", json={"name": name, "password": "senha_origem"})).json()["code"]
    res = await client.post(f"/api/peladas/{code}/sync-state",
                            json={"players": PLAYERS, "teams": TEAMS, "fixtures": FIXTURES, "config": CONFIG})
    assert res.status_code == 200
    assert (await client.post(f"/api/matches/save?pelada_code={code}", json=MATCH)).status_code == 200
    assert (await client.post(f"/api/peladas/{code}/description", json={"description": "Quadra do parque"})).status_code == 200
    return code


async def _hash_da_senha(temp_db, code):
    async with aiosqlite.connect(temp_db.db_path) as db:
        cursor = await db.execute("SELECT password_hash FROM peladas WHERE code = ?", (code,))
        return (await cursor.fetchone())[0]


async def test_export_contem_dados_completos_sem_senha(async_client):
    code = await _criar_pelada_com_historico(async_client)
    res = await async_client.get(f"/api/peladas/{code}/export")
    assert res.status_code == 200
    assert f'futmatch-{code}.json' in res.headers["content-disposition"]
    doc = res.json()

    assert doc["format"] == "futmatch-pelada" and doc["version"] == 1
    assert doc["pelada"]["code"] == code
    assert doc["pelada"]["name"] == "Pelada Origem"
    assert doc["pelada"]["description"] == "Quadra do parque"
    assert doc["pelada"]["created_at"]
    assert doc["pelada"]["config"]["players_per_team"] == 6
    assert len(doc["players"]) == 4
    assert len(doc["teams"]) == 2
    assert len(doc["fixtures"]) == 1
    assert len(doc["matches"]) == 1
    assert doc["matches"][0]["played_at"]
    assert doc["matches"][0]["notes"] == "Jogo com chuva"
    assert doc["pool"] == {"parent_code": None, "chain": []}
    assert "password_hash" not in res.text
    assert "senha_origem" not in res.text


async def test_export_pelada_inexistente_retorna_404(async_client):
    assert (await async_client.get("/api/peladas/ZZZZZ/export")).status_code == 404


async def test_import_sobrescreve_a_pelada_e_restaura_o_arquivo(async_client, temp_db):
    code = await _criar_pelada_com_historico(async_client)
    antigo = (await async_client.get(f"/api/peladas/{code}/export")).json()
    hash_antes = await _hash_da_senha(temp_db, code)

    # Muda a pelada depois da exportação: nova partida, nova descrição, novo nome
    assert (await async_client.post(f"/api/matches/save?pelada_code={code}", json=MATCH_2)).status_code == 200
    assert (await async_client.post(f"/api/peladas/{code}/description", json={"description": "Outra"})).status_code == 200

    res = await async_client.post(f"/api/peladas/{code}/import", json=antigo)
    assert res.status_code == 200
    assert res.json()["code"] == code
    assert res.json()["warnings"] == []

    restaurado = (await async_client.get(f"/api/peladas/{code}/export")).json()
    for chave in ("pelada", "pool", "players", "teams", "fixtures", "matches"):
        assert restaurado[chave] == antigo[chave], chave

    # A senha mestra não foi trocada pela importação
    assert await _hash_da_senha(temp_db, code) == hash_antes


async def test_import_exige_administracao(async_client):
    code = await _criar_pelada_com_historico(async_client)
    arquivo = (await async_client.get(f"/api/peladas/{code}/export")).json()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="https://test") as anonimo:
        res = await anonimo.post(f"/api/peladas/{code}/import", json=arquivo)
    assert res.status_code == 403


async def test_import_restaura_vinculo_de_pool(async_client):
    anterior = await _criar_pelada_com_historico(async_client, name="Pelada Anterior")
    atual = await _criar_pelada_com_historico(async_client, name="Pelada Atual")
    assert (await async_client.post(f"/api/peladas/{atual}/pool", json={"parent_code": anterior})).status_code == 200
    arquivo = (await async_client.get(f"/api/peladas/{atual}/export")).json()
    assert arquivo["pool"]["parent_code"] == anterior
    assert [c["code"] for c in arquivo["pool"]["chain"]] == [anterior]

    # Tira a pelada da pool e depois importa o arquivo: o vínculo volta
    assert (await async_client.post(f"/api/peladas/{atual}/pool", json={"parent_code": None})).status_code == 200
    res = await async_client.post(f"/api/peladas/{atual}/import", json=arquivo)
    assert res.status_code == 200
    assert not any("anterior" in w for w in res.json()["warnings"])

    exportado = (await async_client.get(f"/api/peladas/{atual}/export")).json()
    assert exportado["pool"]["parent_code"] == anterior


async def test_import_avisa_quando_pelada_anterior_nao_existe(async_client):
    code = await _criar_pelada_com_historico(async_client)
    arquivo = (await async_client.get(f"/api/peladas/{code}/export")).json()
    arquivo["pool"] = {"parent_code": "ZZZZZ", "chain": []}

    res = await async_client.post(f"/api/peladas/{code}/import", json=arquivo)
    assert res.status_code == 200
    assert any("ZZZZZ" in w for w in res.json()["warnings"])
    exportado = (await async_client.get(f"/api/peladas/{code}/export")).json()
    assert exportado["pool"]["parent_code"] == "ZZZZZ"


async def test_import_nunca_vincula_pelada_a_ela_mesma(async_client):
    code = await _criar_pelada_com_historico(async_client)
    arquivo = (await async_client.get(f"/api/peladas/{code}/export")).json()
    arquivo["pool"] = {"parent_code": code, "chain": []}

    assert (await async_client.post(f"/api/peladas/{code}/import", json=arquivo)).status_code == 200
    exportado = (await async_client.get(f"/api/peladas/{code}/export")).json()
    assert exportado["pool"]["parent_code"] is None


async def test_import_de_arquivo_de_outra_pelada_grava_na_atual(async_client):
    origem = await _criar_pelada_com_historico(async_client, name="Pelada de Origem")
    destino = await _criar_pelada_com_historico(async_client, name="Pelada Destino")
    arquivo = (await async_client.get(f"/api/peladas/{origem}/export")).json()

    res = await async_client.post(f"/api/peladas/{destino}/import", json=arquivo)
    assert res.status_code == 200
    assert res.json()["code"] == destino
    assert any(origem in w for w in res.json()["warnings"])
    exportado = (await async_client.get(f"/api/peladas/{destino}/export")).json()
    assert exportado["pelada"]["code"] == destino
    assert exportado["pelada"]["name"] == "Pelada de Origem"


async def test_import_rejeita_arquivo_invalido(async_client):
    code = await _criar_pelada_com_historico(async_client)
    base = (await async_client.get(f"/api/peladas/{code}/export")).json()

    assert (await async_client.post(f"/api/peladas/{code}/import", json={**base, "format": "outro-app"})).status_code == 422
    assert (await async_client.post(f"/api/peladas/{code}/import", json={**base, "version": 99})).status_code == 422
    assert (await async_client.post(f"/api/peladas/{code}/import",
                                    json={**base, "pelada": {**base["pelada"], "created_at": "ontem"}})).status_code == 422
    assert (await async_client.post(f"/api/peladas/{code}/import",
                                    json={**base, "matches": base["matches"] * 2})).status_code == 422


async def test_import_invalido_nao_altera_a_pelada(async_client, temp_db):
    code = await _criar_pelada_com_historico(async_client)
    base = (await async_client.get(f"/api/peladas/{code}/export")).json()
    invalido = {**base, "players": [{"id": "p bad id!", "name": "X"}], "pelada": {**base["pelada"], "name": "Trocado"}}

    assert (await async_client.post(f"/api/peladas/{code}/import", json=invalido)).status_code == 422
    atual = (await async_client.get(f"/api/peladas/{code}/export")).json()
    assert atual["pelada"]["name"] == "Pelada Origem"
    assert len(atual["matches"]) == 1
