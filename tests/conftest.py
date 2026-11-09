import os
import tempfile
import pytest
from httpx import AsyncClient, ASGITransport
from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.main import app, repo

@pytest.fixture(autouse=True)
def _reset_rate_limits():
    """O ASGITransport usa sempre o mesmo IP: zera os limites entre testes para não se afetarem."""
    from app.domain.security import rate_limiter
    rate_limiter._history.clear()
    yield
    rate_limiter._history.clear()

@pytest.fixture
async def temp_db():
    """Cria um banco SQLite temporário isolado por teste."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    repository = SQLiteMatchRepository(path)
    await repository.init_db()
    yield repository
    if os.path.exists(path):
        os.remove(path)

@pytest.fixture
async def async_client(temp_db):
    """Cliente HTTP assíncrono conectado à app FastAPI usando o banco isolado."""
    original_db = repo.db_path
    repo.db_path = temp_db.db_path
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://test") as client:
        yield client
    repo.db_path = original_db
