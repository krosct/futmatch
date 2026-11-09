"""Testes de regressão para as correções de segurança (cada teste corresponde a um achado da auditoria)."""
import hashlib
import os
import sqlite3
import tempfile

import pytest
from httpx import ASGITransport, AsyncClient

from app.adapters.sqlite_repo import SQLiteMatchRepository
from app.domain import security
from app.domain.audit import sanitize_audit_event, sanitize_metadata
from app.domain.models import Match
from app.main import app, repo, rate_limiter


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


def _match(mid: str, home: str = "A", away: str = "B", hs: int = 1, aws: int = 0) -> dict:
    return {
        "id": mid, "round_number": 1, "home_team_id": "t1", "home_team_name": home,
        "away_team_id": "t2", "away_team_name": away, "home_score": hs, "away_score": aws,
        "home_players": [], "away_players": [], "events": [],
    }


@pytest.fixture
async def client(async_client):
    """Cliente com cookies (criado no fixture) e HTTPS; reutiliza o banco temporário isolado."""
    return async_client


# ---------------------------------------------------------------------------
# Achado 1 e 2: rotas de partidas sem escopo de pelada / sobrescrita entre peladas
# ---------------------------------------------------------------------------
async def test_match_routes_require_pelada_code(client):
    assert (await client.get("/api/matches")).status_code == 422
    assert (await client.delete("/api/matches")).status_code == 422
    assert (await client.delete("/api/matches/qualquer")).status_code == 422
    assert (await client.post("/api/matches/save", json=_match("x"))).status_code == 422
    assert (await client.get("/api/dashboard")).status_code == 422


async def test_match_save_without_admin_is_rejected(client):
    code = (await client.post("/api/peladas/create", json={"name": "Alpha", "password": "senhaA1"})).json()["code"]
    async with _client() as anon:
        res = await anon.post(f"/api/matches/save?pelada_code={code}", json=_match("m1"))
        assert res.status_code == 403


async def test_same_match_id_in_two_peladas_does_not_overwrite(client):
    a = (await client.post("/api/peladas/create", json={"name": "Pelada A", "password": "senhaA1"})).json()["code"]
    async with _client() as other:
        b = (await other.post("/api/peladas/create", json={"name": "Pelada B", "password": "senhaB1"})).json()["code"]
        assert (await client.post(f"/api/matches/save?pelada_code={a}", json=_match("mesmo-id", "Time A"))).status_code == 200
        assert (await other.post(f"/api/matches/save?pelada_code={b}", json=_match("mesmo-id", "Time B"))).status_code == 200

        matches_a = (await client.get(f"/api/matches?pelada_code={a}")).json()
        matches_b = (await other.get(f"/api/matches?pelada_code={b}")).json()
        assert [m["home_team_name"] for m in matches_a] == ["Time A"]
        assert [m["home_team_name"] for m in matches_b] == ["Time B"]


async def test_admin_of_one_pelada_cannot_delete_match_of_another(client):
    a = (await client.post("/api/peladas/create", json={"name": "Pelada A", "password": "senhaA1"})).json()["code"]
    async with _client() as other:
        b = (await other.post("/api/peladas/create", json={"name": "Pelada B", "password": "senhaB1"})).json()["code"]
        await client.post(f"/api/matches/save?pelada_code={a}", json=_match("alvo"))

        # Admin de B tenta apagar a partida de A usando o código de A (sem cookie de A)
        res = await other.delete(f"/api/matches/alvo?pelada_code={a}")
        assert res.status_code == 403
        assert len((await client.get(f"/api/matches?pelada_code={a}")).json()) == 1


# ---------------------------------------------------------------------------
# Achado 3: rate limit contornável com X-Forwarded-For
# ---------------------------------------------------------------------------
async def test_claim_rate_limit_ignores_forwarded_for(client):
    code = (await client.post("/api/peladas/create", json={"name": "Claim", "password": "senhacorreta"})).json()["code"]
    async with _client() as attacker:
        first = await attacker.post(f"/api/peladas/{code}/claim-admin", json={"password": "errada"},
                                    headers={"X-Forwarded-For": "10.0.0.1"})
        second = await attacker.post(f"/api/peladas/{code}/claim-admin", json={"password": "errada"},
                                     headers={"X-Forwarded-For": "10.0.0.2"})
        assert first.status_code == 401
        assert second.status_code == 429


async def test_claim_lockout_per_client_after_five_failures(client):
    """Um mesmo cliente (IP + pelada) é bloqueado após 5 falhas, mesmo com a senha correta depois."""
    code = (await client.post("/api/peladas/create", json={"name": "Lock", "password": "senhacorreta"})).json()["code"]
    failures = 0
    for _ in range(8):
        for key in [k for k in list(rate_limiter._history) if k.startswith("claim:")]:
            rate_limiter._history.pop(key, None)  # simula o intervalo de 15s por IP já decorrido
        res = await client.post(f"/api/peladas/{code}/claim-admin", json={"password": "errada"})
        if res.status_code == 429:
            break
        assert res.status_code == 401
        failures += 1
    assert failures == 5
    for key in [k for k in list(rate_limiter._history) if k.startswith("claim:")]:
        rate_limiter._history.pop(key, None)
    res = await client.post(f"/api/peladas/{code}/claim-admin", json={"password": "senhacorreta"})
    assert res.status_code == 429


async def test_claim_global_cap_blocks_distributed_brute_force(client):
    """Atacantes em IPs diferentes atingem o teto global da pelada (50 falhas) e bloqueiam o resto."""
    code = (await client.post("/api/peladas/create", json={"name": "Teto", "password": "senhacorreta"})).json()["code"]
    for i in range(50):
        async with AsyncClient(transport=ASGITransport(app=app, client=(f"10.1.{i // 250}.{i % 250 + 1}", 1234)), base_url="https://test") as c:
            res = await c.post(f"/api/peladas/{code}/claim-admin", json={"password": "errada"})
            assert res.status_code == 401, (i, res.status_code)
    async with AsyncClient(transport=ASGITransport(app=app, client=("10.9.9.9", 1234)), base_url="https://test") as c:
        res = await c.post(f"/api/peladas/{code}/claim-admin", json={"password": "senhacorreta"})
        assert res.status_code == 429


# ---------------------------------------------------------------------------
# Achado 5: senha só de espaços
# ---------------------------------------------------------------------------
async def test_whitespace_only_password_rejected(client):
    res = await client.post("/api/peladas/create", json={"name": "Vazia", "password": "   "})
    assert res.status_code == 422
    code = (await client.post("/api/peladas/create", json={"name": "Okay", "password": "senha1"})).json()["code"]
    async with _client() as anon:
        res = await anon.post(f"/api/peladas/{code}/claim-admin", json={"password": "   "})
        assert res.status_code == 401


# ---------------------------------------------------------------------------
# Achado 6: token fora do JS (cookie HttpOnly + SameSite=Strict) e logout
# ---------------------------------------------------------------------------
async def test_admin_cookie_is_httponly_strict_and_not_in_body(client):
    res = await client.post("/api/peladas/create", json={"name": "Cookie", "password": "senha1"})
    assert "admin_token" not in res.json()
    set_cookie = res.headers.get("set-cookie", "").lower()
    code = res.json()["code"]
    assert f"fm_admin_{code.lower()}=" in set_cookie
    assert "httponly" in set_cookie
    assert "samesite=strict" in set_cookie
    assert "secure" in set_cookie


async def test_logout_revokes_session(client):
    code = (await client.post("/api/peladas/create", json={"name": "Logout", "password": "senha1"})).json()["code"]
    assert (await client.post(f"/api/peladas/{code}/description", json={"description": "x"})).status_code == 200
    assert (await client.post(f"/api/peladas/{code}/logout")).status_code == 200
    assert (await client.post(f"/api/peladas/{code}/description", json={"description": "y"})).status_code == 403


async def test_password_change_revokes_other_admin_sessions(client):
    code = (await client.post("/api/peladas/create", json={"name": "Troca", "password": "senha1"})).json()["code"]
    async with _client() as other:
        # Outro admin entra com a senha antiga
        assert (await other.post(f"/api/peladas/{code}/claim-admin", json={"password": "senha1"})).status_code == 200
        assert (await other.post(f"/api/peladas/{code}/description", json={"description": "antes"})).status_code == 200

        # O líder troca a senha
        assert (await client.post(f"/api/peladas/{code}/set-password", json={"password": "senha2"})).status_code == 200

        # A sessão do outro admin foi encerrada
        assert (await other.post(f"/api/peladas/{code}/description", json={"description": "depois"})).status_code == 403
        # O líder continua autorizado
        assert (await client.post(f"/api/peladas/{code}/description", json={"description": "ok"})).status_code == 200


# ---------------------------------------------------------------------------
# Achado 4: log de auditoria não é mais exposto pela API
# ---------------------------------------------------------------------------
async def test_audit_logs_endpoint_is_gone(client):
    assert (await client.get("/api/audit/logs")).status_code in (404, 405)


def test_audit_sanitization_drops_secrets_and_bad_fields():
    event = sanitize_audit_event(
        {
            "category": "pwned", "status": "??", "action": "x" * 500,
            "pelada_code": "'; DROP--", "session_id": "../../etc",
            "duration_ms": "NaN", "created_at_ts": 1e18,
            "metadata": {"password": "123", "nested": {"senha_nova": "9", "ok": 1}, "lista": [{"token": "t"}]},
        },
        client_ip="203.0.113.5", user_agent="UA", now_brt="01/01/2026 10:00:00", now_ts=1_700_000_000.0,
    )
    assert event is not None
    assert event.category == "action"
    assert event.status == "success"
    assert len(event.action) == 100
    assert event.pelada_code is None
    assert event.session_id is None
    assert event.duration_ms == 0.0
    assert event.created_at_ts <= 1_700_000_000.0 + 60
    assert event.client_ip == "203.0.113.5"  # IP vem do servidor, nunca do corpo
    assert "password" not in event.metadata_json and "senha" not in event.metadata_json
    assert "token" not in event.metadata_json and "ok" in event.metadata_json


def test_audit_sanitization_rejects_non_dict_items():
    assert sanitize_audit_event("lixo", "1.1.1.1", "UA", "x", 0.0) is None
    assert sanitize_metadata("não é json") == "{}"


def test_audit_metadata_size_limited():
    big = {"k": "v" * 150}
    raw = {f"campo{i}": "x" * 200 for i in range(30)}
    assert sanitize_metadata(raw) == '{"truncated": true}'
    assert sanitize_metadata(big).startswith("{")


# ---------------------------------------------------------------------------
# Achado 7: limite de corpo também em requisições chunked
# ---------------------------------------------------------------------------
async def test_chunked_body_over_limit_rejected(client):
    async def gen():
        for _ in range(7):
            yield b"a" * (1024 * 1024)

    res = await client.post("/api/peladas/create", content=gen(), headers={"Content-Type": "application/json"})
    assert res.status_code == 413


# ---------------------------------------------------------------------------
# Achado 8: CSRF (origem cruzada em escrita) e CSP
# ---------------------------------------------------------------------------
async def test_cross_origin_write_is_blocked(client):
    code = (await client.post("/api/peladas/create", json={"name": "Csrf", "password": "senha1"})).json()["code"]
    res = await client.post(
        f"/api/peladas/{code}/description", json={"description": "x"},
        headers={"Origin": "https://evil.example"},
    )
    assert res.status_code == 403
    res = await client.post(
        f"/api/peladas/{code}/description", json={"description": "x"},
        headers={"Origin": "https://test"},
    )
    assert res.status_code == 200


async def test_cross_site_fetch_metadata_blocked(client):
    code = (await client.post("/api/peladas/create", json={"name": "Fetch", "password": "senha1"})).json()["code"]
    res = await client.post(
        f"/api/peladas/{code}/description", json={"description": "x"},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert res.status_code == 403


# ---------------------------------------------------------------------------
# Achado 9: enumeração de peladas limitada por IP
# ---------------------------------------------------------------------------
async def test_pelada_lookup_is_rate_limited(client):
    code = (await client.post("/api/peladas/create", json={"name": "Enum", "password": "senha1"})).json()["code"]
    statuses = [(await client.get(f"/api/peladas/{code}")).status_code for _ in range(125)]
    assert 429 in statuses


# ---------------------------------------------------------------------------
# Achado 12: configuração global removida
# ---------------------------------------------------------------------------
async def test_global_config_cannot_be_written(client):
    assert (await client.post("/api/config", json={"players_per_team": 6})).status_code == 422
    res = await client.get("/api/config")
    assert res.status_code == 200
    assert res.json()["players_per_team"] == 5


async def test_balance_rejects_bad_levels_with_422_not_500(client):
    res = await client.post("/api/balance-teams", json={"players": [{"id": "1", "name": "A", "level": "muito"}]})
    assert res.status_code == 422


async def test_schedule_rejects_malformed_team_with_422(client):
    res = await client.post("/api/generate-schedule", json={"teams": [{"name": "Sem id"}]})
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# Domínio: hashing, validação e limitador
# ---------------------------------------------------------------------------
def test_pbkdf2_hash_format_and_rehash_policy():
    stored = security.hash_password("senha123")
    parts = stored.split("$")
    assert len(parts) == 4 and int(parts[1]) == security.PBKDF2_ITERATIONS
    assert security.needs_rehash(stored) is False
    legacy_pbkdf2 = "pbkdf2_sha256$" + "00" * 16 + "$" + "11" * 32
    assert security.needs_rehash(legacy_pbkdf2) is True
    assert security.needs_rehash(hashlib.sha256(b"x").hexdigest()) is True


def test_password_validation_normalizes_before_length():
    assert security.validate_password_value("  abc  ") == "abc"
    with pytest.raises(ValueError):
        security.validate_password_value("   ")
    with pytest.raises(ValueError):
        security.validate_password_value("ab")


def test_rate_limiter_is_limited_and_failure_recording():
    key = "unit-failure-key"
    rate_limiter._history.pop(key, None)
    assert rate_limiter.is_limited(key, 2, 60)[0] is False
    rate_limiter.record_failure(key, 60)
    rate_limiter.record_failure(key, 60)
    blocked, retry = rate_limiter.is_limited(key, 2, 60)
    assert blocked is True and retry > 0
    rate_limiter._history.pop(key, None)


def test_token_revocation_for_pelada():
    token = security.create_admin_token("REVKE")
    assert security.verify_admin_token(token, "REVKE") is True
    security.revoke_admin_tokens_for_pelada("REVKE")
    assert security.verify_admin_token(token, "REVKE") is False


# ---------------------------------------------------------------------------
# Migração: banco antigo (chave só por id) é reconstruído sem perder linhas
# ---------------------------------------------------------------------------
async def test_legacy_matches_table_is_migrated_to_composite_key():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        conn = sqlite3.connect(path)
        conn.executescript("""
            CREATE TABLE peladas (code TEXT PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL,
                name TEXT, players TEXT DEFAULT '[]', teams TEXT DEFAULT '[]', fixtures TEXT DEFAULT '[]',
                config TEXT DEFAULT '{}', parent_code TEXT DEFAULT NULL, description TEXT DEFAULT '');
            CREATE TABLE matches (id TEXT PRIMARY KEY, round_number INTEGER, home_team_id TEXT, home_team_name TEXT,
                away_team_id TEXT, away_team_name TEXT, home_score INTEGER, away_score INTEGER, home_players TEXT,
                away_players TEXT, events TEXT, winner_team_id TEXT, is_draw INTEGER, finished INTEGER,
                played_at TEXT, notes TEXT, pelada_code TEXT DEFAULT '');
            INSERT INTO peladas (code, password_hash, created_at, name) VALUES ('OLDP1', 'h', '01/01/2026 10:00:00', 'Antiga');
            INSERT INTO matches (id, round_number, home_team_id, home_team_name, away_team_id, away_team_name,
                home_score, away_score, home_players, away_players, events, winner_team_id, is_draw, finished,
                played_at, notes, pelada_code) VALUES ('m-old', 1, 't1', 'Verde', 't2', 'Azul', 2, 1, '[]', '[]', '[]',
                't1', 0, 1, '01/01/2026 10:00:00', '', 'OLDP1');
        """)
        conn.commit()
        conn.close()

        repository = SQLiteMatchRepository(path)
        await repository.init_db()

        matches = await repository.list_matches("OLDP1")
        assert [m.id for m in matches] == ["m-old"]

        same_id_other = Match(id="m-old", round_number=1, home_team_id="x", home_team_name="Outra",
                              away_team_id="y", away_team_name="Outra2", home_score=0, away_score=0, finished=True)
        await repository.create_pelada("NOVA2", "h", "Nova")
        await repository.save_match(same_id_other, "NOVA2")
        assert [m.home_team_name for m in await repository.list_matches("OLDP1")] == ["Verde"]

        conn = sqlite3.connect(path)
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='matches'").fetchone()[0]
        conn.close()
        assert "PRIMARY KEY (pelada_code, id)" in sql
    finally:
        os.remove(path)


# ---------------------------------------------------------------------------
# CLI de auditoria: leitura somente leitura
# ---------------------------------------------------------------------------
async def test_audit_cli_reads_without_writing(tmp_path):
    from app.adapters.sqlite_audit_repo import SQLiteAuditRepository
    from app.cli.audit_logs import query_logs
    from app.domain.audit import AuditEvent

    db = str(tmp_path / "audit.db")
    audit = SQLiteAuditRepository(db)
    await audit.init_audit_db()
    await audit.log_events_batch([AuditEvent(pelada_code="CLI12", action="a1", category="security")])

    rows = query_logs(db, limit=10, pelada_code="CLI12", category="security")
    assert len(rows) == 1 and rows[0]["action"] == "a1"

    # Conexão no mesmo modo do CLI (somente leitura): qualquer escrita deve falhar
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    with pytest.raises(sqlite3.OperationalError):
        conn.execute("DELETE FROM audit_logs")
    conn.close()


async def test_audit_retention_purges_old_events(tmp_path):
    from app.adapters.sqlite_audit_repo import SQLiteAuditRepository
    from app.domain.audit import AuditEvent
    from app.services.audit_service import AuditService

    db = str(tmp_path / "retention.db")
    audit = SQLiteAuditRepository(db)
    await audit.init_audit_db()
    await audit.log_events_batch([
        AuditEvent(action="antigo", created_at_ts=1.0),
        AuditEvent(action="novo"),
    ])
    service = AuditService(audit, retention_days=30)
    removed = await service.purge_expired()
    assert removed == 1
    remaining = await audit.list_audit_logs()
    assert [e.action for e in remaining] == ["novo"]


# ---------------------------------------------------------------------------
# Defesa em profundidade: IDs com aspas/símbolos são recusados (evita injeção em onclick)
# ---------------------------------------------------------------------------
async def test_unsafe_ids_are_rejected(client):
    code = (await client.post("/api/peladas/create", json={"name": "Ids", "password": "senha1"})).json()["code"]
    malicioso = "x');alert(1);('"
    res = await client.post(f"/api/peladas/{code}/sync-state", json={"players": [{"id": malicioso, "name": "A"}]})
    assert res.status_code == 422
    res = await client.post(f"/api/matches/save?pelada_code={code}", json={**_match("m1"), "home_team_id": malicioso})
    assert res.status_code == 422
    snapshot = {**_match("m2"), "home_players": [{"id": malicioso, "name": "B"}]}
    res = await client.post(f"/api/matches/save?pelada_code={code}", json=snapshot)
    assert res.status_code == 422
    res = await client.post(f"/api/matches/save?pelada_code={code}", json=_match("m-ok_1"))
    assert res.status_code == 200


# ---------------------------------------------------------------------------
# CSP estrita: sem handlers inline, sem script inline e sem CDN externo
# ---------------------------------------------------------------------------
def _read_static(name: str) -> str:
    with open(os.path.join(os.path.dirname(__file__), "..", "static", name), encoding="utf-8") as fh:
        return fh.read()


def test_no_inline_event_handlers_or_inline_scripts():
    import re
    for name in ("index.html", "app.js", "audio.js", "audit.js"):
        content = _read_static(name)
        assert not re.search(r'(?:\s|`)on(click|change|input|submit|keydown|dragstart|dragend|dragover|dragleave|drop|dblclick)="', content), name
    html = _read_static("index.html")
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html), "script inline encontrado"
    assert "cdn." not in html and "unpkg.com" not in html and "googleapis" not in html


async def test_csp_forbids_inline_scripts_and_external_hosts(client):
    res = await client.get("/")
    csp = res.headers["content-security-policy"]
    script_src = [d for d in csp.split(";") if d.strip().startswith("script-src")][0]
    assert "'unsafe-inline'" not in script_src
    assert "http" not in script_src and "cdn" not in script_src


def test_every_dispatched_action_is_allowlisted():
    import re
    handlers = _read_static("handlers.js")
    allowed = set(re.findall(r"'([A-Za-z_]\w*)'", handlers.split("ACOES_PERMITIDAS = new Set([")[1].split("]);")[0]))
    used = set()
    for name in ("index.html", "app.js"):
        used |= set(re.findall(r'data-h-[a-z]+="([A-Za-z_]\w*)"', _read_static(name)))
    used.add("submitConfiguracoes")
    assert used <= allowed, used - allowed


async def test_csp_forbids_inline_styles(client):
    import re
    res = await client.get("/")
    csp = res.headers["content-security-policy"]
    style_src = [d for d in csp.split(";") if d.strip().startswith("style-src")][0]
    assert "'unsafe-inline'" not in style_src
    for name in ("index.html", "app.js", "audio.js", "audit.js", "handlers.js"):
        assert not re.search(r'(?<![-\w])style="', _read_static(name)), name
    assert "<style" not in _read_static("index.html")


def test_dispatcher_stops_bubbling_like_inline_handlers():
    handlers = _read_static("handlers.js")
    assert "if (evento.cancelBubble) break;" in handlers
    assert "elemento.getAttribute('data-h-' + evento.type)" in handlers


def test_no_handler_relies_on_currentTarget():
    app = _read_static("app.js")
    assert "currentTarget" not in app


async def test_cookie_secure_follows_scheme_in_auto_mode():
    """Em HTTP puro (sem TLS) o cookie não recebe Secure, senão o navegador o descartaria."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http_client:
        res = await http_client.post("/api/peladas/create", json={"name": "Http Local", "password": "senha1"})
        assert res.status_code == 200
        set_cookie = res.headers.get("set-cookie", "").lower()
        assert "fm_admin_" in set_cookie and "httponly" in set_cookie
        assert "; secure" not in set_cookie


def test_user_text_fields_are_never_interpolated_raw_into_html():
    """Regressão da auditoria de innerHTML: nomes e descrições digitados por usuários só entram escapados."""
    import re
    pattern = re.compile(r"\$\{(?:p|t|m|s|pl|team|player|match|partida|item|jogador|time|l|i)\.(?:name|\w*_name|description|notes|nome)\}")
    lines = _read_static("app.js").splitlines()
    for idx, line in enumerate(lines):
        # scoreText alimenta tooltips do Chart.js (canvas, não HTML): não há contexto de injeção
        if pattern.search(line) and "escapeHtml" not in line and "scoreText:" not in line:
            # Só é seguro quando o destino é texto puro (toast/confirmação/alerta usam textContent)
            contexto = " ".join(lines[max(0, idx - 2):idx + 1])
            assert any(f in contexto for f in ("showToast(", "showCustomConfirm(", "showCustomAlert(")), line.strip()[:120]


async def test_admin_cookie_renewed_silently_near_expiry(client):
    """Sessão deslizante: perto do fim da validade o cookie é trocado sem o admin perceber."""
    import time as _time
    code = (await client.post("/api/peladas/create", json={"name": "Renova", "password": "senha1"})).json()["code"]
    name = f"fm_admin_{code}"
    old_token = client.cookies.get(name)
    assert old_token
    # Força o token a expirar em 1 hora (abaixo do limiar de 6 horas)
    security.ADMIN_TOKENS[old_token] = (code, _time.time() + 3600)
    res = await client.post(f"/api/peladas/{code}/description", json={"description": "renovado"})
    assert res.status_code == 200
    new_token = client.cookies.get(name)
    assert new_token and new_token != old_token
    assert security.verify_admin_token(new_token, code) is True
    assert security.verify_admin_token(old_token, code) is False
    assert security.admin_token_remaining(new_token, code) > 20 * 3600


async def test_config_has_single_source_of_truth(client):
    """Configuração sincronizada aparece em GET /api/config e nas consultas da pelada (mesma fonte)."""
    code = (await client.post("/api/peladas/create", json={"name": "Config", "password": "senha1"})).json()["code"]
    cfg = {"players_per_team": 7, "match_duration_minutes": 12, "total_rounds": 1, "championship_type": "single",
           "points_win": 3, "points_draw": 1, "alarm_sound": "standard-emergency-warning-signal.mp3"}
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"players": [], "config": cfg})).status_code == 200
    via_config = (await client.get(f"/api/config?pelada_code={code}")).json()
    info = (await client.get(f"/api/peladas/{code}")).json()
    assert via_config["players_per_team"] == 7
    assert info["config"]["players_per_team"] == 7


async def test_match_timer_state_survives_sync(client):
    """O estado do cronômetro das partidas em andamento é preservado entre sincronizações."""
    code = (await client.post("/api/peladas/create", json={"name": "Timer", "password": "senha1"})).json()["code"]
    fixture = {"id": "m_1", "round_number": 1, "home_team_id": "team_1", "away_team_id": "team_2",
               "timer_status": "running", "timer_elapsed_seconds": 125, "timer_updated_at": 1700000000.0}
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"fixtures": [fixture]})).status_code == 200
    info = (await client.get(f"/api/peladas/{code}")).json()
    assert info["fixtures"][0]["timer_status"] == "running"
    assert info["fixtures"][0]["timer_elapsed_seconds"] == 125


def test_refuses_multiple_workers_without_explicit_override(monkeypatch):
    from app.main import assert_single_worker
    monkeypatch.setenv("WEB_CONCURRENCY", "4")
    monkeypatch.delenv("ALLOW_MULTI_WORKER", raising=False)
    with pytest.raises(RuntimeError):
        assert_single_worker()
    monkeypatch.setenv("ALLOW_MULTI_WORKER", "1")
    assert_single_worker()
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    monkeypatch.delenv("ALLOW_MULTI_WORKER", raising=False)
    assert_single_worker()


def test_orphan_purge_requires_confirmation_and_backs_up(tmp_path):
    import json as _json
    from app.cli.purge_orphan_matches import main as purge
    db = str(tmp_path / "orf.db")
    conn = sqlite3.connect(db)
    conn.executescript("""
        CREATE TABLE matches (pelada_code TEXT NOT NULL DEFAULT '', id TEXT NOT NULL, round_number INTEGER,
            home_team_id TEXT, home_team_name TEXT, away_team_id TEXT, away_team_name TEXT, home_score INTEGER,
            away_score INTEGER, home_players TEXT, away_players TEXT, events TEXT, winner_team_id TEXT,
            is_draw INTEGER, finished INTEGER, played_at TEXT, notes TEXT, PRIMARY KEY (pelada_code, id));
        INSERT INTO matches VALUES ('', 'orf1', 1, 'a', 'A', 'b', 'B', 1, 0, '[]', '[]', '[]', 'a', 0, 1, 'x', '');
        INSERT INTO matches VALUES ('ABCDE', 'ok1', 1, 'a', 'A', 'b', 'B', 1, 0, '[]', '[]', '[]', 'a', 0, 1, 'x', '');
    """)
    conn.commit(); conn.close()
    backup = str(tmp_path / "bk.json")
    assert purge(["--db", db, "--backup", backup]) == 0
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM matches WHERE pelada_code = ''").fetchone()[0] == 1  # simulação
    conn.close()
    assert _json.load(open(backup, encoding="utf-8"))[0]["id"] == "orf1"
    assert purge(["--db", db, "--backup", str(tmp_path / "bk2.json"), "--confirmar"]) == 0
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0] == 1
    conn.close()


def test_every_generated_style_class_is_defined():
    """Toda classe ds-* usada no markup tem regra em ds.css (classes com sufixo dinâmico: ao menos uma regra com o prefixo)."""
    import re
    css = _read_static("css/ds.css")
    defined = set(re.findall(r"\.(ds-[0-9a-zA-Z_-]+)\s*\{", css))
    assert defined, "ds.css sem regras"
    for name in ("app.js", "index.html"):
        content = _read_static(name)
        for literal in set(re.findall(r"ds-[0-9a-f]{8}-(?=\$)", content)) | set(re.findall(r"\bds-[0-9a-f]{8}\b(?![-\w])", content)):
            assert any(d.startswith(literal) for d in defined), literal
        for full in set(re.findall(r"\bds-[0-9a-f]{8}-[0-9a-f]{6}\b", content)):
            assert full in defined, full
    assert "ds.css" in _read_static("index.html")
    assert not re.search(r' data-style="', _read_static("app.js") + _read_static("index.html"))


async def test_team_color_must_come_from_palette(client):
    code = (await client.post("/api/peladas/create", json={"name": "Cores", "password": "senha1"})).json()["code"]
    fora = [{"id": "team_1", "name": "Azul Claro", "color": "#123456", "players": []}]
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"teams": fora})).status_code == 422
    dentro = [{"id": "team_1", "name": "Verde", "color": "#84CC16", "players": []}]
    assert (await client.post(f"/api/peladas/{code}/sync-state", json={"teams": dentro})).status_code == 200


def test_vendored_assets_match_recorded_checksums():
    """Detecta troca silenciosa de bibliotecas vendorizadas. Atualizar uma delas exige regravar CHECKSUMS e revalidar o PDF (E2E)."""
    import hashlib
    raiz = os.path.join(os.path.dirname(__file__), "..", "static")
    for linha in _read_static("vendor/CHECKSUMS.sha256").splitlines():
        esperado, caminho = linha.split(" ", 1)
        with open(os.path.join(raiz, caminho), "rb") as fh:
            assert hashlib.sha256(fh.read()).hexdigest() == esperado, caminho


def test_html2canvas_patch_is_present():
    """O patch que impede o <style> injetado (CSP) precisa estar aplicado enquanto a biblioteca estiver vendorizada."""
    assert "/* FutMatch: sem <style> injetado" in _read_static("html2canvas.min.js")
