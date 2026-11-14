from abc import ABC, abstractmethod
from typing import List, Optional, Dict, Any
from app.domain.models import Match, SessionConfig, PeladaSession

class MatchRepositoryPort(ABC):
    @abstractmethod
    async def init_db(self) -> None:
        pass

    @abstractmethod
    async def create_pelada(self, code: str, password_hash: str, name: str) -> PeladaSession:
        pass

    @abstractmethod
    async def get_pelada(self, code: str) -> Optional[PeladaSession]:
        pass

    @abstractmethod
    async def update_pelada_password(self, code: str, password_hash: str) -> bool:
        pass

    @abstractmethod
    async def set_pelada_parent_codes(self, code: str, parent_codes: List[str]) -> None:
        pass

    @abstractmethod
    async def get_pelada_parent_codes(self, code: str) -> List[str]:
        pass

    @abstractmethod
    async def set_pelada_description(self, code: str, description: str) -> bool:
        pass

    @abstractmethod
    async def get_pelada_chain_codes(self, code: str) -> List[str]:
        pass

    @abstractmethod
    async def save_pelada_state(self, code: str, players: List[Dict[str, Any]], teams: List[Dict[str, Any]], fixtures: List[Dict[str, Any]]) -> None:
        pass

    @abstractmethod
    async def save_match(self, match: Match, pelada_code: str) -> None:
        pass

    @abstractmethod
    async def overwrite_pelada(self, pelada: PeladaSession, config: SessionConfig, matches: List[Match]) -> None:
        """Substitui dados, configuração, vínculo de pool e histórico da pelada numa única transação.
        Não altera a senha mestra da pelada."""
        pass

    @abstractmethod
    async def list_pelada_matches(self, pelada_code: str) -> List[Match]:
        """Partidas gravadas somente nesta pelada (sem as da corrente de pool), na ordem de gravação."""
        pass

    @abstractmethod
    async def get_match(self, match_id: str, pelada_code: str) -> Optional[Match]:
        pass

    @abstractmethod
    async def list_matches(self, pelada_code: str, limit: int = 100) -> List[Match]:
        pass

    @abstractmethod
    async def delete_all_matches(self, pelada_code: str) -> None:
        pass

    @abstractmethod
    async def delete_match(self, match_id: str, pelada_code: str) -> bool:
        pass

    @abstractmethod
    async def get_dashboard_metrics(self, pelada_code: str) -> Dict[str, Any]:
        pass

    @abstractmethod
    async def get_players_stats(self, pelada_code: str) -> Dict[str, Dict[str, Any]]:
        pass

    @abstractmethod
    async def get_player_aliases(self, pelada_code: str) -> Dict[str, str]:
        pass

    @abstractmethod
    async def set_player_aliases(self, pelada_code: str, aliases: Dict[str, str]) -> None:
        pass

    @abstractmethod
    async def get_chain_player_aliases(self, pelada_code: str) -> Dict[str, str]:
        pass

    @abstractmethod
    async def save_config(self, config: SessionConfig, pelada_code: str) -> None:
        pass

    @abstractmethod
    async def get_config(self, pelada_code: str) -> SessionConfig:
        pass

    @abstractmethod
    async def save_admin_token(self, token: str, pelada_code: str, expires_at: float) -> None:
        pass

    @abstractmethod
    async def get_admin_token(self, token: str) -> Optional[tuple[str, float]]:
        pass

    @abstractmethod
    async def delete_admin_token(self, token: str) -> None:
        pass

    @abstractmethod
    async def delete_admin_tokens_for_pelada(self, pelada_code: str) -> None:
        pass

    @abstractmethod
    async def load_all_admin_tokens(self) -> Dict[str, tuple[str, float]]:
        pass
