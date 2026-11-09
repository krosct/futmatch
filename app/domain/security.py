import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Dict, Tuple, Optional

# ==========================================
# GESTÃO DE SENHAS (PBKDF2-SHA256 COM SALT)
# ==========================================

MIN_PASSWORD_LENGTH = 3
MAX_PASSWORD_LENGTH = 64
PBKDF2_ITERATIONS = 600_000
_PBKDF2_PREFIX = "pbkdf2_sha256$"
# Formato antigo (sem contagem de iterações) usava 100 mil iterações
_LEGACY_PBKDF2_ITERATIONS = 100_000


def normalize_password(password: Optional[str]) -> str:
    """Normaliza a senha. A validação de tamanho deve ser feita sobre o valor normalizado."""
    return (password or "").strip()


def validate_password_value(password: Optional[str]) -> str:
    """Valida a senha após normalizar: senha só de espaços não pode virar senha vazia."""
    pwd = normalize_password(password)
    if len(pwd) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"A senha deve ter no mínimo {MIN_PASSWORD_LENGTH} caracteres (espaços no início e no fim não contam).")
    if len(pwd) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"A senha deve ter no máximo {MAX_PASSWORD_LENGTH} caracteres.")
    return pwd


def hash_password(password: str) -> str:
    """Gera hash PBKDF2-SHA256 com salt aleatório de 16 bytes e contagem de iterações explícita."""
    pwd = normalize_password(password)
    salt = os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERATIONS).hex()
    return f"{_PBKDF2_PREFIX}{PBKDF2_ITERATIONS}${salt}${dk}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Verifica senha contra hash PBKDF2 (novo ou antigo) ou hash legado SHA-256."""
    if not stored_hash:
        return False
    pwd = normalize_password(password).encode("utf-8")

    if stored_hash.startswith(_PBKDF2_PREFIX):
        parts = stored_hash.split("$")
        try:
            if len(parts) == 4:
                iterations, salt_hex, expected_dk = int(parts[1]), parts[2], parts[3]
            elif len(parts) == 3:
                iterations, salt_hex, expected_dk = _LEGACY_PBKDF2_ITERATIONS, parts[1], parts[2]
            else:
                return False
            salt = bytes.fromhex(salt_hex)
        except ValueError:
            return False
        computed_dk = hashlib.pbkdf2_hmac("sha256", pwd, salt, iterations).hex()
        return hmac.compare_digest(computed_dk, expected_dk)

    # Compatibilidade para peladas criadas antes do PBKDF2 (SHA-256 puro, sem salt)
    legacy_hash = hashlib.sha256(pwd).hexdigest()
    return hmac.compare_digest(legacy_hash, stored_hash)


def is_legacy_hash(stored_hash: str) -> bool:
    """Identifica hash SHA-256 puro (sem salt)."""
    return bool(stored_hash) and not stored_hash.startswith(_PBKDF2_PREFIX)


def needs_rehash(stored_hash: str) -> bool:
    """Indica se o hash deve ser regenerado com os parâmetros atuais (formato legado ou menos iterações)."""
    if not stored_hash or is_legacy_hash(stored_hash):
        return True
    parts = stored_hash.split("$")
    if len(parts) != 4:
        return True
    try:
        return int(parts[1]) < PBKDF2_ITERATIONS
    except ValueError:
        return True


# ==========================================
# ADMIN SESSIONS & TOKENS
# ==========================================

# Estrutura em memória: token -> (pelada_code, expire_timestamp)
ADMIN_TOKENS: Dict[str, Tuple[str, float]] = {}
_TOKENS_LOCK = threading.Lock()
TOKEN_TTL_SECONDS = 24 * 3600  # 24 horas; renovado silenciosamente enquanto o admin estiver usando o app


def create_admin_token(pelada_code: str) -> str:
    """Gera um token criptograficamente seguro vinculado à pelada."""
    cleanup_expired_tokens()
    token = secrets.token_urlsafe(32)
    with _TOKENS_LOCK:
        ADMIN_TOKENS[token] = (pelada_code.upper().strip(), time.time() + TOKEN_TTL_SECONDS)
    return token


def verify_admin_token(token: Optional[str], pelada_code: str) -> bool:
    """Valida se o token pertence à pelada e ainda não expirou."""
    if not token:
        return False
    with _TOKENS_LOCK:
        entry = ADMIN_TOKENS.get(token)
        if entry is None:
            return False
        target_code, expires_at = entry
        if time.time() > expires_at:
            ADMIN_TOKENS.pop(token, None)
            return False
    return target_code == pelada_code.upper().strip()


def admin_token_remaining(token: Optional[str], pelada_code: str) -> Optional[float]:
    """Segundos restantes de um token válido para a pelada, ou None se inválido/expirado."""
    if not token:
        return None
    with _TOKENS_LOCK:
        entry = ADMIN_TOKENS.get(token)
    if entry is None:
        return None
    target_code, expires_at = entry
    remaining = expires_at - time.time()
    if remaining <= 0 or target_code != pelada_code.upper().strip():
        return None
    return remaining


def revoke_admin_token(token: Optional[str]) -> None:
    """Remove um token da memória."""
    if not token:
        return
    with _TOKENS_LOCK:
        ADMIN_TOKENS.pop(token, None)


def revoke_admin_tokens_for_pelada(pelada_code: str) -> None:
    """Remove da memória todos os tokens de uma pelada (ex.: troca de senha mestra)."""
    code = pelada_code.upper().strip()
    with _TOKENS_LOCK:
        for token in [t for t, (c, _) in ADMIN_TOKENS.items() if c == code]:
            ADMIN_TOKENS.pop(token, None)


def cleanup_expired_tokens() -> None:
    """Remove tokens expirados da memória."""
    now = time.time()
    with _TOKENS_LOCK:
        for token in [t for t, (_, exp) in ADMIN_TOKENS.items() if now > exp]:
            ADMIN_TOKENS.pop(token, None)


def sync_admin_tokens(tokens: Dict[str, Tuple[str, float]]) -> None:
    """Sincroniza tokens persistidos para a memória RAM."""
    now = time.time()
    with _TOKENS_LOCK:
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

    def _recent(self, key: str, window_seconds: float) -> list[float]:
        now = time.time()
        return [t for t in self._history.get(key, []) if now - t < window_seconds]

    def check_rate_limit(self, key: str, max_requests: int, window_seconds: float) -> Tuple[bool, int]:
        """
        Registra uma requisição e verifica se a chave excedeu max_requests na janela.
        Retorna (permitido: bool, tempo_restante_segundos: int).
        """
        self._cleanup_old_entries(window_seconds * 2)
        now = time.time()
        requests = self._recent(key, window_seconds)

        if len(requests) >= max_requests:
            oldest = requests[0]
            retry_after = max(1, int(window_seconds - (now - oldest)))
            self._history[key] = requests
            return False, retry_after

        requests.append(now)
        self._history[key] = requests
        return True, 0

    def is_limited(self, key: str, max_requests: int, window_seconds: float) -> Tuple[bool, int]:
        """Consulta sem registrar: retorna (bloqueado, tempo_restante_segundos)."""
        self._cleanup_old_entries(window_seconds * 2)
        requests = self._recent(key, window_seconds)
        if len(requests) >= max_requests:
            retry_after = max(1, int(window_seconds - (time.time() - requests[0])))
            return True, retry_after
        return False, 0

    def record_failure(self, key: str, window_seconds: float) -> None:
        """Registra uma falha sem verificar limite (usado após tentativa inválida)."""
        requests = self._recent(key, window_seconds)
        requests.append(time.time())
        self._history[key] = requests


# Instância singleton do rate limiter
rate_limiter = MemoryRateLimiter()
