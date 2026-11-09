import hashlib
import hmac
import os
import secrets
import time
from typing import Dict, Tuple, Optional

# ==========================================
# GESTÃO DE SENHAS (PBKDF2-SHA256 COM SALT)
# ==========================================

PBKDF2_ITERATIONS = 100_000

def hash_password(password: str) -> str:
    """Gera hash PBKDF2-SHA256 com salt aleatório de 16 bytes."""
    pwd = password.strip()
    salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS).hex()
    return f"pbkdf2_sha256${salt}${dk}"

def verify_password(password: str, stored_hash: str) -> bool:
    """Verifica senha contra hash PBKDF2 ou hash legado SHA-256."""
    if not stored_hash:
        return False
    pwd = password.strip()

    if stored_hash.startswith("pbkdf2_sha256$"):
        parts = stored_hash.split("$")
        if len(parts) == 3:
            salt = bytes.fromhex(parts[1])
            expected_dk = parts[2]
            computed_dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt, PBKDF2_ITERATIONS).hex()
            return hmac.compare_digest(computed_dk, expected_dk)

    # Compatibilidade retroativa para hashes legados em SHA-256 puro
    legacy_hash = hashlib.sha256(pwd.encode("utf-8")).hexdigest()
    return hmac.compare_digest(legacy_hash, stored_hash)

def is_legacy_hash(stored_hash: str) -> bool:
    """Identifica se o hash armazenado ainda está no formato SHA-256 puro legado."""
    return bool(stored_hash) and not stored_hash.startswith("pbkdf2_sha256$")

# ==========================================
# ADMIN SESSIONS & TOKENS
# ==========================================

# Estrutura em memória: token -> (pelada_code, expire_timestamp)
ADMIN_TOKENS: Dict[str, Tuple[str, float]] = {}
TOKEN_TTL_SECONDS = 7 * 24 * 3600  # 7 dias de sessão administrativa

def create_admin_token(pelada_code: str) -> str:
    """Gera um token criptograficamente seguro vinculado à pelada."""
    cleanup_expired_tokens()
    token = secrets.token_urlsafe(32)
    ADMIN_TOKENS[token] = (pelada_code.upper().strip(), time.time() + TOKEN_TTL_SECONDS)
    return token

def verify_admin_token(token: Optional[str], pelada_code: str) -> bool:
    """Valida se o token pertence à pelada e ainda não expirou."""
    if not token or token not in ADMIN_TOKENS:
        return False
    target_code, expires_at = ADMIN_TOKENS[token]
    if time.time() > expires_at:
        del ADMIN_TOKENS[token]
        return False
    return target_code == pelada_code.upper().strip()

def cleanup_expired_tokens() -> None:
    """Remove tokens expirados da memória."""
    now = time.time()
    expired = [t for t, (_, exp) in ADMIN_TOKENS.items() if now > exp]
    for t in expired:
        ADMIN_TOKENS.pop(t, None)

def sync_admin_tokens(tokens: Dict[str, Tuple[str, float]]) -> None:
    """Sincroniza tokens persistidos para a memória RAM."""
    now = time.time()
    for t, (code, exp) in tokens.items():
        if exp > now:
            ADMIN_TOKENS[t] = (code.upper().strip(), exp)

# ==========================================
# RATE LIMITING (SLIDING WINDOW IN-MEMORY)
# ==========================================

class MemoryRateLimiter:
    """Rate limiter em janela deslizante com limpeza automática periódica."""
    def __init__(self):
        # chave -> [timestamps das requisições]
        self._history: Dict[str, list[float]] = {}
        self._last_cleanup = time.time()

    def _cleanup_old_entries(self, max_window: float = 300.0) -> None:
        now = time.time()
        if now - self._last_cleanup < 60.0:
            return
        self._last_cleanup = now
        stale_keys = []
        for key, timestamps in self._history.items():
            fresh = [t for t in timestamps if now - t < max_window]
            if fresh:
                self._history[key] = fresh
            else:
                stale_keys.append(key)
        for k in stale_keys:
            self._history.pop(k, None)

    def check_rate_limit(self, key: str, max_requests: int, window_seconds: float) -> Tuple[bool, int]:
        """
        Verifica se a chave excedeu max_requests dentro de window_seconds.
        Retorna (permitido: bool, tempo_restante_segundos: int).
        """
        self._cleanup_old_entries(window_seconds * 2)
        now = time.time()
        requests = self._history.get(key, [])
        # Filtra timestamps dentro da janela
        requests = [t for t in requests if now - t < window_seconds]
        
        if len(requests) >= max_requests:
            oldest = requests[0]
            retry_after = max(1, int(window_seconds - (now - oldest)))
            self._history[key] = requests
            return False, retry_after

        requests.append(now)
        self._history[key] = requests
        return True, 0

# Instância singleton do rate limiter
rate_limiter = MemoryRateLimiter()
