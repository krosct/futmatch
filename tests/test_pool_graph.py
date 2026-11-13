"""Grafo de pools: várias pools por pelada, ciclos e caminhos repetidos sem contar métricas duas vezes."""
import os
import sqlite3
import tempfile

from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.domain.pool_graph import MAX_POOLS_POR_PELADA, pool_chain

MATCH = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "home_team_name": "Verde",
         "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 2, "away_score": 1,
         "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
         "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}],
         "finished": True}
FIXTURES = [{"id": "m_1", "round_number": 1, "home_team_id": "team_1", "away_team_id": "team_2"}]
PLAYERS = [{"id": "p_1", "name": "Ana", "level": 3}, {"id": "p_3", "name": "Carla", "level": 3}]
TEAMS = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": [{"id": "p_1", "name": "Ana", "level": 3}]},
         {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": [{"id": "p_3", "name": "Carla", "level": 3}]}]


# ---------- Domínio puro ----------

def test_chain_do_losango_conta_cada_pelada_uma_vez():
    # A <- B, A <- C, B <- D, C <- D: D é alcançada por dois caminhos
    parents = {"A": ["B", "C"], "B": ["D"], "C": ["D"]}
    assert pool_chain("A", parents) == ["A", "B", "C", "D"]


def test_chain_com_ciclo_termina_e_nao_repete():
    assert pool_chain("A", {"A": ["B"], "B": ["A"]}) == ["A", "B"]
    assert pool_chain("A", {"A": ["A"]}) == ["A"]


def test_chain_de_pelada_sem_pai_e_ela_mesma():
    assert pool_chain("X", {}) == ["X"]


def test_limite_de_pools_definido_uma_vez():
    assert MAX_POOLS_POR_PELADA == 10


# ---------- Adaptador SQLite ----------

async def test_pelada_aceita_varias_pools_e_substitui_a_lista(temp_db: SQLiteMatchRepository):
    for code in ("PA", "PB", "PC"):
        await temp_db.create_pelada(code, "", code)
    await temp_db.set_pelada_parent_codes("PC", ["PA", "PB"])
    assert await temp_db.get_pelada_parent_codes("PC") == ["PA", "PB"]
    assert set(await temp_db.get_pelada_chain_codes("PC")) == {"PC", "PA", "PB"}

    await temp_db.set_pelada_parent_codes("PC", ["PB"])
    assert await temp_db.get_pelada_parent_codes("PC") == ["PB"]
    assert await temp_db.get_pelada_chain_codes("PC") == ["PC", "PB"]


async def test_chain_do_adaptador_com_ciclo_no_grafo_nao_duplica(temp_db: SQLiteMatchRepository):
    await temp_db.create_pelada("CX", "", "X")
    await temp_db.create_pelada("CY", "", "Y")
    await temp_db.set_pelada_parent_codes("CX", ["CY"])
    await temp_db.set_pelada_parent_codes("CY", ["CX"])  # ciclo gravado diretamente no banco
    assert await temp_db.get_pelada_chain_codes("CX") == ["CX", "CY"]


def test_migracao_converte_parent_code_antigo_em_vinculo():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE peladas (code TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
                name TEXT, players TEXT DEFAULT '[]', teams TEXT DEFAULT '[]', fixtures TEXT DEFAULT '[]',
                config TEXT DEFAULT '{}', parent_code TEXT DEFAULT NULL, description TEXT DEFAULT '');
            INSERT INTO peladas (code, password_hash, created_at, name, parent_code)
                VALUES ('NOVA', 'h', '01/01/2026 10:00:00', 'Nova', 'antiga');
            INSERT INTO peladas (code, password_hash, created_at, name)
                VALUES ('ANTIGA', 'h', '01/01/2026 09:00:00', 'Antiga');
        """)
        conn.commit()
        conn.close()

        import asyncio
        repo = SQLiteMatchRepository(path)
        asyncio.run(repo.init_db())

        assert asyncio.run(repo.get_pelada_parent_codes("NOVA")) == ["ANTIGA"]
        conn = sqlite3.connect(path)
        colunas = [linha[1] for linha in conn.execute("PRAGMA table_info(peladas)")]
        conn.close()
        assert "parent_code" not in colunas
    finally:
        os.remove(path)


# ---------- API: vínculo, ciclo e métricas ----------

async def _pelada(client, nome):
    return (await client.post("/api/peladas/create", json={"name": nome, "password": "senha1"})).json()["code"]


async def _vincular(client, atual, pais):
    return await client.post(f"/api/peladas/{atual}/pool", json={"parent_codes": pais, "links": [], "renames": []})


async def test_api_aceita_duas_pools_sem_sobrescrever(async_client):
    a = await _pelada(async_client, "Pool A")
    b = await _pelada(async_client, "Pool B")
    atual = await _pelada(async_client, "Atual")
    assert (await _vincular(async_client, atual, [a])).status_code == 200
    res = await _vincular(async_client, atual, [a, b])
    assert res.status_code == 200
    info = (await async_client.get(f"/api/peladas/{atual}")).json()
    assert info["parent_codes"] == [a, b]
    assert set(info["chain_codes"]) == {atual, a, b}


async def test_api_recusa_ciclo_entre_pools(async_client):
    x = await _pelada(async_client, "Pelada Xis")
    y = await _pelada(async_client, "Pelada Ipsilon")
    assert (await _vincular(async_client, y, [x])).status_code == 200  # Y aponta para X
    res = await _vincular(async_client, x, [y])                           # X apontaria para Y: ciclo
    assert res.status_code == 400
    assert "ciclo" in res.json()["detail"]


async def test_api_recusa_mais_pools_que_o_limite(async_client):
    atual = await _pelada(async_client, "Atual")
    # O limite é checado antes da existência das pools, então códigos fictícios bastam
    pais = [f"P{i:04d}" for i in range(MAX_POOLS_POR_PELADA + 1)]
    assert (await _vincular(async_client, atual, pais)).status_code == 422  # limite no schema


async def test_losango_conta_partida_da_pool_comum_uma_vez(async_client):
    # D tem uma partida. A <- B, A <- C, B <- D, C <- D: D chega a A por dois caminhos.
    d = await _pelada(async_client, "Pelada Dedo")
    assert (await async_client.post(f"/api/peladas/{d}/sync-state",
                                    json={"players": PLAYERS, "teams": TEAMS, "fixtures": FIXTURES})).status_code == 200
    assert (await async_client.post(f"/api/matches/save?pelada_code={d}", json=MATCH)).status_code == 200
    b = await _pelada(async_client, "Pelada Bola")
    c = await _pelada(async_client, "Pelada Cafe")
    a = await _pelada(async_client, "Pelada Area")
    assert (await _vincular(async_client, b, [d])).status_code == 200
    assert (await _vincular(async_client, c, [d])).status_code == 200
    assert (await _vincular(async_client, a, [b, c])).status_code == 200

    resumo = (await async_client.get(f"/api/dashboard?pelada_code={a}")).json()["summary"]
    assert resumo["pool_count"] == 4          # A, B, C, D sem repetição
    assert resumo["total_matches"] == 1       # a partida de D entra uma vez, não duas
    assert resumo["total_goals"] == 3       # placar 2x1 da partida, contado uma vez


async def test_remover_uma_pool_desfaz_so_os_vinculos_dela(async_client):
    a = await _pelada(async_client, "Pool Antiga Um")
    b = await _pelada(async_client, "Pool Antiga Dois")
    atual = await _pelada(async_client, "Pelada Corrente")
    assert (await async_client.post(f"/api/peladas/{a}/sync-state",
                                    json={"players": [{"id": "a1", "name": "Ana", "level": 3}], "teams": [], "fixtures": []})).status_code == 200
    assert (await async_client.post(f"/api/peladas/{b}/sync-state",
                                    json={"players": [{"id": "b1", "name": "Bruno", "level": 3}], "teams": [], "fixtures": []})).status_code == 200
    assert (await async_client.post(f"/api/peladas/{atual}/sync-state", json={
        "players": [{"id": "x1", "name": "Ana", "level": 3}, {"id": "x2", "name": "Bruno", "level": 3}],
        "teams": [], "fixtures": []})).status_code == 200
    vinculos = [{"player_id": "x1", "pool_player_id": "a1"}, {"player_id": "x2", "pool_player_id": "b1"}]
    res = await async_client.post(f"/api/peladas/{atual}/pool", json={"parent_codes": [a, b], "links": vinculos, "renames": []})
    assert res.status_code == 200

    res = await async_client.delete(f"/api/peladas/{atual}/pool/{a}")
    assert res.status_code == 200
    assert res.json()["parent_codes"] == [b]
    assert res.json()["chain_codes"] == [atual, b]
    candidatos = (await async_client.get(f"/api/peladas/{atual}/pool-candidates", params={"parent_code": [b]})).json()
    assert candidatos["links"] == {"x2": "b1"}  # o vínculo com Ana (pool A) saiu; o de Bruno ficou

    assert (await async_client.delete(f"/api/peladas/{atual}/pool/{a}")).status_code == 404
