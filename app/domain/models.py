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

@dataclass
class SessionConfig:
    players_per_team: int = 5
    match_duration_minutes: int = 10
    total_rounds: int = 1  # 1 = turno único, 2 = turno e retorno, 0 = formato livre
    championship_type: str = "single"  # "single" (Turno Único), "double" (Turno e Retorno), "custom" (Livre)
    points_win: int = 3
    points_draw: int = 1

@dataclass
class PeladaSession:
    code: str
    password_hash: str
    created_at: str
    name: Optional[str] = "Pelada dos Amigos"
    players: List[Dict[str, Any]] = field(default_factory=list)
    teams: List[Dict[str, Any]] = field(default_factory=list)
    fixtures: List[Dict[str, Any]] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)
    parent_code: Optional[str] = None


