"""Fluxo completo de uma pelada pela API: criação, escalação, partida, painel, configuração, logout e retomada."""
from httpx import ASGITransport, AsyncClient

from app.domain import security
from app.main import app, rate_limiter


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


async def test_full_pelada_lifecycle(async_client):
    lider = async_client
    code = (await lider.post("/api/peladas/create", json={"name": "Fluxo Completo", "password": "senha1"})).json()["code"]

    players = [{"id": f"p_{i}", "name": n, "level": 3, "is_goalkeeper": i == 0}
               for i, n in enumerate(["Ana", "Bruno", "Carla", "Diego"], start=1)]
    teams = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": players[:2]},
             {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": players[2:]}]
    assert (await lider.post(f"/api/peladas/{code}/sync-state",
                             json={"players": players, "teams": teams, "fixtures": []})).status_code == 200

    match = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "home_team_name": "Verde",
             "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 2, "away_score": 1,
             "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
             "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}]}
    assert (await lider.post(f"/api/matches/save?pelada_code={code}", json=match)).status_code == 200

    painel = (await lider.get(f"/api/dashboard?pelada_code={code}")).json()
    assert painel["summary"]["total_matches"] == 1
    assert painel["summary"]["total_goals"] == 3
    assert painel["top_scorers"][0]["name"] == "Ana"

    # Espectador (sem cookie) lê, mas não escreve
    async with _client() as espectador:
        assert (await espectador.get(f"/api/matches?pelada_code={code}")).status_code == 200
        assert (await espectador.delete(f"/api/matches?pelada_code={code}")).status_code == 403
        assert (await espectador.get(f"/api/peladas/{code}")).json()["is_admin"] is False

    # Líder sai; a sessão deve ser encerrada no servidor
    assert (await lider.post(f"/api/peladas/{code}/logout")).status_code == 200
    assert (await lider.post(f"/api/peladas/{code}/description", json={"description": "x"})).status_code == 403

    # Líder volta com a senha e continua operando
    rate_limiter._history.clear()
    retorno = await lider.post(f"/api/peladas/{code}/claim-admin", json={"password": "senha1"})
    assert retorno.status_code == 200
    assert (await lider.post(f"/api/peladas/{code}/description", json={"description": "Quadra do parque"})).status_code == 200
    assert (await lider.get(f"/api/peladas/{code}")).json()["description"] == "Quadra do parque"
