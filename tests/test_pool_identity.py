"""Identidade de jogadores entre peladas da pool: vínculo com homônimos, renomeação e histórico por alias."""
from app.domain.player_identity import (
    apply_renames, normalize_name, resolve_alias, validate_pool_links,
)
from tests.pool_helpers import vincular_pool


def test_normalize_ignores_case_and_extra_spaces():
    assert normalize_name("  Carlos   Silva ") == normalize_name("carlos silva")


def test_resolve_alias_follows_chain_and_survives_cycles():
    assert resolve_alias("q1", {"q1": "p1", "p1": "b7"}) == "b7"
    assert resolve_alias("x", {}) == "x"
    assert resolve_alias("a", {"a": "b", "b": "a"}) in {"a", "b"}


def test_validate_blocks_new_player_with_pool_homonym_until_linked_or_renamed():
    players = [{"id": "c1", "name": "Ana"}]
    pool = [{"id": "p1", "name": "ana", "source": "Antiga"}]
    erro, _ = validate_pool_links(players, pool, [], {})
    assert erro and "já existe na pool" in erro

    erro, mapa = validate_pool_links(players, pool, [{"player_id": "c1", "pool_player_id": "p1"}], {})
    assert erro is None and mapa == {"c1": "p1"}

    erro, _ = validate_pool_links(players, pool, [], {"c1": "Ana Luiza"})
    assert erro is None


def test_validate_rejects_rename_to_another_pool_name_and_duplicate_names():
    players = [{"id": "c1", "name": "Ana"}, {"id": "c2", "name": "Bia"}]
    pool = [{"id": "p1", "name": "Carla", "source": "Antiga"}]
    erro, _ = validate_pool_links(players, pool, [], {"c1": "carla"})
    assert erro and "já existe na pool" in erro
    erro, _ = validate_pool_links(players, pool, [], {"c1": "Bia"})
    assert erro and "nesta pelada" in erro


def test_validate_rejects_linking_same_pool_player_twice_and_renaming_linked():
    players = [{"id": "c1", "name": "Ana"}, {"id": "c2", "name": "Ana B"}]
    pool = [{"id": "p1", "name": "Ana", "source": "Antiga"}]
    erro, _ = validate_pool_links(players, pool, [{"player_id": "c1", "pool_player_id": "p1"},
                                                 {"player_id": "c2", "pool_player_id": "p1"}], {})
    assert erro
    erro, _ = validate_pool_links(players, pool, [{"player_id": "c1", "pool_player_id": "p1"}], {"c1": "Outra"})
    assert erro and "não pode ser renomeado" in erro


def test_apply_renames_updates_players_teams_fixtures_and_events():
    players = [{"id": "c1", "name": "Ana"}]
    teams = [{"id": "t1", "players": [{"id": "c1", "name": "Ana"}]}]
    fixtures = [{"id": "m1", "home_players": [{"id": "c1", "name": "Ana"}], "away_players": [],
                 "events": [{"player_id": "c1", "player_name": "Ana", "event_type": "goal"}]}]
    p, t, f = apply_renames(players, teams, fixtures, {"c1": "Ana Luiza"})
    assert p[0]["name"] == "Ana Luiza"
    assert t[0]["players"][0]["name"] == "Ana Luiza"
    assert f[0]["home_players"][0]["name"] == "Ana Luiza"
    assert f[0]["events"][0]["player_name"] == "Ana Luiza"
    assert players[0]["name"] == "Ana"  # entrada original intocada


async def _pelada(client, nome):
    return (await client.post("/api/peladas/create", json={"name": nome, "password": "senha1"})).json()["code"]


async def _sync(client, code, players, teams=None, fixtures=None):
    teams = teams or []
    assert (await client.post(f"/api/peladas/{code}/sync-state",
                              json={"players": players, "teams": teams, "fixtures": fixtures or []})).status_code == 200


async def test_candidates_list_pool_players_once_and_require_admin(async_client):
    antiga = await _pelada(async_client, "Antiga")
    atual = await _pelada(async_client, "Atual")
    await _sync(async_client, antiga, [{"id": "p1", "name": "Ana", "level": 3}, {"id": "p2", "name": "Bruno", "level": 3}])
    res = await async_client.get(f"/api/peladas/{atual}/pool-candidates", params={"parent_code": [antiga]})
    assert res.status_code == 200
    assert [c["name"] for c in res.json()["candidates"]] == ["Ana", "Bruno"]
    assert all(c["source"] == "Antiga" for c in res.json()["candidates"])


async def test_rename_is_applied_on_link_and_blocks_pool_homonym(async_client):
    antiga = await _pelada(async_client, "Antiga")
    atual = await _pelada(async_client, "Atual")
    await _sync(async_client, antiga, [{"id": "p1", "name": "Ana", "level": 3}])
    await _sync(async_client, atual, [{"id": "c1", "name": "Ana", "level": 3}, {"id": "c2", "name": "Bia", "level": 3}])

    # Nome novo que colide com a pool é recusado
    res = await async_client.post(f"/api/peladas/{atual}/pool", json={
        "parent_codes": [antiga], "renames": [{"player_id": "c1", "name": "ana"}]})
    assert res.status_code == 400

    # Renomear para nome livre e vincular o restante: o nome muda na pelada atual
    res = await async_client.post(f"/api/peladas/{atual}/pool", json={
        "parent_codes": [antiga], "renames": [{"player_id": "c1", "name": "Ana Luiza"}]})
    assert res.status_code == 200
    info = (await async_client.get(f"/api/peladas/{atual}")).json()
    assert [p["name"] for p in info["players"]] == ["Ana Luiza", "Bia"]


async def test_linked_player_uses_pool_history_and_unlink_removes_it(async_client):
    antiga = await _pelada(async_client, "Antiga")
    atual = await _pelada(async_client, "Atual")
    jogada = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "home_team_name": "Verde",
              "away_team_id": "team_2", "away_team_name": "Laranja", "home_score": 1, "away_score": 0,
              "home_players": [{"id": "p_1", "name": "Ana"}], "away_players": [{"id": "p_3", "name": "Carla"}],
              "events": [{"player_id": "p_1", "player_name": "Ana", "team_id": "team_1", "event_type": "goal"}],
              "finished": True}
    team_antiga = [{"id": "team_1", "name": "Verde", "color": "#84cc16", "players": [{"id": "p_1", "name": "Ana", "level": 1}]},
                   {"id": "team_2", "name": "Laranja", "color": "#f97316", "players": [{"id": "p_3", "name": "Carla", "level": 3}]}]
    assert (await async_client.post(f"/api/matches/save?pelada_code={antiga}", json=jogada)).status_code == 200
    await _sync(async_client, antiga,
                [{"id": "p_1", "name": "Ana", "level": 1}, {"id": "p_3", "name": "Carla", "level": 3}],
                team_antiga, [jogada])

    # Na pelada atual, Ana tem outro id; ela é a mesma pessoa da pool
    await _sync(async_client, atual, [{"id": "q_9", "name": "Ana", "level": 1}, {"id": "q_8", "name": "Carla", "level": 3}])
    assert (await vincular_pool(async_client, atual, antiga)).status_code == 200

    sorteio = {"players": [{"id": "q_9", "name": "Ana", "level": 1}, {"id": "q_8", "name": "Carla", "level": 3}],
               "players_per_team": 2, "pelada_code": atual}
    res = await async_client.post("/api/balance-teams", json=sorteio)
    efetivos = {p["name"]: p["effective_level"] for t in res.json() for p in t["players"]}
    assert efetivos["Ana"] == 2.8  # histórico da pool (1 vitória, 1 gol) pesa com o id da pelada antiga

    # Desvincular limpa os aliases: sem histórico próprio, volta a valer só a estrela
    assert (await async_client.post(f"/api/peladas/{atual}/pool", json={"parent_codes": []})).status_code == 200
    res = await async_client.post("/api/balance-teams", json=sorteio)
    efetivos = {p["name"]: p["effective_level"] for t in res.json() for p in t["players"]}
    assert efetivos["Ana"] == 1.0
