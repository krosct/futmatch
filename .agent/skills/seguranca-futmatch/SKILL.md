---
name: seguranca-futmatch
description: Feedback e revisão de segurança do projeto FutMatch (FastAPI + SQLite + front-end vanilla). Use quando o usuário pedir revisão de segurança, feedback de segurança, auditoria, análise de vulnerabilidades, checar CSP/cookies/rate limit, ou perguntar o que já foi corrigido e o que ainda é risco no FutMatch.
---

# Segurança do FutMatch — conhecimento acumulado

Use esta skill para responder com contexto real do projeto, sem refazer a análise do zero. Confira sempre o estado atual no código antes de afirmar algo: os caminhos abaixo podem ter mudado.

## 1. Arquitetura resumida
- Backend: `app/main.py` (rotas), `app/domain/security.py` (senhas, tokens, rate limit), `app/adapters/` (SQLite, guards HTTP, auditoria), `app/services/` (auditoria em fila, broadcast SSE).
- Front-end: `static/index.html`, `static/app.js`, `static/handlers.js` (despacho de eventos), `static/css/ds.css` (estilos gerados).
- Banco: SQLite em `DATA_DIR/futmatch.db`, permissão 0600 na inicialização.
- Deploy: `deploy.conf` (uvicorn com `--proxy-headers --forwarded-allow-ips 127.0.0.1 --workers 1`) e `.github/workflows/deploy.yml` (devkit por SHA).

## 2. Controles implementados (e onde)
- **Escopo por pelada:** toda rota de partida exige `pelada_code` e sessão de admin da própria pelada. Não há rota global de escrita. (`main.py`, `require_admin_permission`)
- **Chave primária composta** `(pelada_code, id)` em `matches`, com migração que preserva linhas (`sqlite_repo._migrate_matches_table`).
- **Sessão de admin em cookie** `fm_admin_<CODIGO>`: `HttpOnly`, `SameSite=Strict`, `Secure` quando HTTPS (`COOKIE_SECURE=auto`). Token nunca vai no JSON nem no `localStorage`.
- **Ciclo do token:** TTL de 24 h; renovação silenciosa quando faltam menos de 6 h (middleware `renew_admin_session`); logout; revogação de todas as sessões ao trocar a senha.
- **Senhas:** PBKDF2-SHA256 com 600 mil iterações e formato versionado; hashes antigos são regerados no login; senha é normalizada (`strip`) antes da validação de tamanho.
- **Bloqueio de força bruta:** 1 tentativa/15 s por IP+pelada; 5 falhas por IP+pelada em 15 min; teto global de 50 falhas por pelada em 15 min.
- **IP real:** `request.client.host` apenas. O uvicorn só aceita `X-Forwarded-For` de proxy confiável.
- **Limite de corpo:** 5 MB medidos no stream (ASGI puro), também para chunked; retorna 413.
- **CSRF / origem:** escritas com `Origin` diferente do `Host` ou `Sec-Fetch-Site: cross-site` retornam 403.
- **CSP:** `default-src 'self'`; `script-src 'self'` (sem `unsafe-inline`); `style-src 'self'` (sem `unsafe-inline`); `object-src 'none'`; `frame-ancestors 'self'`; `worker-src 'self' blob:` (necessário ao jsPDF). Sem CDN externo.
- **Validação de entrada:** IDs restritos a `^[A-Za-z0-9_-]{1,64}$` (inclusive dentro de listas aninhadas); cor de time restrita à paleta; DTOs com limites de tamanho.
- **Auditoria:** registros só em SQLite, sem nenhuma rota de leitura na API. Leitura apenas via `python -m app.cli.audit_logs` no servidor (SQLite em `mode=ro`). Ingestão sanitizada (remove chaves com `password|senha|token|secret|cookie|authorization`, valida códigos, limita tamanho). Retenção de 30 dias.
- **Front-end:** nenhum handler inline; despacho por `data-h-<evento>` com allowlist de funções; `textContent` em toasts e diálogos; `innerHTML` só com `escapeHtml` (há teste de regressão que barra interpolação crua de campos de texto).
- **Dependências:** bibliotecas e fontes servidas localmente com checksums (`static/vendor/CHECKSUMS.sha256`); Tailwind compilado; `pip-audit` sem vulnerabilidades conhecidas nas 16 dependências fixadas (data da verificação: sessão de 2026-11-08).
- **Multi-worker:** o app recusa iniciar com `WEB_CONCURRENCY > 1` sem `ALLOW_MULTI_WORKER=1`, porque rate limit e bloqueios vivem na memória do processo.
- **CI:** job `test` roda `pytest`; job `e2e` roda o Chrome real (`tests/e2e`); `deploy` depende de ambos; actions fixadas por SHA; `krosct/devkit` (mesmo dono do repositório) fixado por SHA por decisão do dono.

## 3. Vulnerabilidades encontradas e status
| # | Problema | Gravidade | Status |
|---|---|---|---|
| V1 | `DELETE /api/matches` sem código apagava o histórico de todas as peladas sem autenticação | Crítica | Corrigido (escopo + admin) |
| V2 | `POST /api/matches/save` sem código gravava no namespace global; mesmo `id` sobrescrevia partida de outra pelada | Crítica | Corrigido (chave composta) |
| V3 | Rate limit do `claim-admin` contornável com `X-Forwarded-For` forjado | Alta | Corrigido (IP do socket) |
| V4 | `GET /api/audit/logs` expunha IPs, user-agent e session IDs de todos sem autenticação | Alta | Corrigido (sem rota; CLI local) |
| V5 | Senha só com espaços virava senha vazia; qualquer um assumia a pelada | Alta | Corrigido (normalização antes da validação) |
| V6 | Token de admin em `localStorage` (qualquer XSS roubava a sessão) | Alta | Corrigido (cookie HttpOnly) |
| V7 | `onclick` com nome de jogador interpolado; `escapeHtml` não protege contexto JS | Média | Corrigido (`data-*` + delegação) |
| V8 | Limite de 5 MB ignorado em requisição chunked | Média | Corrigido (medição no stream) |
| V9 | Sessões de admin válidas por 7 dias e sem revogação | Média | Corrigido (24 h, renovação, revogação) |
| V10 | Brute force distribuído por IPs diferentes | Média | Mitigado (teto global de 50 por pelada) |
| V11 | Enumeração de códigos de pelada sem limite | Média | Mitigado (120 consultas/min por IP) |
| V12 | Ingestão de telemetria sem limite e sem sanitização | Média | Corrigido (rate limit + sanitização + retenção) |
| V13 | CDNs sem versão fixa e sem SRI; `lucide@latest` | Média | Corrigido (local + checksums) |
| V14 | Sem CSP | Média | Corrigido (CSP estrita) |
| V15 | Actions do CI fixadas por tag, não por SHA | Média | Corrigido (SHA) |
| V16 | Sem limites de rate/IP para API inteira | Média | Corrigido (300 req/min por IP) |
| V17 | Senhas PBKDF2 com 100 mil iterações | Baixa | Corrigido (600 mil) |
| V18 | Token/sessão não revogado na troca de senha | Média | Corrigido |

## 4. Bugs encontrados (além de segurança)
- **B1** Erros 500 com entradas inválidas em `balance-teams`, `generate-schedule` e ingestão de auditoria. Corrigido (422).
- **B2** Duas fontes de configuração (`peladas.config` e tabela `configs`) divergiam. Corrigido (fonte única).
- **B3** Regex de propriedade CSS recusava `background-color` (precedência de classe/estilo). Corrigido.
- **B4** Handlers usando `event.currentTarget` quebravam com delegação no `document`. Corrigido (`this`).
- **B5** `stopPropagation()` não era respeitado pelo despacho manual de ancestrais. Corrigido.
- **B6** Init do app abortava se o Lucide não carregasse. Corrigido (`refreshIcons`).
- **B7** Dois `on*` dentro de template literal escaparam da conversão. Corrigido e coberto por regex de teste.
- **B8** Gol de jogador não escalado era aceito sem validação de placar. Corrigido (toast e bloqueio).
- **B9** Mismatch aparente gol × placar no PDF: não era bug. O snapshot `home_players` é copiado na geração do confronto; o arrasto posterior não altera o snapshot. Comportamento esperado, mas vale documentar para o usuário.

## 5. Perigos e limites residuais (honestos)
- **Snapshot de escalação:** arrastar um jogador depois de gerar confrontos não muda a escalação da partida. Pode confundir o usuário.
- **Rate limit em memória:** só vale com 1 worker. Escalar horizontalmente exige Redis ou similar.
- **Bloqueio por pelada** pode ser usado para trancar o admin (50 falhas em 15 min). Trade-off aceito contra brute force distribuído.
- **Cookie `Secure` em HTTP:** em `COOKIE_SECURE=auto`, HTTP puro não recebe `Secure`. Isso é intencional, mas deixa o token em trânsito em redes não confiáveis se o site for servido sem TLS. Em produção, força HTTPS no proxy.
- **Dados órfãos:** partidas sem `pelada_code` (legado) ficam no banco até alguém rodar `python -m app.cli.purge_orphan_matches --backup X --confirmar`.
- **E2E no CI não verificado remotamente:** o job `e2e` foi reproduzido localmente com os mesmos comandos, mas não rodou no GitHub. Confirme na primeira execução remota.
- **Patch no html2canvas:** a função que injetava `<style>` foi neutralizada no arquivo vendorizado. Revalide o PDF ao atualizar a biblioteca (o checksum e o E2E bloqueiam mudança silenciosa).
- **Estilos dinâmicos** agora são classes geradas (`ds-<hash>[-valor]`); qualquer novo `style=` ou `data-style` no markup viola a CSP e quebra o teste de regressão.
- **Sessões em memória do processo** são recuperadas do banco (`load_all_admin_tokens` e fallback), mas o rate limit não.

## 6. Como verificar (checklist para feedback)
1. `python -m pytest -q` (unitários e de API, incluindo `tests/test_security_hardening.py`).
2. `cd tests/e2e && BASE_URL=http://127.0.0.1:4797 CHROME_PATH=/usr/bin/google-chrome node e2e.mjs` com o servidor de teste em 4797 (nunca na porta de produção).
3. Em revisão de código, procure: `innerHTML` com campos de usuário sem `escapeHtml`; `style=`/`on*=` no markup; uso de `req.headers` para IP; rotas sem `require_admin_permission`; `pelada_code` opcional; logs com dados pessoais; `unsafe-inline` na CSP.
4. Para afirmar que algo está seguro, cite o teste ou o comando que comprova. Não afirme por leitura apenas.

## 7. Decisões já tomadas pelo dono do projeto
- Commit feito diretamente em `main` (sem push), sob autorização explícita.
- `krosct/devkit` mantido com SHA fixado (repositório do próprio dono).
- Auditoria só para o desenvolvedor, via CLI no servidor.
- Relatórios PDF gerados no navegador com html2canvas (patch documentado).

## 8. Pendências abertas no momento
- Validação remota do CI (job `e2e` e `test` no GitHub): exige push de uma branch e PR em draft para `krosct/futmatch`. Só fazer com autorização explícita do dono. Nunca push direto em `main` sem aval, porque dispara o deploy em produção.
- Commits: `22bf7b3` (segurança e front-end) e `ed9fac1` (gol sem escalação e testes), ambos em `main`, sem push.
