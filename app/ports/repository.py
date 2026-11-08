from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any
from app.domain.models import Match, Player, SessionConfig, PeladaSession

class MatchRepositoryPort(ABC):
    @abstractmethod
    async def init_db(self) -> None:
        pass

    @abstractmethod
    async def create_pelada(self, code: str, password_hash: str, name: str = "Pelada dos Amigos") -> PeladaSession:
        pass

    @abstractmethod
    async def get_pelada(self, code: str) -> Optional[PeladaSession]:
        pass

    @abstractmethod
    async def update_pelada_password(self, code: str, password_hash: str) -> bool:
        pass

    @abstractmethod
    async def set_pelada_parent_code(self, code: str, parent_code: Optional[str]) -> bool:
        pass

    @abstractmethod
    async def get_pelada_chain_codes(self, code: str) -> List[str]:
        pass

    @abstractmethod
    async def save_pelada_state(self, code: str, players: List[Dict[str, Any]], teams: List[Dict[str, Any]], fixtures: List[Dict[str, Any]], config: Dict[str, Any]) -> None:
        pass

    @abstractmethod
    async def save_match(self, match: Match, pelada_code: Optional[str] = None) -> None:
        pass

    @abstractmethod
    async def get_match(self, match_id: str, pelada_code: Optional[str] = None) -> Optional[Match]:
        pass

    @abstractmethod
    async def list_matches(self, limit: int = 100, pelada_code: Optional[str] = None) -> List[Match]:
        pass

    @abstractmethod
    async def delete_all_matches(self, pelada_code: Optional[str] = None) -> None:
        pass

    @abstractmethod
    async def delete_match(self, match_id: str, pelada_code: Optional[str] = None) -> bool:
        pass

    @abstractmethod
    async def get_dashboard_metrics(self, pelada_code: Optional[str] = None) -> Dict[str, Any]:
        pass

    @abstractmethod
    async def get_players_stats(self, pelada_code: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
        pass

    @abstractmethod
    async def save_config(self, config: SessionConfig, pelada_code: Optional[str] = None) -> None:
        pass

    @abstractmethod
    async def get_config(self, pelada_code: Optional[str] = None) -> SessionConfig:
        pass

