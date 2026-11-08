import pytest
from app.domain.security import (
    hash_password,
    verify_password,
    is_legacy_hash,
    create_admin_token,
    verify_admin_token,
    rate_limiter
)
import hashlib

def test_password_hashing_pbkdf2():
    pwd = "supersecretpassword"
    hashed = hash_password(pwd)
    assert hashed.startswith("pbkdf2_sha256$")
    assert is_legacy_hash(hashed) is False
    assert verify_password(pwd, hashed) is True
    assert verify_password("wrongpassword", hashed) is False

def test_legacy_sha256_compatibility():
    pwd = "legacypassword"
    legacy_hash = hashlib.sha256(pwd.encode("utf-8")).hexdigest()
    assert is_legacy_hash(legacy_hash) is True
    assert verify_password(pwd, legacy_hash) is True
    assert verify_password("wrong", legacy_hash) is False

def test_admin_token_lifecycle():
    token = create_admin_token("PEL99")
    assert verify_admin_token(token, "PEL99") is True
    assert verify_admin_token(token, "OTHER") is False
    assert verify_admin_token("invalid_token", "PEL99") is False

def test_sliding_window_rate_limiter():
    key = "unit_test_rate_key"
    # Permite 3 requisições em 5 segundos
    ok1, _ = rate_limiter.check_rate_limit(key, max_requests=3, window_seconds=5)
    ok2, _ = rate_limiter.check_rate_limit(key, max_requests=3, window_seconds=5)
    ok3, _ = rate_limiter.check_rate_limit(key, max_requests=3, window_seconds=5)
    ok4, retry = rate_limiter.check_rate_limit(key, max_requests=3, window_seconds=5)

    assert ok1 is True
    assert ok2 is True
    assert ok3 is True
    assert ok4 is False
    assert retry > 0
