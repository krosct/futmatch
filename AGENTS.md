# FutMatch ⚽

## 1. Descrição do Projeto
Aplicação web moderna, ágil e intuitiva para organização de partidas de futebol (rachas/peladas), sorteio balanceado ou dinâmico de times, geração automática de confrontos com tabela de jogos, controle de placar em tempo real e persistência de histórico e estatísticas completas dos jogadores.

## 2. Stack Tecnológica
- **Backend:** Python 3.10+, FastAPI, Uvicorn, SQLite (armazenamento persistente de histórico e métricas).
- **Frontend:** HTML5 semântico, Tailwind CSS (via CDN) com tema moderno Dark/Neon Sports, Lucide/FontAwesome Icons, JavaScript nativo reativo (Alpine.js ou Vanilla SPA leve) com Chart.js para dashboards.
- **Arquitetura:** Ports & Adapters (Hexagonal), separando regras de domínio de partidas/sorteio de banco e HTTP.

## 3. Arquitetura do App
A aplicação segue a **Arquitetura Hexagonal (Ports & Adapters)**, mantendo o domínio totalmente desacoplado da infraestrutura, banco de dados e frameworks:
- **Domínio (`app/domain/`)**: Núcleo isolado contendo as regras de negócio puras (entidades `Player`, `Team`, `Match`, balanceamento/sorteio de times, geração de confrontos round-robin, segurança de senhas e auditoria). Não depende de FastAPI nem de SQLite.
- **Portas (`app/ports/`)**: Interfaces abstratas (contratos de entrada e saída) que definem como a aplicação interage com persistência (`RepositoryPort`, `AuditRepositoryPort`) e serviços.
- **Serviços (`app/services/`)**: Orquestração entre domínio e portas, processamento de background/batch de auditoria (`AuditService`) e publicação de eventos em tempo real (`broadcaster` via SSE/WebSocket).
- **Adaptadores (`app/adapters/`)**: Implementações concretas de infraestrutura apontando para dentro (repositórios SQLite assíncronos com `aiosqlite`).
- **Ponto de Entrada HTTP (`app/main.py`)**: Controlador FastAPI que expõe rotas REST, endpoints de auditoria, SSE/WebSocket e serve os arquivos estáticos.
- **Frontend SPA (`static/`)**: Cliente em HTML5/JS nativo e Tailwind CSS Dark Neon, modularizado em `app.js` (fluxo da pelada/UI), `audio.js` (efeitos sonoros e alarmes) e `audit.js` (telemetria e auditoria de ações do usuário).

## 4. Estrutura de Pastas
```text
futMatch/
├── app/
│   ├── domain/        # Entidades, regras de sorteio, segurança e eventos
│   ├── ports/         # Interfaces e contratos abstratos de repositório
│   ├── services/      # Orquestradores de negócio, auditoria em batch e broadcaster
│   ├── adapters/      # Implementações SQLite (aiosqlite)
│   └── main.py        # Aplicação FastAPI, rotas HTTP/REST e WebSocket/SSE
├── static/            # Frontend SPA (HTML5, JS, CSS Tailwind, sons e ícones)
│   ├── alarms/        # Efeitos de alarme e término de partida
│   ├── icons/         # Favicons e ícones PWA
│   ├── music/         # Músicas e vinhetas de fundo
│   ├── sounds/        # Efeitos sonoros para ações
│   ├── app.js         # Lógica principal de UI, cronômetro e pelada
│   ├── audio.js       # Gerenciador de áudio e efeitos sonoros
│   ├── audit.js       # Rastreamento de métricas e auditoria client-side
│   ├── index.html     # PWA / SPA principal
│   ├── manifest.json  # Manifesto PWA
│   └── sw.js          # Service Worker para cache e PWA offline
├── tests/             # Suíte de testes automatizados com pytest e httpx
└── AGENTS.md          # Diretrizes, arquitetura e stack do projeto
```

## 5. Comandos e Informações Essenciais
- **Comandos Principais:**
  - Iniciar backend (usuário/produção local): `uvicorn app.main:app --reload --port 4796`
  - Porta de testes do modelo/assistente: Servidores de teste acionados pelo modelo inteligente devem rodar estritamente na **porta 4797** para evitar conflitos com o servidor do usuário na porta 4796.
  - Testes: `pytest`
  - Dependências: `pip install fastapi uvicorn aiosqlite pydantic pytest httpx`
- **Diretrizes e Restrições de Git / Commits:**
  - Estritamente proibido adicionar menções a Claude, Anthropic, IA ou co-autoria ("Co-Authored-By: Claude...", assinaturas ou avatares de IA) em commits, mensagens de commit ou código.
