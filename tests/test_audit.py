import pytest
import os
import asyncio
from app.domain.audit import AuditEvent
from app.adapters.sqlite_audit_repo import SQLiteAuditRepository
from app.services.audit_service import AuditService

@pytest.fixture
async def temp_audit_repo(tmp_path):
    db_file = str(tmp_path / "test_audit.db")
    repo = SQLiteAuditRepository(db_file)
    await repo.init_audit_db()
    return repo

@pytest.mark.asyncio
async def test_audit_repo_insert_and_list(temp_audit_repo):
    event1 = AuditEvent(
        pelada_code="TEST1",
        category="action",
        action="click_balance_teams",
        target="btn-sortear",
        status="success",
        metadata_json='{"players_count": 10}'
    )
    event2 = AuditEvent(
        pelada_code="TEST1",
        category="media",
        action="toggle_mute",
        target="btn-sound",
        status="success"
    )
    event3 = AuditEvent(
        pelada_code="TEST2",
        category="action",
        action="add_player",
        target="btn-add",
        status="success"
    )

    await temp_audit_repo.log_events_batch([event1, event2, event3])

    # Filtrar por pelada
    logs_test1 = await temp_audit_repo.list_audit_logs(pelada_code="TEST1")
    assert len(logs_test1) == 2
    assert logs_test1[0].action == "toggle_mute" # Ordenação descrescente por id
    assert logs_test1[1].action == "click_balance_teams"

    # Filtrar por categoria
    media_logs = await temp_audit_repo.list_audit_logs(category="media")
    assert len(media_logs) == 1
    assert media_logs[0].action == "toggle_mute"

    # Total geral
    total = await temp_audit_repo.count_audit_logs()
    assert total == 3

@pytest.mark.asyncio
async def test_audit_service_queue_batch(temp_audit_repo):
    service = AuditService(temp_audit_repo, batch_interval_seconds=0.1, max_batch_size=5)
    await service.start()

    try:
        for i in range(7):
            service.record_event(AuditEvent(
                pelada_code="SVC_TEST",
                action=f"action_{i}",
                status="success"
            ))

        # Dá tempo para o worker drenar a fila
        await asyncio.sleep(0.3)

        logs = await temp_audit_repo.list_audit_logs(pelada_code="SVC_TEST")
        assert len(logs) == 7
    finally:
        await service.stop()
