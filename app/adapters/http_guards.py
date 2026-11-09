"""Proteções HTTP em nível ASGI (independentes do framework de rotas)."""
import json
from urllib.parse import urlparse

from starlette.types import ASGIApp, Message, Receive, Scope, Send

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class _PayloadTooLarge(Exception):
    pass


async def _send_json(send: Send, status: int, detail: str) -> None:
    body = json.dumps({"detail": detail}, ensure_ascii=False).encode("utf-8")
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


class MaxBodySizeMiddleware:
    """Recusa corpos acima de max_bytes, conferindo Content-Length e também o que é lido do stream.

    Requisições chunked (sem Content-Length) são contadas byte a byte, então o limite não pode ser
    contornado omitindo o header.
    """

    def __init__(self, app: ASGIApp, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        if declared is not None:
            try:
                if int(declared) > self.max_bytes:
                    await _send_json(send, 413, "Payload Too Large (máximo 5MB permitido)")
                    return
            except ValueError:
                await _send_json(send, 400, "Content-Length inválido.")
                return

        # O framework pode converter a exceção de leitura em outro erro (ex.: 400 no FastAPI).
        # Por isso o estouro é marcado aqui e a resposta do app é descartada: o 413 é sempre o final.
        state = {"received": 0, "exceeded": False, "response_started": False}

        async def limited_receive() -> Message:
            message = await receive()
            if message["type"] == "http.request":
                state["received"] += len(message.get("body", b""))
                if state["received"] > self.max_bytes:
                    state["exceeded"] = True
                    raise _PayloadTooLarge()
            return message

        async def tracked_send(message: Message) -> None:
            if state["exceeded"] and not state["response_started"]:
                return  # descarta a resposta gerada depois do estouro
            if message["type"] == "http.response.start":
                state["response_started"] = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _PayloadTooLarge:
            state["exceeded"] = True

        if state["exceeded"] and not state["response_started"]:
            await _send_json(send, 413, "Payload Too Large (máximo 5MB permitido)")


class SameOriginWritesMiddleware:
    """Bloqueia escritas vindas de outra origem (defesa em profundidade além do SameSite=Strict)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        host = headers.get(b"host", b"").decode("latin-1").lower()
        origin = headers.get(b"origin")
        fetch_site = headers.get(b"sec-fetch-site", b"").decode("latin-1").lower()

        blocked = fetch_site == "cross-site"
        if origin is not None:
            origin_netloc = urlparse(origin.decode("latin-1")).netloc.lower()
            blocked = blocked or not host or origin_netloc != host

        if blocked:
            await _send_json(send, 403, "Requisição de origem não permitida.")
            return

        await self.app(scope, receive, send)
