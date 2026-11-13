import random
from typing import List, Tuple, Optional, Dict, Any
from app.domain.models import Player, Team, Match
from app.domain.team_colors import TEAM_COLORS

class MatchmakerService:
    @staticmethod
    def calculate_effective_level(
        base_level: int,
        stats: Optional[Dict[str, Any]] = None,
        min_matches_threshold: int = 1,
        stars_pct: int = 40,
    ) -> float:
        """
        Calcula o nível efetivo ponderado:
        - `stars_pct`% para estrelas manuais base (1 a 5; padrão 40)
        - o restante para performance real em jogos anteriores (vitórias 60% e média de gols 40%)
        Se o jogador tiver menos de `min_matches_threshold` partidas (padrão 1), mantém 100% das estrelas base.
        """
        base = max(1.0, min(5.0, float(base_level)))
        if not stats or stats.get("matches", 0) < min_matches_threshold:
            return round(base, 2)

        matches = stats["matches"]
        wins = stats.get("wins", 0)
        draws = stats.get("draws", 0)
        goals = stats.get("goals", 0)

        # Aproveitamento de vitórias/pontos (empate conta 0.5 vitória)
        win_ratio = (wins + (0.5 * draws)) / matches if matches > 0 else 0.0
        win_score = win_ratio * 5.0

        # Média de gols (teto em 2 gols/jogo para escala de 5.0)
        goals_per_match = goals / matches if matches > 0 else 0.0
        goal_score = min(goals_per_match / 2.0, 1.0) * 5.0

        # Performance score (escala 0 a 5.0)
        performance_score = (win_score * 0.60) + (goal_score * 0.40)

        # Ponderação: `stars_pct`% estrelas base + restante performance
        stars_weight = max(0.0, min(100.0, float(stars_pct))) / 100.0
        effective = (base * stars_weight) + (performance_score * (1.0 - stars_weight))
        return round(max(1.0, min(5.0, effective)), 2)

    @staticmethod
    def balance_teams(players: List[Player], players_per_team: int) -> List[Team]:
        """Distribui jogadores entre times equilibrando goleiros e níveis de habilidade (efetivo ou base) de forma justa."""
        if not players:
            return []

        num_teams = max(2, (len(players) + players_per_team - 1) // players_per_team)
        teams: List[Team] = []

        for i in range(num_teams):
            palette = TEAM_COLORS[i % len(TEAM_COLORS)]
            teams.append(Team(
                id=f"team_{i+1}",
                name=f"Time {palette['label']}",
                color=palette['color'],
                players=[]
            ))

        def get_score(p: Player) -> float:
            return p.effective_level if p.effective_level is not None else float(p.level)

        # Separar goleiros de jogadores de linha
        goalkeepers = [p for p in players if p.is_goalkeeper]
        field_players = [p for p in players if not p.is_goalkeeper]

        # Distribui goleiros primeiro, equilibrando pelo score
        goalkeepers.sort(key=lambda p: (get_score(p), random.random()), reverse=True)
        for i, gk in enumerate(goalkeepers):
            teams[i % num_teams].players.append(gk)

        # Ordena jogadores de linha por nível efetivo decrescente com leve jitter aleatório
        # e distribui estilo "snake draft" dinâmico para garantir equilíbrio de força total
        field_players.sort(key=lambda p: (get_score(p), random.random()), reverse=True)

        for p in field_players:
            # Encontra o time com menos jogadores para balancear contagem
            min_len = min(len(t.players) for t in teams)
            eligible_teams = [t for t in teams if len(t.players) == min_len]
            # Seleciona o time elegível com menor soma de nível atual
            chosen_team = min(eligible_teams, key=lambda t: sum(get_score(pl) for pl in t.players))
            chosen_team.players.append(p)

        return teams

    @staticmethod
    def generate_round_robin_fixtures(
        teams: List[Team],
        rounds: int = 1,
        first_match: Optional[Tuple[Optional[str], Optional[str]]] = None,
    ) -> List[Match]:
        """Gera a tabela completa de confrontos (todos contra todos) sem confrontos repetidos imediatos.

        `first_match` = (mandante, visitante): ids dos times que abrem a primeira rodada.
        Ids inválidos ou iguais são ignorados e a ordem padrão é mantida.
        """
        if len(teams) < 2:
            return []

        team_ids = [t for t in teams]
        opening = None
        if first_match and first_match[0] and first_match[1] and first_match[0] != first_match[1]:
            by_id = {t.id: t for t in teams}
            if first_match[0] in by_id and first_match[1] in by_id:
                opening = (by_id[first_match[0]], by_id[first_match[1]])
        if opening:
            others = [t for t in team_ids if t not in opening]
            if len(team_ids) % 2 == 0:
                # Rodada 1 do método do círculo pareia a posição 0 com a última
                team_ids = [opening[0]] + others + [opening[1]]
            else:
                # Com ímpar, o "fantasma" ocupa a última posição; o par de abertura vai para 1 e n-2
                team_ids = others[:1] + [opening[0]] + others[1:] + [opening[1]]
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

        if opening:
            # Partida de abertura vai para o topo da rodada 1 e os ids são renumerados em sequência
            rounds_schedule.sort(key=lambda m: (m.round_number != 1 or m.home_team_id != opening[0].id or m.away_team_id != opening[1].id, m.round_number))
            for idx, m in enumerate(rounds_schedule, start=1):
                m.id = f"m_{idx}"

        return rounds_schedule
