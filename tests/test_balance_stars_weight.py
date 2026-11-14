"""Peso das estrelas no sorteio: % configurado pelo admin muda o nível efetivo usado em /api/balance-teams."""
from app.domain.matchmaker import MatchmakerService
from tests.pool_helpers import vincular_pool


def test_stars_pct_default_keeps_40_60_formula():
    stats = {"matches": 10, "wins": 8, "draws": 1, "losses": 1, "goals": 12}
    assert MatchmakerService.calculate_effective_level(base_level=3, stats=stats) == 3.45


def test_stars_pct_extremes_use_only_stars_or_only_performance():
    stats = {"matches": 3, "wins": 3, "draws": 0, "losses": 0, "goals": 3}  # performance = 4.0
    assert MatchmakerService.calculate_effective_level(1, stats, stars_pct=100) == 1.0
    assert MatchmakerService.calculate_effective_level(1, stats, stars_pct=0) == 4.0
    assert MatchmakerService.calculate_effective_level(1, stats, stars_pct=40) == 2.8


async def test_balance_uses_pelada_stars_pct_and_history(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "Peso", "password": "senha1"})).json()["code"]
    players = [{"id": "p_1", "name": "Ana", "level": 1, "is_goalkeeper": False},
               {"id": "p_2", "name": "Bruno", "level": 5, "is_goalkeeper": False},
               {"id": "p_3", "name": "Carla", "level": 3, "is_goalkeeper": False},
               {"id": "p_4", "name": "Diego", "level": 3, "is_goalkeeper": False}]
    teams = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": players[:2]},
             {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": players[2:]}]
    assert (await async_client.post(f"/api/peladas/{code}/sync-state",
                                    json={"players": players, "teams": teams, "fixtures": []})).status_code == 200

    # Ana vence 3 partidas e marca 1 gol em cada uma (3 gols em 3 jogos).
    # O histórico só conta partidas que estão na tabela da pelada (fixtures), por isso sincroniza com elas.
    fixtures = []
    for i in range(1, 4):
        match = {"id": f"m_{i}", "round_number": i, "home_team_id": "team_1", "home_team_name": "Verde",
                 "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 1, "away_score": 0,
                 "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
                 "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}],
                 "finished": True}
        assert (await async_client.post(f"/api/matches/save?pelada_code={code}", json=match)).status_code == 200
        fixtures.append(match)
    assert (await async_client.post(f"/api/peladas/{code}/sync-state",
                                    json={"players": players, "teams": teams, "fixtures": fixtures})).status_code == 200

    async def efetivos(pct: int) -> dict:
        cfg = (await async_client.get(f"/api/config?pelada_code={code}")).json()
        cfg["balance_stars_pct"] = pct
        assert (await async_client.post(f"/api/config?pelada_code={code}", json=cfg)).status_code == 200
        res = await async_client.post("/api/balance-teams",
                                      json={"players": players, "players_per_team": 2, "pelada_code": code})
        assert res.status_code == 200
        return {p["name"]: p["effective_level"] for t in res.json() for p in t["players"]}

    padrao = await efetivos(40)
    assert padrao["Ana"] == 2.8   # 40% de 1 estrela + 60% de performance 4.0
    assert padrao["Bruno"] == 5.0  # sem histórico: mantém as estrelas

    so_estrelas = await efetivos(100)
    assert so_estrelas["Ana"] == 1.0

    so_historico = await efetivos(0)
    assert so_historico["Ana"] == 4.0


async def test_config_rejects_stars_pct_out_of_range(async_client):
    code = (await async_client.post("/api/peladas/create", json={"name": "Limite", "password": "senha1"})).json()["code"]
    cfg = (await async_client.get(f"/api/config?pelada_code={code}")).json()
    cfg["balance_stars_pct"] = 150
    assert (await async_client.post(f"/api/config?pelada_code={code}", json=cfg)).status_code == 422


def test_one_match_already_counts_for_effective_level():
    stats = {"matches": 1, "wins": 1, "draws": 0, "losses": 0, "goals": 1}  # performance = 4.0
    assert MatchmakerService.calculate_effective_level(1, stats) == 2.8


async def test_balance_counts_matches_from_linked_pool_pelada(async_client):
    """Partidas de uma pelada anterior encadeada (pool) entram no histórico do sorteio da pelada atual."""
    anterior = (await async_client.post("/api/peladas/create", json={"name": "Anterior", "password": "senha1"})).json()["code"]
    atual = (await async_client.post("/api/peladas/create", json={"name": "Atual", "password": "senha1"})).json()["code"]
    players = [{"id": "p_1", "name": "Ana", "level": 1, "is_goalkeeper": False},
               {"id": "p_3", "name": "Carla", "level": 3, "is_goalkeeper": False}]
    teams = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": players[:1]},
             {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": players[1:]}]
    # Uma única partida na pelada anterior: Ana venceu e marcou 1 gol
    partida = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "home_team_name": "Verde",
               "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 1, "away_score": 0,
               "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
               "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}],
               "finished": True}
    assert (await async_client.post(f"/api/matches/save?pelada_code={anterior}", json=partida)).status_code == 200
    assert (await async_client.post(f"/api/peladas/{anterior}/sync-state",
                                    json={"players": players, "teams": teams, "fixtures": [partida]})).status_code == 200
    assert (await async_client.post(f"/api/peladas/{atual}/sync-state",
                                    json={"players": players, "teams": teams, "fixtures": []})).status_code == 200
    assert (await vincular_pool(async_client, atual, anterior)).status_code == 200

    res = await async_client.post("/api/balance-teams",
                                  json={"players": players, "players_per_team": 2, "pelada_code": atual})
    assert res.status_code == 200
    efetivos = {p["name"]: p["effective_level"] for t in res.json() for p in t["players"]}
    assert efetivos["Ana"] == 2.8  # 1 partida da pool já pesa: 40% de 1 estrela + 60% de performance 4.0
