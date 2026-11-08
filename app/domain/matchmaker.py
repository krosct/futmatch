import random
from typing import List, Tuple
from app.domain.models import Player, Team, Match

COLOR_PALETTE = [
    {"name": "Colete Verde", "color": "#10b981", "badge": "🟢"},
    {"name": "Colete Laranja", "color": "#f97316", "badge": "🟠"},
    {"name": "Colete Azul", "color": "#3b82f6", "badge": "🔵"},
    {"name": "Colete Vermelho", "color": "#ef4444", "badge": "🔴"},
    {"name": "Colete Amarelo", "color": "#eab308", "badge": "🟡"},
    {"name": "Colete Preto", "color": "#64748b", "badge": "⚫"},
    {"name": "Colete Roxo", "color": "#a855f7", "badge": "🟣"},
    {"name": "Colete Branco", "color": "#e2e8f0", "badge": "⚪"},
]

class MatchmakerService:
    @staticmethod
    def balance_teams(players: List[Player], players_per_team: int) -> List[Team]:
        """Distribui jogadores entre times equilibrando goleiros e níveis de habilidade de forma justa."""
        if not players:
            return []

        num_teams = max(2, (len(players) + players_per_team - 1) // players_per_team)
        teams: List[Team] = []

        for i in range(num_teams):
            palette = COLOR_PALETTE[i % len(COLOR_PALETTE)]
            teams.append(Team(
                id=f"team_{i+1}",
                name=f"Time {palette['name'].replace('Colete ', '')}",
                color=palette['color'],
                players=[]
            ))

        # Separar goleiros de jogadores de linha
        goalkeepers = [p for p in players if p.is_goalkeeper]
        field_players = [p for p in players if not p.is_goalkeeper]

        # Distribui goleiros primeiro (1 por time onde der)
        random.shuffle(goalkeepers)
        for i, gk in enumerate(goalkeepers):
            teams[i % num_teams].players.append(gk)

        # Ordena jogadores de linha por habilidade decrescente com leve jitter aleatório
        # e distribui estilo "snake draft" para que o equilíbrio seja excelente
        field_players.sort(key=lambda p: (p.level, random.random()), reverse=True)

        direction = 1
        curr_idx = 0
        for p in field_players:
            # Encontra o time com menos jogadores para balancear contagem
            min_len = min(len(t.players) for t in teams)
            eligible_teams = [t for t in teams if len(t.players) == min_len]
            # Seleciona o com menor soma de nível atual
            chosen_team = min(eligible_teams, key=lambda t: sum(pl.level for pl in t.players))
            chosen_team.players.append(p)

        return teams

    @staticmethod
    def generate_round_robin_fixtures(teams: List[Team], rounds: int = 1) -> List[Match]:
        """Gera a tabela completa de confrontos (todos contra todos) sem confrontos repetidos imediatos."""
        if len(teams) < 2:
            return []

        team_ids = [t for t in teams]
        if len(team_ids) % 2 != 0:
            # Time fantasma/bye se ímpar
            dummy_team = Team(id="bye", name="Folga", color="#000")
            team_ids.append(dummy_team)

        n = len(team_ids)
        rounds_schedule: List[Match] = []
        match_counter = 1

        for r in range(rounds):
            current_teams = list(team_ids)
            for round_idx in range(n - 1):
                for i in range(n // 2):
                    t1 = current_teams[i]
                    t2 = current_teams[n - 1 - i]
                    if t1.id != "bye" and t2.id != "bye":
                        # Inverte mando em turnos pares
                        home, away = (t1, t2) if (round_idx + r) % 2 == 0 else (t2, t1)
                        rounds_schedule.append(Match(
                            id=f"m_{match_counter}",
                            round_number=r * (n - 1) + round_idx + 1,
                            home_team_id=home.id,
                            home_team_name=home.name,
                            away_team_id=away.id,
                            away_team_name=away.name,
                            home_players=[{"id": p.id, "name": p.name} for p in home.players],
                            away_players=[{"id": p.id, "name": p.name} for p in away.players],
                        ))
                        match_counter += 1
                # Rotaciona times (algoritmo round-robin clássico)
                current_teams = [current_teams[0]] + [current_teams[-1]] + current_teams[1:-1]

        return rounds_schedule
