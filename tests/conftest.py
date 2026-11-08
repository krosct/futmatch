import os
import tempfile
import pytest
from httpx import AsyncClient, ASGITransport
from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.main import app, repo

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
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
    repo.db_path = original_db
