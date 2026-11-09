import asyncio
import logging
from typing import List, Optional
from app.domain.audit import AuditEvent
from app.ports.audit import AuditRepositoryPort

logger = logging.getLogger(__name__)

class AuditService:
    def __init__(self, repo: AuditRepositoryPort, batch_interval_seconds: float = 1.0, max_batch_size: int = 50):
        self.repo = repo
        self.batch_interval = batch_interval_seconds
        self.max_batch_size = max_batch_size
        self.queue: asyncio.Queue[AuditEvent] = asyncio.Queue()
        self._worker_task: Optional[asyncio.Task] = None
        self._running = False

    async def start(self) -> None:
        if not self._running:
            self._running = True
            await self.repo.init_audit_db()
            self._worker_task = asyncio.create_task(self._process_queue())

    async def stop(self) -> None:
        self._running = False
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        # Flush remaining events in queue
        await self._flush_remaining()

    def record_event(self, event: AuditEvent) -> None:
        """Adiciona o evento à fila em memória de forma não-bloqueante."""
        try:
            self.queue.put_nowait(event)
        except Exception as e:
            logger.error(f"Falha ao enfileirar evento de auditoria: {e}")

    def record_events(self, events: List[AuditEvent]) -> None:
        for ev in events:
            self.record_event(ev)

    async def _flush_remaining(self) -> None:
        batch = []
        while not self.queue.empty():
            try:
                batch.append(self.queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if batch:
            try:
                await self.repo.log_events_batch(batch)
            except Exception as e:
                logger.error(f"Erro ao descarregar buffer residual de auditoria: {e}")

    async def _process_queue(self) -> None:
        while self._running:
            batch: List[AuditEvent] = []
            try:
                # Aguarda o primeiro item
                item = await asyncio.wait_for(self.queue.get(), timeout=self.batch_interval)
                batch.append(item)
                self.queue.task_done()

                # Drena o restante até max_batch_size sem bloquear
                while len(batch) < self.max_batch_size and not self.queue.empty():
                    try:
                        b_item = self.queue.get_nowait()
                        batch.append(b_item)
                        self.queue.task_done()
                    except asyncio.QueueEmpty:
                        break

            except asyncio.TimeoutError:
                pass
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Erro ao obter itens da fila de auditoria: {e}")

            if batch:
                try:
                    await self.repo.log_events_batch(batch)
                except Exception as e:
                    logger.error(f"Erro ao persistir lote de auditoria: {e}")
