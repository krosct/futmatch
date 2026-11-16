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
    await temp_db.set_pelada_parent_codes("ROD02", ["ROD01"])
    await temp_db.set_pelada_parent_codes("ROD03", ["ROD02"])

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
    await temp_db.save_pelada_state("PEL01", [], [], [{"id": "match-1", "finished": True}])

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
    await temp_db.save_pelada_state("DASH1", [], [], [{"id": "m-dash", "finished": True}])

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

async def test_admin_token_persistence(temp_db: SQLiteMatchRepository):
    """Testa persistência, consulta e expiração de tokens administrativos no SQLite."""
    import time
    token = "token_teste_123"
    expires = time.time() + 3600
    await temp_db.save_admin_token(token, "PEL10", expires)

    fetched = await temp_db.get_admin_token(token)
    assert fetched is not None
    assert fetched[0] == "PEL10"
    assert fetched[1] == expires

    all_tokens = await temp_db.load_all_admin_tokens()
    assert token in all_tokens
    assert all_tokens[token][0] == "PEL10"

    await temp_db.delete_admin_token(token)
    assert await temp_db.get_admin_token(token) is None

async def test_historico_e_pool_seguem_tabela_de_jogos(temp_db: SQLiteMatchRepository):
    """Histórico = pool + tabela de jogos atual: partida removida da tabela sai das estatísticas."""
    await temp_db.create_pelada("POOLA", "", "Anterior")
    await temp_db.create_pelada("POOLB", "", "Atual")
    await temp_db.set_pelada_parent_codes("POOLB", ["POOLA"])
    m_a = Match(id="ma", round_number=1, home_team_id="t1", home_team_name="Verde", away_team_id="t2",
                away_team_name="Azul", home_score=2, away_score=0, home_players=[], away_players=[],
                events=[{"player_id": "p1", "player_name": "Ana", "team_id": "t1", "event_type": "goal"}],
                winner_team_id="t1", finished=True)
    m_b = Match(id="mb", round_number=1, home_team_id="t1", home_team_name="Verde", away_team_id="t2",
                away_team_name="Azul", home_score=1, away_score=0, home_players=[], away_players=[],
                events=[{"player_id": "p1", "player_name": "Ana", "team_id": "t1", "event_type": "goal"}],
                winner_team_id="t1", finished=True)
    await temp_db.save_match(m_a, pelada_code="POOLA")
    await temp_db.save_match(m_b, pelada_code="POOLB")
    await temp_db.save_pelada_state("POOLA", [], [], [{"id": "ma", "finished": True}])
    await temp_db.save_pelada_state("POOLB", [], [], [{"id": "mb", "finished": True}])

    metrics = await temp_db.get_dashboard_metrics(pelada_code="POOLB")
    assert metrics["summary"]["total_matches"] == 2
    assert metrics["summary"]["total_goals"] == 3

    # Remover a partida da tabela da pelada atual tira só ela do histórico
    await temp_db.save_pelada_state("POOLB", [], [], [])
    metrics = await temp_db.get_dashboard_metrics(pelada_code="POOLB")
    assert metrics["summary"]["total_matches"] == 1
    assert metrics["summary"]["total_goals"] == 2

    # Sem nenhuma partida nas tabelas, o histórico zera mesmo que a linha ainda exista no banco
    await temp_db.save_pelada_state("POOLA", [], [], [])
    metrics = await temp_db.get_dashboard_metrics(pelada_code="POOLB")
    assert metrics["summary"]["total_matches"] == 0
    assert metrics["summary"]["total_goals"] == 0
    assert metrics["top_scorers"] == [] or metrics["top_scorers"][0]["goals"] == 0


@pytest.mark.asyncio
async def test_init_db_backfills_missing_winner_team_id(tmp_path):
    import aiosqlite

    db_path = str(tmp_path / "backfill.db")
    repo = SQLiteMatchRepository(db_path=db_path)
    await repo.init_db()
    await repo.create_pelada("BF01", "hash", "Pelada Backfill")

    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO matches (
                id, round_number, home_team_id, home_team_name,
                away_team_id, away_team_name, home_score, away_score,
                home_players, away_players, events, winner_team_id,
                is_draw, finished, played_at, notes, pelada_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "m1", 1, "t1", "Time Azul",
                "t2", "Time Verde", 3, 1,
                "[]", "[]", "[]", None,
                0, 1, "13/11/2026 20:02:36", "", "BF01",
            ),
        )
        await db.commit()

    await repo.init_db()
    match = await repo.get_match("m1", "BF01")
    assert match is not None
    assert match.winner_team_id == "t1"
    assert match.is_draw is False


@pytest.mark.asyncio
async def test_init_db_backfills_peladas_fixtures_json(tmp_path):
    import json
    import aiosqlite

    db_path = str(tmp_path / "backfill_json.db")
    repo = SQLiteMatchRepository(db_path=db_path)
    await repo.init_db()
    await repo.create_pelada("BF02", "hash", "Pelada Fixtures JSON")

    stale_fixtures = [
        {"id": "m_1", "home_team_id": "t1", "away_team_id": "t2", "home_score": 0, "away_score": 0, "winner_team_id": None, "is_draw": True, "finished": True},
        {"id": "m_2", "home_team_id": "t1", "away_team_id": "t2", "home_score": 3, "away_score": 1, "winner_team_id": None, "is_draw": False, "finished": True},
        {"id": "m_3", "home_team_id": "t1", "away_team_id": "t2", "home_score": 2, "away_score": 2, "winner_team_id": None, "is_draw": False, "finished": True},
    ]
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE peladas SET fixtures = ? WHERE code = ?",
            (json.dumps(stale_fixtures), "BF02"),
        )
        await db.commit()

    await repo.init_db()
    session = await repo.get_pelada("BF02")
    assert session is not None
    assert session.fixtures[0]["winner_team_id"] is None
    assert session.fixtures[0]["is_draw"] is True
    assert session.fixtures[1]["winner_team_id"] == "t1"
    assert session.fixtures[1]["is_draw"] is False
    assert session.fixtures[2]["winner_team_id"] is None
    assert session.fixtures[2]["is_draw"] is True
