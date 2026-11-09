import asyncio
import json
from typing import Dict, Set, Any
from datetime import datetime, timezone, timedelta

BRT = timezone(timedelta(hours=-3))

class PeladaEventBroadcaster:
    """
    Gerenciador de canais em tempo real (Pub/Sub assíncrono em memória) por Pelada.
    Permite que conexões SSE se inscrevam no código da pelada e recebam eventos instantâneos.
    """
    def __init__(self):
        # Mapeia pelada_code (uppercase) -> Set de asyncio.Queue
        self._subscribers: Dict[str, Set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    async def subscribe(self, pelada_code: str) -> asyncio.Queue:
        code = pelada_code.strip().upper()
        queue: asyncio.Queue = asyncio.Queue(maxsize=100)
        async with self._lock:
            if code not in self._subscribers:
                self._subscribers[code] = set()
            self._subscribers[code].add(queue)
        return queue

    async def unsubscribe(self, pelada_code: str, queue: asyncio.Queue) -> None:
        code = pelada_code.strip().upper()
        async with self._lock:
            if code in self._subscribers:
                self._subscribers[code].discard(queue)
                if not self._subscribers[code]:
                    del self._subscribers[code]

    async def broadcast(self, pelada_code: str, event_type: str, data: Any = None) -> None:
        """
        Publica um evento para todos os clientes conectados a uma determinada pelada.
        """
        code = pelada_code.strip().upper()
        payload = {
            "event": event_type,
            "pelada_code": code,
            "timestamp": datetime.now(BRT).isoformat(),
            "data": data or {}
        }

        async with self._lock:
            queues = list(self._subscribers.get(code, set()))

        for q in queues:
            try:
                # Se a fila estiver cheia, descarta a mensagem mais antiga para manter fluidez
                if q.full():
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        pass
                q.put_nowait(payload)
            except Exception:
                pass

broadcaster = PeladaEventBroadcaster()
