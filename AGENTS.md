# FutMatch ⚽

## 1. Descrição do Projeto
Aplicação web moderna, ágil e intuitiva para organização de partidas de futebol (rachas/peladas), sorteio balanceado ou dinâmico de times, geração automática de confrontos com tabela de jogos, controle de placar em tempo real e persistência de histórico e estatísticas completas dos jogadores.

## 2. Stack Tecnológica
- **Backend:** Python 3.10+, FastAPI, Uvicorn, SQLite (armazenamento persistente de histórico e métricas).
- **Frontend:** HTML5 semântico, Tailwind CSS (via CDN) com tema moderno Dark/Neon Sports, Lucide/FontAwesome Icons, JavaScript nativo reativo (Alpine.js ou Vanilla SPA leve) com Chart.js para dashboards.
- **Arquitetura:** Ports & Adapters (Hexagonal), separando regras de domínio de partidas/sorteio de banco e HTTP.

## 3. Informações Essenciais
- **Estrutura:**
  - `app/domain/`: Entidades e regras de negócio (Jogadores, Times, Partidas, Classificação, Métricas).
  - `app/ports/`: Interfaces de repositório e serviços.
  - `app/adapters/`: Repositório SQLite, Controllers/Rotas FastAPI, templates e estáticos.
  - `static/`: CSS/JS e assets visuais.
  - `templates/`: Páginas HTML da aplicação.
- **Comandos Principais:**
  - Iniciar backend (usuário/produção local): `uvicorn app.main:app --reload --port 4796`
  - Porta de testes do modelo/assistente: Servidores de teste acionados pelo modelo inteligente devem rodar estritamente na **porta 4797** para evitar conflitos com o servidor do usuário na porta 4796.
  - Dependências: `pip install fastapi uvicorn aiosqlite pydantic`
