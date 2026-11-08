import pytest
from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.domain.models import Match, SessionConfig

async def test_crud_pelada(temp_db: SQLiteMatchRepository):
    """Testa criação, recuperação e atualização de peladas."""
    created = await temp_db.create_pelada(code="XYZ12", password_hash="hash_teste", name="Pelada de Quarta")
    assert created.code == "XYZ12"
    assert created.name == "Pelada de Quarta"

    fetched = await temp_db.get_pelada("XYZ12")
    assert fetched is not None
    assert fetched.code == "XYZ12"
    assert fetched.password_hash == "hash_teste"

    # Atualizar senha
    updated = await temp_db.update_pelada_password("XYZ12", "novo_hash")
    assert updated is True
    refetched = await temp_db.get_pelada("XYZ12")
    assert refetched.password_hash == "novo_hash"

async def test_pelada_pool_chain(temp_db: SQLiteMatchRepository):
    """Testa encadeamento de pools de peladas sem ciclos."""
    await temp_db.create_pelada("ROD01", "", "Rodada 1")
    await temp_db.create_pelada("ROD02", "", "Rodada 2")
    await temp_db.create_pelada("ROD03", "", "Rodada 3")

    # Vincular ROD03 -> ROD02 -> ROD01
    await temp_db.set_pelada_parent_code("ROD02", "ROD01")
    await temp_db.set_pelada_parent_code("ROD03", "ROD02")

    chain = await temp_db.get_pelada_chain_codes("ROD03")
    assert chain == ["ROD03", "ROD02", "ROD01"]

async def test_save_and_list_matches(temp_db: SQLiteMatchRepository):
    """Testa persistência e busca de partidas finalizadas."""
    await temp_db.create_pelada("PEL01", "", "Pelada 1")

    m1 = Match(
        id="match-1",
        round_number=1,
        home_team_id="t1",
        home_team_name="Time A",
        away_team_id="t2",
        away_team_name="Time B",
        home_score=3,
        away_score=1,
        home_players=[{"id": "p1", "name": "Craque"}],
        away_players=[{"id": "p2", "name": "Zagueiro"}],
        events=[{"player_id": "p1", "player_name": "Craque", "team_id": "t1", "event_type": "goal"}],
        winner_team_id="t1",
        finished=True
    )
    await temp_db.save_match(m1, pelada_code="PEL01")

    matches = await temp_db.list_matches(pelada_code="PEL01")
    assert len(matches) == 1
    assert matches[0].id == "match-1"
    assert matches[0].home_score == 3
    assert matches[0].winner_team_id == "t1"

    # Deletar partida única
    deleted = await temp_db.delete_match("match-1", pelada_code="PEL01")
    assert deleted is True
    matches_after = await temp_db.list_matches(pelada_code="PEL01")
    assert len(matches_after) == 0

async def test_dashboard_metrics(temp_db: SQLiteMatchRepository):
    """Calcula estatísticas de jogadores e métricas agregadas do dashboard."""
    await temp_db.create_pelada("DASH1", "", "Dashboard Teste")
    m = Match(
        id="m-dash",
        round_number=1,
        home_team_id="t1",
        home_team_name="Verde",
        away_team_id="t2",
        away_team_name="Azul",
        home_score=2,
        away_score=0,
        home_players=[{"id": "p1", "name": "Artilheiro"}],
        away_players=[{"id": "p2", "name": "Adversário"}],
        events=[
            {"player_id": "p1", "player_name": "Artilheiro", "team_id": "t1", "event_type": "goal"},
            {"player_id": "p1", "player_name": "Artilheiro", "team_id": "t1", "event_type": "goal"}
        ],
        winner_team_id="t1",
        finished=True
    )
    await temp_db.save_match(m, pelada_code="DASH1")

    stats = await temp_db.get_players_stats(pelada_code="DASH1")
    assert "p1" in stats
    assert stats["p1"]["goals"] == 2
    assert stats["p1"]["wins"] == 1

    metrics = await temp_db.get_dashboard_metrics(pelada_code="DASH1")
    assert metrics["summary"]["total_matches"] == 1
    assert metrics["summary"]["total_goals"] == 2
    assert len(metrics["top_scorers"]) >= 1
    assert metrics["top_scorers"][0]["name"] == "Artilheiro"

async def test_session_config_persistence(temp_db: SQLiteMatchRepository):
    """Testa leitura e gravação de configurações gerais e por pelada."""
    cfg = SessionConfig(players_per_team=6, match_duration_minutes=12, championship_type="double")
    await temp_db.save_config(cfg, pelada_code="CONF1")

    loaded = await temp_db.get_config(pelada_code="CONF1")
    assert loaded.players_per_team == 6
    assert loaded.match_duration_minutes == 12
    assert loaded.championship_type == "double"
