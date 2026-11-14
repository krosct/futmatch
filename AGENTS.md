# FutMatch ⚽

## 1. Descrição do Projeto
Aplicação web moderna, ágil e intuitiva para organização de partidas de futebol (rachas/peladas), sorteio balanceado ou dinâmico de times, geração automática de confrontos com tabela de jogos, controle de placar em tempo real e persistência de histórico e estatísticas completas dos jogadores.

## 2. Stack Tecnológica
- **Backend:** Python 3.10+, FastAPI, Uvicorn, SQLite (armazenamento persistente de histórico e métricas).
- **Frontend:** HTML5 semântico, JavaScript nativo (SPA vanilla, sem framework) e Chart.js para dashboards. Tailwind CSS **compilado e versionado** em `static/css/tailwind.css` (tema Dark/Neon Sports; não usa CDN, o CSP bloqueia), mais `app.css`/`ds.css` para classes próprias. Ícones Lucide locais.
- **Arquitetura:** Ports & Adapters (Hexagonal), separando regras de domínio de partidas/sorteio de banco e HTTP.

## 3. Arquitetura do App
A aplicação segue a **Arquitetura Hexagonal (Ports & Adapters)**, mantendo o domínio totalmente desacoplado da infraestrutura, banco de dados e frameworks:
- **Domínio (`app/domain/`)**: Núcleo isolado contendo as regras de negócio puras (entidades `Player`, `Team`, `Match`, balanceamento/sorteio de times, geração de confrontos round-robin com time de abertura, formato Rei da Pelada em `king_of_court.py`, detecção de `[MOD]` em `championship_integrity.py`, consistência times/jogadores/partidas em `state_rules.py`, segurança de senhas e auditoria). Não depende de FastAPI nem de SQLite.
- **Portas (`app/ports/`)**: Interfaces abstratas (contratos de entrada e saída) que definem como a aplicação interage com persistência (`RepositoryPort`, `AuditRepositoryPort`) e serviços.
- **Serviços (`app/services/`)**: Orquestração entre domínio e portas, processamento de background/batch de auditoria (`AuditService`) e publicação de eventos em tempo real (`broadcaster` via SSE/WebSocket).
- **Adaptadores (`app/adapters/`)**: Implementações concretas de infraestrutura apontando para dentro (repositórios SQLite assíncronos com `aiosqlite`).
- **Ponto de Entrada HTTP (`app/main.py`)**: Controlador FastAPI que expõe rotas REST, endpoints de auditoria, SSE/WebSocket e serve os arquivos estáticos.
- **Frontend SPA (`static/`)**: Cliente em HTML5/JS nativo e Tailwind CSS Dark Neon, modularizado em `app.js` (fluxo da pelada/UI), `audio.js` (efeitos sonoros e alarmes) e `audit.js` (telemetria e auditoria de ações do usuário).

### Formatos de campeonato e regras
- Formatos: Turno Único (`single`), Turno e Retorno (`double`), Rei da Pelada (`king`) e Livre (`custom`). Cada um tem regras próprias, salvas na configuração da pelada e exibidas em Configurações só para o formato escolhido.
- Turnos e Rei: **quem começa jogando**. Rei da Pelada: **quem sai no empate** (os dois, menos/mais pontos, gols ou vitórias) e **vitórias consecutivas** (0 = sem limite). As partidas do Rei são geradas uma a uma, e o estado é recalculado do histórico.
- **[MOD]** (amarelo no título "Rodadas e Confrontos - Formato"): aparece quando a tabela foge do formato (partida removida/repetida, sequência do Rei alterada) ou quando as regras mudam depois de haver partida finalizada. Sem partida finalizada, mudar regra não gera `[MOD]`. A base de comparação é `rules_baseline` na config.
- Integridade: o servidor recusa (400) times com jogadores fora da lista e partidas de times inexistentes. Editar/remover partidas é sempre permitido (avisando que quebra o formato). Partida finalizada e editada mostra "* Editada em" em vermelho.
- Preferências pessoais (ex.: som do alarme) ficam no `localStorage` do navegador, não na pelada.

## 4. Estrutura de Pastas
```text
futMatch/
├── app/
│   ├── domain/        # Entidades, sorteio, formatos (Rei da Pelada), [MOD], consistência, segurança e eventos
│   ├── ports/         # Interfaces e contratos abstratos de repositório
│   ├── services/      # Orquestradores de negócio, auditoria em batch e broadcaster
│   ├── adapters/      # Implementações SQLite (aiosqlite)
│   └── main.py        # Aplicação FastAPI, rotas HTTP/REST e WebSocket/SSE
├── static/            # Frontend SPA (HTML5, JS, CSS Tailwind, sons e ícones)
│   ├── css/           # tailwind.css (compilado, versionado), app.css e ds.css
│   ├── alarms/        # Efeitos de alarme e término de partida
│   ├── icons/         # Favicons e ícones PWA
│   ├── lib/           # Bibliotecas e assets locais (Lucide, Chart.js, Confetti, fontes)
│   ├── music/         # Músicas e vinhetas de fundo
│   ├── sounds/        # Efeitos sonoros para ações
│   ├── app.js         # Lógica principal de UI, cronômetro e pelada
│   ├── audio.js       # Gerenciador de áudio e efeitos sonoros
│   ├── audit.js       # Rastreamento de métricas e auditoria client-side
│   ├── index.html     # PWA / SPA principal
│   ├── manifest.json  # Manifesto PWA
│   └── sw.js          # Service Worker para cache e PWA offline
├── scripts/           # build-css.sh: recompila o Tailwind (--check no CI)
├── tests/             # Suíte de testes automatizados com pytest e httpx (E2E de navegador em tests/e2e)
└── AGENTS.md          # Diretrizes, arquitetura e stack do projeto
```

## 5. Diretrizes de Assets e WAF
- **Pasta de Bibliotecas (`static/lib/`)**: Nunca renomeie ou mova bibliotecas e assets client-side para `static/vendor/`. O WAF do Cloudflare no domínio bloqueia qualquer URL contendo o termo `vendor` (para proteção genérica contra explorações de PHP/Composer), o que causa erro HTTP 403 Forbidden nos scripts e ícones em produção. Todos os pacotes e fontes locais devem permanecer sob `static/lib/`.

## 6. Comandos e Informações Essenciais
- **Comandos Principais:**
  - Iniciar backend (usuário/produção local): `uvicorn app.main:app --reload --port 4796 --timeout-graceful-shutdown 2` (o flag evita travar no reload/Ctrl+C por causa das conexões SSE abertas)
  - Porta de testes do modelo/assistente: Servidores de teste acionados pelo modelo inteligente devem rodar estritamente na **porta 4797** para evitar conflitos com o servidor do usuário na porta 4796.
  - Testes: `pytest`
  - Tailwind: ao criar/alterar classes em `index.html` ou `app.js`, rode `scripts/build-css.sh` e versione `static/css/tailwind.css`. O CI roda `scripts/build-css.sh --check` e falha se faltar classe. Só precisa de Node em desenvolvimento/CI; a VPS recebe o CSS pronto.
  - Service Worker: ao mudar arquivos de `static/`, incremente `CACHE_NAME` em `static/sw.js`.
  - Dependências: `pip install fastapi uvicorn aiosqlite pydantic pytest httpx`
- **Diretrizes e Restrições de Git / Commits:**
  - Estritamente proibido adicionar menções a Claude, Anthropic, IA ou co-autoria ("Co-Authored-By: Claude...", assinaturas ou avatares de IA) em commits, mensagens de commit ou código.
