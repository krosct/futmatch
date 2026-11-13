import json
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import List, Optional, Dict, Any

@dataclass
class Player:
    id: str
    name: str
    level: int = 3  # 1 a 5 (para balancear times com 1 clique se desejar)
    is_goalkeeper: bool = False
    effective_level: Optional[float] = None

@dataclass
class Team:
    id: str
    name: str
    color: str
    players: List[Player] = field(default_factory=list)

@dataclass
class MatchEvent:
    id: str
    match_id: str
    player_id: str
    player_name: str
    team_id: str
    event_type: str  # 'goal', 'own_goal'
    minute: Optional[int] = None

@dataclass
class Match:
    id: str
    round_number: int
    home_team_id: str
    home_team_name: str
    away_team_id: str
    away_team_name: str
    home_score: int = 0
    away_score: int = 0
    home_players: List[Dict[str, Any]] = field(default_factory=list)  # Snapshots de quem jogou
    away_players: List[Dict[str, Any]] = field(default_factory=list)
    events: List[Dict[str, Any]] = field(default_factory=list)
    winner_team_id: Optional[str] = None
    is_draw: bool = False
    finished: bool = False
    played_at: Optional[str] = None  # ISO format string em UTC-3
    notes: str = ""
    started_at: Optional[str] = None  # Horário de início ("HH:MM:SS" ou ISO em UTC-3)
    timer_status: str = "stopped"  # "stopped", "running", "paused"
    timer_elapsed_seconds: int = 0  # Segundos transcorridos acumulados
    timer_updated_at: Optional[float] = None  # Timestamp unix do último play/pause

@dataclass
class SessionConfig:
    players_per_team: int = 5
    match_duration_minutes: int = 10
    total_rounds: int = 1  # 1 = turno único, 2 = turno e retorno, 0 = livre ou Rei da Pelada
    championship_type: str = "single"  # "single" (Turno Único), "double" (Turno e Retorno), "custom" (Livre), "king" (Rei da Pelada)
    points_win: int = 3
    points_draw: int = 1
    # Regras por formato
    first_match_home_id: Optional[str] = None  # time que abre o jogo (turnos e Rei da Pelada)
    first_match_away_id: Optional[str] = None
    king_draw_rule: str = "both"  # Rei da Pelada: quem sai em caso de empate
    king_max_consecutive_wins: int = 0  # Rei da Pelada: vitórias seguidas até sair (0 = sem limite)
    rules_baseline: Optional[Dict[str, Any]] = None  # regras vigentes quando a tabela foi montada (base do [MOD])
    balance_stars_pct: int = 40  # % das estrelas manuais no sorteio (o restante vem do desempenho no histórico)

@dataclass
class PeladaSession:
    code: str
    password_hash: str
    created_at: str
    name: str
    players: List[Dict[str, Any]] = field(default_factory=list)
    teams: List[Dict[str, Any]] = field(default_factory=list)
    fixtures: List[Dict[str, Any]] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)
    description: str = ""


