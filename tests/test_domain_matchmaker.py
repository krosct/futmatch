import pytest
from app.domain.models import Player, Team, Match, SessionConfig, PeladaSession
from app.domain.matchmaker import MatchmakerService

def test_effective_level_less_than_threshold():
    """Com menos de 3 partidas, deve manter 100% das estrelas manuais base."""
    stats_2_matches = {"matches": 2, "wins": 2, "draws": 0, "losses": 0, "goals": 5}
    lvl = MatchmakerService.calculate_effective_level(base_level=3, stats=stats_2_matches, min_matches_threshold=3)
    assert lvl == 3.0

    lvl_none = MatchmakerService.calculate_effective_level(base_level=4, stats=None)
    assert lvl_none == 4.0

def test_effective_level_high_performer():
    """Atleta com alto aproveitamento e muitos gols deve ter nível efetivo elevado."""
    stats_a = {"matches": 10, "wins": 8, "draws": 1, "losses": 1, "goals": 12}
    lvl = MatchmakerService.calculate_effective_level(base_level=3, stats=stats_a)
    assert lvl == 3.45

def test_effective_level_low_performer():
    """Atleta com baixo aproveitamento e poucos gols deve ter nível efetivo reduzido."""
    stats_b = {"matches": 10, "wins": 2, "draws": 2, "losses": 6, "goals": 1}
    lvl = MatchmakerService.calculate_effective_level(base_level=3, stats=stats_b)
    assert lvl == 1.80

def test_effective_level_clamped_boundaries():
    """Garante que o nível nunca ultrapasse o intervalo [1.0, 5.0]."""
    god_stats = {"matches": 10, "wins": 10, "draws": 0, "losses": 0, "goals": 30}
    lvl_max = MatchmakerService.calculate_effective_level(base_level=5, stats=god_stats)
    assert lvl_max == 5.0

    zero_stats = {"matches": 10, "wins": 0, "draws": 0, "losses": 10, "goals": 0}
    lvl_min = MatchmakerService.calculate_effective_level(base_level=1, stats=zero_stats)
    assert lvl_min == 1.0

def test_balance_teams_even_distribution():
    """Distribui jogadores igualmente entre times e equilibra goleiros."""
    players = [
        Player(id="1", name="Goleiro 1", level=3, is_goalkeeper=True),
        Player(id="2", name="Goleiro 2", level=3, is_goalkeeper=True),
        Player(id="3", name="Craque", level=3, effective_level=4.5),
        Player(id="4", name="Bom", level=3, effective_level=3.5),
        Player(id="5", name="Médio", level=3, effective_level=3.0),
        Player(id="6", name="Iniciante", level=3, effective_level=1.5),
    ]

    teams = MatchmakerService.balance_teams(players, players_per_team=3)
    assert len(teams) == 2
    # 1 goleiro por time
    assert sum(1 for p in teams[0].players if p.is_goalkeeper) == 1
    assert sum(1 for p in teams[1].players if p.is_goalkeeper) == 1

    def team_strength(team):
        return sum(p.effective_level if p.effective_level is not None else p.level for p in team.players)

    diff = abs(team_strength(teams[0]) - team_strength(teams[1]))
    assert diff <= 0.6

def test_balance_teams_empty_players():
    """Retorna lista vazia caso não haja jogadores."""
    teams = MatchmakerService.balance_teams([], players_per_team=5)
    assert teams == []

def test_generate_round_robin_fixtures():
    """Gera confrontos de todos contra todos corretamente."""
    teams = [
        Team(id="t1", name="Time Verde", color="#84cc16"),
        Team(id="t2", name="Time Azul", color="#3b82f6"),
        Team(id="t3", name="Time Vermelho", color="#ef4444"),
        Team(id="t4", name="Time Amarelo", color="#eab308")
    ]

    fixtures = MatchmakerService.generate_round_robin_fixtures(teams, rounds=1)
    # Com 4 times, rodadas = 3, 2 jogos por rodada = 6 jogos
    assert len(fixtures) == 6
    for f in fixtures:
        assert f.home_team_id != f.away_team_id
        assert f.finished is False
