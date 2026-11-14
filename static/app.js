// FutMatch Client Logic

// Peso padrão das estrelas no sorteio (% estrelas base; o restante é histórico). Fonte única no frontend.
const BALANCE_STARS_PCT_PADRAO = 40;

let state = {
  currentPelada: null, // { code, name, created_at, has_password }
  role: 'spectator',   // 'admin' ou 'spectator'
  players: [],
  teams: [],
  fixtures: [],
  config: {
    players_per_team: 5,
    match_duration_minutes: 10,
    total_rounds: 1,
    points_win: 3,
    points_draw: 1,
    first_match_home_id: null,
    first_match_away_id: null,
    king_draw_rule: "both",
    king_max_consecutive_wins: 0,
    balance_stars_pct: BALANCE_STARS_PCT_PADRAO
  }
};

let syncDebounceTimer = null;
let claimAdminCooldownTimer = null;
let liveEventSource = null;
let livePollFallbackTimer = null;

// ==============================
// GESTÃO DE PELADAS (SESSÕES)
// ==============================
function getActivePeladaCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const codeFromUrl = urlParams.get('pelada') || (window.location.hash ? window.location.hash.replace('#', '') : null);
  if (codeFromUrl) {
    return codeFromUrl.trim().toUpperCase();
  }
  return localStorage.getItem('futmatch_active_pelada') || null;
}

// A sessão de admin fica num cookie HttpOnly (o navegador envia sozinho; o JS não lê o token).
function getAuthHeaders(extraHeaders = {}) {
  return { "Content-Type": "application/json", ...extraHeaders };
}

function setActivePelada(code, role = 'spectator') {
  state.currentPelada = { code };
  state.role = role;
  localStorage.setItem('futmatch_active_pelada', code);

  // Atualiza URL sem recarregar a página
  const newUrl = `${window.location.pathname}?pelada=${code}`;
  window.history.replaceState({ pelada: code }, '', newUrl);

  updateRoleUI();
}

function updateRoleUI() {
  const isLeader = state.role === 'admin';
  const roleBadge = document.getElementById('role-badge');
  const codeDisplay = document.getElementById('current-pelada-code-display');
  const settingsIndicator = document.getElementById('settings-role-indicator');
  const settingsPeladaCode = document.getElementById('settings-pelada-code');
  const claimAdminBox = document.getElementById('box-claim-admin');

  if (codeDisplay && state.currentPelada) {
    codeDisplay.textContent = `#${state.currentPelada.code}`;
  }
  if (settingsPeladaCode && state.currentPelada) {
    settingsPeladaCode.textContent = `#${state.currentPelada.code}`;
  }

  if (roleBadge) {
    if (isLeader) {
      roleBadge.innerHTML = `<i data-lucide="crown" class="w-3 h-3 text-amber-400"></i><span>Admin</span>`;
      roleBadge.className = 'h-5 inline-flex items-center justify-center text-[10px] font-bold px-2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 gap-1 leading-none';
    } else {
      roleBadge.innerHTML = `<i data-lucide="eye" class="w-3 h-3 text-amber-400"></i><span>Espectador</span>`;
      roleBadge.className = 'h-5 inline-flex items-center justify-center text-[10px] font-bold px-2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 gap-1 leading-none';
    }
  }

  if (settingsIndicator) {
    if (isLeader) {
      settingsIndicator.textContent = 'Administrador';
      settingsIndicator.className = 'text-xs font-bold px-3 py-1 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/30';
    } else {
      settingsIndicator.textContent = 'Modo Espectador';
      settingsIndicator.className = 'text-xs font-bold px-3 py-1 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/30';
    }
  }

  // Se já for admin, oculta o box de claim; se for espectador, exibe
  if (claimAdminBox) {
    if (isLeader) {
      claimAdminBox.classList.add('hidden');
    } else {
      claimAdminBox.classList.remove('hidden');
    }
  }

  // Habilitar / desabilitar botões de edição administrativa
  const adminOnlyElements = document.querySelectorAll('.admin-only');
  adminOnlyElements.forEach(el => {
    if (isLeader) {
      el.classList.remove('hidden');
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        if (el.id !== 'btn-clear-history' && el.id !== 'btn-export-pdf') {
          el.disabled = false;
        }
      }
    } else {
      el.classList.add('hidden');
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        el.disabled = true;
      }
    }
  });

  updateHistoryActionButtonsState();

  const cfgFields = [
    document.getElementById("cfg-players-per-team"),
    document.getElementById("cfg-duration"),
    document.getElementById("cfg-rounds"),
    document.getElementById("cfg-first-home"),
    document.getElementById("cfg-first-away"),
    document.getElementById("cfg-king-draw-rule"),
    document.getElementById("cfg-king-max-wins"),
    document.getElementById("cfg-stars-pct")
  ];
  cfgFields.forEach(f => {
    if (f) f.disabled = !isLeader;
  });

  atualizarVisibilidadeControlesFormato();

  refreshIcons();
}

// Função utilitária para controlar exibição da landing screen e ocultar cabeçalho/abas/conteúdo
function setLandingVisibility(showLanding) {
  const landing = document.getElementById('landing-screen');
  const appHeader = document.getElementById('app-header');
  const appMain = document.getElementById('app-main');
  const mobileNav = document.getElementById('mobile-bottom-nav');

  if (landing) {
    if (showLanding) {
      landing.classList.remove('hidden');
    } else {
      landing.classList.add('hidden');
    }
  }

  if (appHeader) {
    if (showLanding) {
      appHeader.classList.add('hidden');
    } else {
      appHeader.classList.remove('hidden');
      atualizarIndicadorNav();
    }
  }

  if (appMain) {
    if (showLanding) {
      appMain.classList.add('hidden');
    } else {
      appMain.classList.remove('hidden');
    }
  }

  if (mobileNav) {
    if (showLanding) {
      mobileNav.classList.add('hidden');
    } else {
      mobileNav.classList.remove('hidden');
    }
  }
}

async function inicializarPelada() {
  const code = getActivePeladaCode();

  if (!code) {
    setLandingVisibility(true);
    return;
  }

  try {
    const res = await fetch(`/api/peladas/${code}`);
    if (!res.ok) {
      // Se não encontrou, remove do storage e exibe landing
      if (claimAdminCooldownTimer) {
    clearInterval(claimAdminCooldownTimer);
    claimAdminCooldownTimer = null;
  }
  encerrarLiveEvents();

  localStorage.removeItem('futmatch_active_pelada');
      setLandingVisibility(true);
      await showCustomAlert("A pelada com o código informado não foi encontrada.", "Código Inválido", false, { icone: 'circle-x' });
      return;
    }

    const data = await res.json();
    state.currentPelada = data;
    // Papel vem do servidor (cookie válido), nunca de armazenamento local
    state.role = data.is_admin ? 'admin' : 'spectator';

    setLandingVisibility(false);

    // Carrega dados persistidos da pelada
    if (data.players && data.players.length > 0) {
      state.players = data.players;
    }
    if (data.teams && data.teams.length > 0) {
      state.teams = data.teams;
    }
    if (data.fixtures && data.fixtures.length > 0) {
      state.fixtures = data.fixtures;
    }
    if (data.config && Object.keys(data.config).length > 0) {
      state.config = { ...state.config, ...data.config };
    }

    updateRoleUI();
    renderPoolUI(data.chain_codes);
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();
    await carregarConfiguracoes();
    await atualizarDashboard();

    // Inicia stream ao vivo de eventos (SSE)
    iniciarLiveEvents(code);

    // Se o líder acabou de criar e ainda não configurou a senha
    if (state.role === 'admin' && !data.has_password) {
      abrirModalDefinirSenha();
    }
  } catch (err) {
    console.error("Erro ao carregar pelada:", err);
    setLandingVisibility(true);
  }
}

async function criarNovaPelada() {
  const nameInput = document.getElementById('input-new-pelada-name');
  const peladaName = nameInput ? nameInput.value.trim() : "";
  const passwordInput = document.getElementById('input-create-pelada-password');
  const peladaPassword = passwordInput ? passwordInput.value.trim() : "";
  const btn = document.getElementById('btn-create-pelada');

  if (!peladaName || peladaName.length < 3) {
    await showCustomAlert("Por favor, digite um nome para a pelada com no mínimo 3 caracteres.", "Nome Obrigatório");
    if (nameInput) nameInput.focus();
    return;
  }

  if (!peladaPassword || peladaPassword.length < 3) {
    await showCustomAlert("A senha mestra é obrigatória e deve ter no mínimo 3 caracteres. Ela libera a administração da pelada.", "Senha Obrigatória");
    if (passwordInput) passwordInput.focus();
    return;
  }

  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/peladas/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: peladaName, password: peladaPassword })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = (errData && errData.detail)
        ? (Array.isArray(errData.detail) ? errData.detail.map(d => d.msg).join(", ") : errData.detail)
        : "Falha ao gerar nova pelada. Tente novamente.";
      await showCustomAlert(msg, "Erro", false, { icone: 'circle-x' });
      if (btn) btn.disabled = false;
      return;
    }

    const data = await res.json();
    // Quem cria é o Líder da pelada
    setActivePelada(data.code, 'admin');
    state.currentPelada = data;
    state.players = [];
    state.teams = [];
    state.fixtures = [];

    if (window.auditTracker) {
      window.auditTracker.track('create_pelada', 'btn-create-pelada', 'action', {
        code: data.code,
        name: data.name
      });
    }

    // Inicia música aleatória de abertura
    if (window.SoundManager) {
      window.SoundManager.playMusic('abertura');
    }

    // Inicia stream ao vivo de eventos (SSE)
    iniciarLiveEvents(data.code);

    // Oculta tela inicial e exibe aplicação
    setLandingVisibility(false);

    // Redireciona para aba de jogadores
    switchTab('matchmaker');
    renderPeladaHeader();
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();

  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao criar pelada.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function entrarNaPelada() {
  const codeInput = document.getElementById('input-join-code');
  if (!codeInput) return;
  const code = codeInput.value.trim().toUpperCase();

  if (!code || code.length < 5) {
    await showCustomAlert("Por favor, digite o código de 5 caracteres da pelada.", "Código Incompleto");
    return;
  }

  const btn = document.getElementById('btn-join-pelada');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${code}`);
    if (!res.ok) {
      await showCustomAlert("Pelada não encontrada! Verifique o código digitado com o organizador.", "Não Encontrada");
      if (btn) btn.disabled = false;
      return;
    }

    const data = await res.json();
    // Entra como espectador por padrão
    setActivePelada(data.code, data.is_admin ? 'admin' : 'spectator');
    state.currentPelada = data;

    if (data.players && data.players.length > 0) state.players = data.players;
    if (data.teams && data.teams.length > 0) state.teams = data.teams;
    if (data.fixtures && data.fixtures.length > 0) state.fixtures = data.fixtures;
    if (data.config && Object.keys(data.config).length > 0) state.config = { ...state.config, ...data.config };

    setLandingVisibility(false);

    // Inicia música aleatória de abertura
    if (window.SoundManager) {
      window.SoundManager.playMusic('abertura');
    }

    // Inicia stream ao vivo de eventos (SSE)
    iniciarLiveEvents(data.code);

    switchTab('matchmaker');
    renderPoolUI(data.chain_codes);
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();
    await carregarConfiguracoes();
    await atualizarDashboard();
    showToast(`Conectado à pelada #${data.code}!`);
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao acessar a pelada.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

function abrirModalDefinirSenha() {
  abrirModal({
    template: 'tpl-set-password',
    titulo: 'Defina a Senha da Pelada',
    mensagem: 'Passo obrigatório. Esta senha permite reassumir a administração desta pelada se você recarregar a página, trocar de dispositivo ou perder o acesso.',
    icone: 'info',
    tom: 'info',
    largura: 'md',
    cancelavel: false,
    botoes: { ok: 'Confirmar e Iniciar Pelada' },
    validar: validarSenhaMestra,
    aoRenderizar: () => {
      const input = document.getElementById('input-new-pelada-password');
      if (input) {
        input.value = "";
        setTimeout(() => input.focus(), 100);
      }
    }
  });
}

function submeterSenhaMestra(event) {
  event.preventDefault();
  confirmarModalAtual();
}

// Valida e grava a senha. Devolve o aviso (string) ou null para fechar a janela.
async function validarSenhaMestra() {
  const input = document.getElementById('input-new-pelada-password');
  const password = input ? input.value.trim() : "";
  if (password.length < 3) return "A senha precisa ter no mínimo 3 caracteres.";
  if (!state.currentPelada || !state.currentPelada.code) return "Nenhuma pelada ativa no momento.";

  const ok = document.getElementById('app-modal-ok');
  if (ok) ok.disabled = true;
  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/set-password`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      const err = await res.json();
      return err.detail || "Erro ao salvar senha.";
    }
    if (window.auditTracker) {
      window.auditTracker.track('set_pelada_password', 'tpl-set-password', 'security', {
        code: state.currentPelada.code
      });
    }
    showToast("Senha mestra da pelada definida com sucesso!");
    return null;
  } catch (e) {
    console.error(e);
    return "Erro de conexão ao cadastrar senha.";
  } finally {
    if (ok) ok.disabled = false;
  }
}


async function executarAssumirAdmin(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const input = document.getElementById('input-claim-password');
  if (!input) return;
  const password = input.value.trim();

  if (!password) {
    await showCustomAlert("Digite a senha para assumir a administração.", "Aviso");
    return;
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada selecionada.", "Erro", false, { icone: 'circle-x' });
    return;
  }

  const btn = document.getElementById('btn-claim-admin');
  const btnText = document.getElementById('btn-claim-admin-text');

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/claim-admin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });

    const data = await res.json();

    if (res.status === 429) {
      iniciarCooldownAssumirAdmin(15);
      await showCustomAlert(data.detail || "Muitas tentativas. Aguarde 15 segundos.", "Aguarde");
      return;
    }

    if (!res.ok) {
      iniciarCooldownAssumirAdmin(15);
      await showCustomAlert(data.detail || "Senha incorreta.", "Não Autorizado");
      return;
    }

    // Sucesso ao assumir administração
    setActivePelada(state.currentPelada.code, 'admin');
    // Redesenha as listas já com os controles de admin (sem precisar recarregar a página)
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();
    input.value = "";
    showToast("Você assumiu a liderança da pelada com sucesso!");
    await showCustomAlert("Privilégios de Líder ativados com sucesso! Agora você pode gerenciar jogadores, confrontos e placares.", "Administrador Confirmado");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao validar senha.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn && !claimAdminCooldownTimer) btn.disabled = false;
  }
}

function iniciarCooldownAssumirAdmin(seconds) {
  const btn = document.getElementById('btn-claim-admin');
  const btnText = document.getElementById('btn-claim-admin-text');
  if (!btn || !btnText) return;

  btn.disabled = true;
  let remaining = seconds;
  btnText.textContent = `Aguarde ${remaining}s`;

  if (claimAdminCooldownTimer) clearInterval(claimAdminCooldownTimer);

  claimAdminCooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(claimAdminCooldownTimer);
      claimAdminCooldownTimer = null;
      btn.disabled = false;
      btnText.textContent = "Assumir Admin";
    } else {
      btnText.textContent = `Aguarde ${remaining}s`;
    }
  }, 1000);
}

function copiarCodigoPelada() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (!state.currentPelada || !state.currentPelada.code) return;
  navigator.clipboard.writeText(state.currentPelada.code);
  showToast(`Código #${state.currentPelada.code} copiado!`);
}

function copiarLinkPelada() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (!state.currentPelada || !state.currentPelada.code) return;
  const url = `${window.location.origin}${window.location.pathname}?pelada=${state.currentPelada.code}`;
  navigator.clipboard.writeText(url);
  if (window.auditTracker) {
    window.auditTracker.track('share_pelada_link', 'btn-share-link', 'action', { code: state.currentPelada.code, url: url });
  }
  showToast("Link de convite copiado para a área de transferência!");
}

async function sairPelada() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const confirmed = await showCustomConfirm(
    "Deseja sair desta pelada e voltar para a tela inicial?",
    "Trocar de Pelada",
    "Sair da Pelada",
    "Continuar Aqui",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  if (claimAdminCooldownTimer) {
    clearInterval(claimAdminCooldownTimer);
    claimAdminCooldownTimer = null;
  }
  encerrarLiveEvents();

  // Encerra a sessão de admin desta pelada no servidor (o cookie HttpOnly é removido pela resposta)
  const leavingCode = state.currentPelada && state.currentPelada.code;
  if (leavingCode) {
    fetch(`/api/peladas/${leavingCode}/logout`, { method: "POST" }).catch(() => {});
  }
  state.role = 'spectator';

  localStorage.removeItem('futmatch_active_pelada');
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);

  setLandingVisibility(true);
  const inputCode = document.getElementById('input-join-code');
  if (inputCode) inputCode.value = "";
}

// ==============================
// SINCRONIZAÇÃO EM TEMPO REAL - SSE (SERVER-SENT EVENTS)
// ==============================
function iniciarLiveEvents(peladaCode) {
  encerrarLiveEvents();
  if (!peladaCode) return;

  const url = `/api/peladas/${peladaCode}/events`;

  try {
    liveEventSource = new EventSource(url);

    liveEventSource.onopen = () => {
      // Cancela o polling de fallback caso a conexão SSE esteja ativa
      if (livePollFallbackTimer) {
        clearInterval(livePollFallbackTimer);
        livePollFallbackTimer = null;
      }
    };

    liveEventSource.addEventListener('connected', () => {});

    liveEventSource.addEventListener('state_updated', (e) => {
      try {
        const payload = JSON.parse(e.data);
        const data = payload.data || {};
        
        // Se for espectador, atualiza o estado e a UI imediatamente
        if (state.role !== 'admin') {
          if (Array.isArray(data.players)) state.players = data.players;
          if (Array.isArray(data.teams)) state.teams = data.teams;
          if (Array.isArray(data.fixtures)) state.fixtures = data.fixtures;
          if (data.config && typeof data.config === 'object') {
            state.config = { ...state.config, ...data.config };
          }

          renderPlayersList();
          renderTeamsGrid();
          renderFixtures();
        }
      } catch (err) {
        console.error("Erro ao processar state_updated via SSE:", err);
      }
    });

    liveEventSource.addEventListener('match_saved', async () => {
      try {
        if (state.role !== 'admin') {
          // Atualiza as fixtures e o dashboard em tempo real
          await sincronizarDadosRemotosEspectador();
        }
      } catch (err) {
        console.error("Erro ao processar match_saved via SSE:", err);
      }
    });

    liveEventSource.addEventListener('match_deleted', async () => {
      try {
        if (state.role !== 'admin') {
          await sincronizarDadosRemotosEspectador();
        }
      } catch (err) {
        console.error("Erro ao processar match_deleted via SSE:", err);
      }
    });

    liveEventSource.addEventListener('matches_cleared', async () => {
      try {
        if (state.role !== 'admin') {
          await sincronizarDadosRemotosEspectador();
        }
      } catch (err) {
        console.error("Erro ao processar matches_cleared via SSE:", err);
      }
    });

    liveEventSource.addEventListener('pool_updated', async (e) => {
      try {
        const payload = JSON.parse(e.data);
        const data = payload.data || {};
        if (state.currentPelada) {
          state.currentPelada.parent_codes = data.parent_codes;
          state.currentPelada.chain_codes = data.chain_codes;
          state.currentPelada.pool_started_at = data.pool_started_at;
        }
        renderPoolUI(data.chain_codes);
        await atualizarDashboard();
      } catch (err) {
        console.error("Erro ao processar pool_updated via SSE:", err);
      }
    });

    liveEventSource.addEventListener('info_updated', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (state.currentPelada) {
          state.currentPelada.description = (payload.data || {}).description || '';
        }
        renderPeladaHeader();
      } catch (err) {
        console.error("Erro ao processar info_updated via SSE:", err);
      }
    });

    liveEventSource.onerror = () => {
      // Ativa salvaguarda de polling leve a cada 8 segundos se o stream falhar
      if (!livePollFallbackTimer && state.role !== 'admin') {
        livePollFallbackTimer = setInterval(sincronizarDadosRemotosEspectador, 8000);
      }
    };
  } catch (err) {
    console.warn("Navegador não suporta EventSource ou erro ao iniciar SSE:", err);
    if (!livePollFallbackTimer && state.role !== 'admin') {
      livePollFallbackTimer = setInterval(sincronizarDadosRemotosEspectador, 8000);
    }
  }
}

async function sincronizarDadosRemotosEspectador() {
  if (!state.currentPelada || !state.currentPelada.code) return;
  if (state.role === 'admin') return;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}`);
    if (res.ok) {
      const data = await res.json();
      state.players = data.players || [];
      state.teams = data.teams || [];
      state.fixtures = data.fixtures || [];
      if (data.config) state.config = { ...state.config, ...data.config };

      renderPlayersList();
      renderTeamsGrid();
      renderFixtures();
      await atualizarDashboard();
    }
  } catch (err) {
    console.error("Falha ao sincronizar dados remotos do espectador:", err);
  }
}

function encerrarLiveEvents() {
  if (liveEventSource) {
    liveEventSource.close();
    liveEventSource = null;
  }
  if (livePollFallbackTimer) {
    clearInterval(livePollFallbackTimer);
    livePollFallbackTimer = null;
  }
}

// ==============================
// GESTÃO DA POOL DE PELADAS (HISTÓRICO EM CORRENTE)
// ==============================
const NOME_JOGADOR_MAX = 60;
const MAX_POOLS_POR_PELADA = 10; // mesmo limite do servidor (app/domain/pool_graph.py)
let poolLink = null; // estado da janela de vínculo: { parentCodes, candidates, rows, pendingRowId }

function normalizarNome(nome) {
  return (nome || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function encontrarNaPool(nome) {
  if (!poolLink) return [];
  const alvo = normalizarNome(nome);
  return poolLink.candidates.filter(c => normalizarNome(c.name) === alvo);
}

async function salvarPoolPeladas(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const input = document.getElementById('input-parent-pelada-code');
  if (!input) return;
  const parentCode = input.value.trim().toUpperCase();

  if (!parentCode || parentCode.length < 5) {
    await showCustomAlert("Digite o código de 5 caracteres da pelada anterior a ser vinculada.", "Código Inválido", false, { icone: 'circle-x' });
    return;
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada ativa.", "Erro", false, { icone: 'circle-x' });
    return;
  }

  if (parentCode === state.currentPelada.code) {
    await showCustomAlert("Você não pode vincular uma pelada a ela mesma!", "Aviso");
    return;
  }

  const atuais = state.currentPelada.parent_codes || [];
  if (atuais.includes(parentCode)) {
    await showCustomAlert(`A pelada #${parentCode} já está vinculada a esta pelada.`, "Pool Já Vinculada", false, { icone: 'info' });
    return;
  }
  if (atuais.length >= MAX_POOLS_POR_PELADA) {
    await showCustomAlert(`Uma pelada pode ter no máximo ${MAX_POOLS_POR_PELADA} pools.`, "Limite de Pools", false, { icone: 'triangle-alert' });
    return;
  }
  const parents = [...atuais, parentCode];
  if (state.players.length === 0) {
    await enviarVinculoPool(parents, [], []);
    return;
  }
  await abrirVinculoPool(parents);
}

// Janela 1: cada jogador da pelada atual recebe um jogador das pools ou entra como novo
async function abrirVinculoPool(parentCodes) {
  const btn = document.getElementById('btn-save-pool');
  if (btn) btn.disabled = true;
  try {
    const query = parentCodes.map(c => `parent_code=${encodeURIComponent(c)}`).join('&');
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool-candidates?${query}`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (!res.ok) {
      await showCustomAlert(data.detail || "Não foi possível carregar os jogadores da pool.", "Erro no Vínculo", false, { icone: 'circle-x' });
      return;
    }
    poolLink = { parentCodes, candidates: data.candidates, rows: [], pendingRowId: null };
    // Vínculos já gravados aparecem preenchidos; sem vínculo, homônimo na pool já sai selecionado
    poolLink.rows = state.players.map(p => {
      const gravado = data.links[p.id];
      const casa = encontrarNaPool(p.name);
      return { id: p.id, name: p.name, choice: gravado || (casa.length ? casa[0].id : ''), newName: null };
    });

    const resultado = await abrirModal({
      titulo: 'Vincular pelada à pool',
      mensagem: `Pool: ${parentCodes.map(c => `#${c}`).join(', ')}`,
      icone: 'info',
      tom: 'info',
      largura: 'lg',
      corpo: (el) => {
        el.innerHTML = '<div id="pool-link-list" class="space-y-2 max-h-[55vh] overflow-y-auto pr-1"></div>';
        renderPoolLinkRows();
      },
      botoes: { ok: 'Confirmar', cancel: 'Cancelar' },
      validar: validarVinculoPool
    });

    if (resultado.acao !== 'ok' || !poolLink) {
      poolLink = null;
      return;
    }
    const links = poolLink.rows.filter(r => r.choice).map(r => ({ player_id: r.id, pool_player_id: r.choice }));
    const renames = poolLink.rows.filter(r => !r.choice && r.newName).map(r => ({ player_id: r.id, name: r.newName }));
    const parentsFinal = poolLink.parentCodes;
    poolLink = null;
    await enviarVinculoPool(parentsFinal, links, renames);
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao buscar os jogadores da pool.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Confirmação do vínculo: jogador novo com homônimo na pool abre a renomeação antes de enviar
async function validarVinculoPool() {
  if (!poolLink) return null;
  for (const row of poolLink.rows) {
    if (!row.choice && encontrarNaPool(row.newName || row.name).length) {
      await renomearJogadorPool(row.id);
      return false; // volta para a janela de vínculo, que é redesenhada com a escolha
    }
  }
  return null;
}

function renderPoolLinkRows() {
  const list = document.getElementById('pool-link-list');
  if (!list || !poolLink) return;
  list.innerHTML = poolLink.rows.map(row => {
    const nome = row.newName || row.name;
    const selecionado = (id) => (row.choice === id ? 'selected' : '');
    // Jogador da pool já escolhido em outra linha não aparece aqui (evita vincular duas vezes)
    const escolhidosEmOutras = new Set(poolLink.rows.filter(r => r.id !== row.id && r.choice).map(r => r.choice));
    const opcoes = `<option value="" ${row.choice ? '' : 'selected'}>Novo jogador</option>` +
      poolLink.candidates.filter(c => !escolhidosEmOutras.has(c.id) || c.id === row.choice)
        .map(c => `<option value="${escapeHtml(c.id)}" ${selecionado(c.id)}>${escapeHtml(c.name)} · ${escapeHtml(c.source)}</option>`).join('');
    return `
      <div class="flex items-center justify-between gap-3 p-2.5 bg-card/60 border border-borderLight/40 rounded-xl">
        <div class="min-w-0 flex items-center gap-2">
          <span class="text-sm font-semibold text-white truncate">${escapeHtml(nome)}</span>
          ${row.newName ? '<span class="text-[10px] font-bold text-amber-400">renomeado</span>' : ''}
        </div>
        <select data-h-change="onPoolLinkChange" data-a="${escapeHtml(JSON.stringify([row.id]))}" aria-label="Vínculo de ${escapeHtml(nome)}" class="max-w-[55%] bg-surface border border-borderLight rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-purple-400">${opcoes}</select>
      </div>`;
  }).join('');
}

async function onPoolLinkChange(rowId) {
  const row = poolLink && poolLink.rows.find(r => r.id === rowId);
  if (!row) return;
  if (this.value) {
    row.choice = this.value;
    row.newName = null;
    renderPoolLinkRows();
    return;
  }
  // "Novo jogador" escolhido: se o nome já existe na pool, abre a renomeação
  row.choice = '';
  if (encontrarNaPool(row.newName || row.name).length) {
    await renomearJogadorPool(rowId);
  }
  renderPoolLinkRows();
}

// Janela de renomear jogador novo (aninhada sobre a janela de vínculo)
async function renomearJogadorPool(rowId) {
  const row = poolLink && poolLink.rows.find(r => r.id === rowId);
  if (!row) return;
  const homonimo = encontrarNaPool(row.name)[0] || encontrarNaPool(row.newName || row.name)[0];
  const resultado = await abrirModal({
    titulo: 'Renomear jogador',
    mensagem: `"${homonimo ? homonimo.name : (row.newName || row.name)}" já existe na pool.`,
    icone: 'info',
    tom: 'info',
    largura: 'md',
    campo: { valor: row.newName || row.name, maxlength: NOME_JOGADOR_MAX, placeholder: 'Novo nome' },
    botoes: { ok: 'Confirmar', cancel: 'Cancelar' },
    validar: (valor) => validarNomeNaPool(row, valor)
  });
  if (resultado.acao !== 'ok') return;
  const novo = limparNomeJogador(resultado.valor);
  row.choice = '';
  row.newName = novo === row.name ? null : novo;
}

function limparNomeJogador(valor) {
  return (valor || '').replace(/\s+/g, ' ').trim();
}

function validarNomeNaPool(row, valor) {
  const novo = limparNomeJogador(valor);
  if (!novo) return "Digite um nome para o jogador.";
  if (novo.length > NOME_JOGADOR_MAX) return `Use no máximo ${NOME_JOGADOR_MAX} caracteres.`;
  if (poolLink.rows.some(r => r.id !== row.id && normalizarNome(r.newName || r.name) === normalizarNome(novo))) {
    return "Já existe um jogador com este nome nesta pelada.";
  }
  const casa = encontrarNaPool(novo);
  if (casa.length) return `"${casa[0].name}" já existe na pool. Escolha outro nome.`;
  return null;
}

async function enviarVinculoPool(parentCodes, links, renames) {
  const input = document.getElementById('input-parent-pelada-code');
  const btn = document.getElementById('btn-save-pool');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ parent_codes: parentCodes, links, renames })
    });

    const data = await res.json();

    if (!res.ok) {
      await showCustomAlert(data.detail || "Erro ao vincular pelada à pool.", "Erro no Vínculo", false, { icone: 'circle-x' });
      return;
    }

    state.currentPelada.parent_codes = data.parent_codes;
    state.currentPelada.chain_codes = data.chain_codes;
    state.currentPelada.pool_started_at = data.pool_started_at;
    if (input) input.value = "";

    if (renames.length) await recarregarEstadoPelada();
    renderPoolUI(data.chain_codes);
    await atualizarDashboard();
    showToast("Pelada vinculada com sucesso à corrente da Pool!");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao vincular peladas.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Busca do servidor os jogadores após renomeações feitas no vínculo
async function recarregarEstadoPelada() {
  const res = await fetch(`/api/peladas/${state.currentPelada.code}`, { headers: getAuthHeaders() });
  if (!res.ok) return;
  const d = await res.json();
  state.players = d.players;
  state.teams = d.teams;
  state.fixtures = d.fixtures;
  renderPlayersList();
  renderTeamsGrid();
  renderFixtures();
}

// Renomeação direta na lista de jogadores (duplo clique), como nos times
function editarNomeJogador(playerId) {
  const p = state.players.find(x => x.id === playerId);
  const nomeEl = document.getElementById(`nome-jogador-${playerId}`);
  if (!p || !nomeEl || nomeEl.querySelector('input')) return;

  const linha = nomeEl.closest('[data-player-id]');
  if (linha) linha.draggable = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = p.name;
  input.maxLength = NOME_JOGADOR_MAX;
  input.className = 'w-full bg-pitch border border-neon-accent rounded-lg px-2 py-0.5 text-sm font-semibold text-white focus:outline-none';
  nomeEl.textContent = '';
  nomeEl.appendChild(input);
  input.focus();
  input.select();

  let encerrado = false;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!encerrado) { encerrado = true; renomearJogador(playerId, input.value); } }
    if (e.key === 'Escape') { e.preventDefault(); if (!encerrado) { encerrado = true; renderPlayersList(); } }
  });
  input.addEventListener('blur', () => {
    if (!encerrado) { encerrado = true; renomearJogador(playerId, input.value); }
  });
}

function renomearJogador(playerId, digitado) {
  const p = state.players.find(x => x.id === playerId);
  if (!p) return;
  const novo = (digitado || '').replace(/\s+/g, ' ').trim();

  if (!novo || novo === p.name) { renderPlayersList(); return; }
  if (novo.length > NOME_JOGADOR_MAX) {
    showToast(`Use no máximo ${NOME_JOGADOR_MAX} caracteres.`);
    renderPlayersList();
    return;
  }
  if (state.players.some(x => x.id !== playerId && normalizarNome(x.name) === normalizarNome(novo))) {
    showToast(`Já existe um jogador chamado "${novo}".`);
    renderPlayersList();
    return;
  }

  p.name = novo;
  state.teams.forEach(t => (t.players || []).forEach(q => { if (q.id === playerId) q.name = novo; }));
  state.fixtures.forEach(f => {
    [f.home_players, f.away_players].forEach(lista => (lista || []).forEach(q => { if (q.id === playerId) q.name = novo; }));
    (f.events || []).forEach(ev => { if (ev.player_id === playerId) ev.player_name = novo; });
  });
  renderPlayersList();
  renderTeamsGrid();
  renderFixtures();
  sincronizarEstadoServidor();
}

// Estado da corrente vindo do servidor (depois de vincular, remover uma pool ou todas)
function aplicarEstadoPool(data) {
  if (!state.currentPelada) return;
  state.currentPelada.parent_codes = data.parent_codes || [];
  state.currentPelada.chain_codes = data.chain_codes || [state.currentPelada.code];
  state.currentPelada.pool_started_at = data.pool_started_at;
  renderPoolUI(state.currentPelada.chain_codes);
}

async function desvincularPool() {
  const confirmed = await showCustomConfirm(
    "Deseja remover todas as pools desta pelada? Os vínculos de jogadores serão desfeitos e o histórico voltará a considerar apenas esta pelada.",
    "Remover Todas as Pools",
    "Remover todas",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ parent_codes: [] })
    });
    const data = await res.json();
    if (res.ok) {
      aplicarEstadoPool(data);
      await atualizarDashboard();
      showToast("Pools removidas desta pelada!");
    }
  } catch (e) {
    console.error(e);
  }
}

async function removerPool(parentCode) {
  const confirmed = await showCustomConfirm(
    `Remover a pool #${parentCode} desta pelada? Os vínculos de jogadores com ela serão desfeitos. As outras pools continuam.`,
    "Remover Pool",
    "Remover",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool/${encodeURIComponent(parentCode)}`, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    const data = await res.json();
    if (!res.ok) {
      await showCustomAlert(data.detail || "Não foi possível remover a pool.", "Erro no Vínculo", false, { icone: 'circle-x' });
      return;
    }
    aplicarEstadoPool(data);
    await atualizarDashboard();
    showToast(`Pool #${parentCode} removida desta pelada!`);
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao remover a pool.", "Erro", false, { icone: 'circle-x' });
  }
}

// ==============================
// BACKUP DA PELADA (EXPORTAR / IMPORTAR JSON)
// ==============================
async function exportarPelada() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada ativa.", "Erro", false, { icone: 'circle-x' });
    return;
  }

  const code = state.currentPelada.code;
  const btn = document.getElementById('btn-export-pelada');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${code}/export`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      await showCustomAlert(data.detail || "Erro ao exportar a pelada.", "Erro", false, { icone: 'circle-x' });
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `futmatch-${code}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Pelada exportada!");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao exportar a pelada.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

function mostrarArquivoImportacao() {
  const input = document.getElementById('input-import-file');
  const nome = document.getElementById('import-file-name');
  if (!nome) return;
  const arquivo = input && input.files ? input.files[0] : null;
  nome.textContent = arquivo ? arquivo.name : 'Nenhum arquivo escolhido';
  nome.classList.toggle('text-white', !!arquivo);
  nome.classList.toggle('text-slate-400', !arquivo);
}

async function importarPelada(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada ativa.", "Erro", false, { icone: 'circle-x' });
    return;
  }
  const fileInput = document.getElementById('input-import-file');
  const file = fileInput && fileInput.files ? fileInput.files[0] : null;
  if (!file) {
    await showCustomAlert("Escolha o arquivo JSON exportado.", "Arquivo Obrigatório", false, { icone: 'circle-x' });
    return;
  }

  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (e) {
    await showCustomAlert("O arquivo não é um JSON válido.", "Arquivo Inválido");
    return;
  }

  const confirmado = await showCustomConfirm(
    "Os dados atuais desta pelada (histórico, jogadores, times e configurações) serão substituídos pelo arquivo. Esta ação não pode ser desfeita.",
    "Substituir a pelada?",
    "Substituir",
    "Cancelar"
  );
  if (!confirmado) return;

  const code = state.currentPelada.code;
  const btn = document.getElementById('btn-import-pelada');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${code}/import`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(backup)
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = Array.isArray(data.detail)
        ? data.detail.map(d => d.msg).join(", ")
        : (data.detail || "Não foi possível importar a pelada.");
      await showCustomAlert(msg, "Erro na Importação", false, { icone: 'circle-x' });
      return;
    }

    if (data.warnings && data.warnings.length) {
      await showCustomAlert(data.warnings.join("\n"), "Pelada Substituída");
    } else {
      showToast("Pelada substituída com sucesso!");
    }
    // Recarrega para a tela mostrar os dados importados desde o início
    window.location.reload();
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao importar a pelada.", "Erro", false, { icone: 'circle-x' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderPoolUI(chainCodes) {
  renderPeladaHeader();
  const codes = chainCodes || (state.currentPelada && state.currentPelada.chain_codes) || [state.currentPelada?.code];
  const count = codes.length;

  // Status Badge no Menu Ajustes
  const badgeStatus = document.getElementById('badge-pool-status');
  if (badgeStatus) {
    if (count > 1) {
      badgeStatus.textContent = `${count} Peladas em Corrente`;
      badgeStatus.className = 'text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30';
      badgeStatus.classList.remove('hidden');
    } else {
      badgeStatus.textContent = '';
      badgeStatus.classList.add('hidden');
    }
  }

  // Container de Badges de Corrente no Menu Ajustes
  const chainContainer = document.getElementById('pool-chain-container');
  const chainBadges = document.getElementById('pool-chain-badges');
  if (chainContainer && chainBadges) {
    if (count > 1) {
      chainContainer.classList.remove('hidden');
      // X só nas pools diretas desta pelada (as indiretas somem quando a pool que as traz sai)
      const diretas = (state.currentPelada && state.currentPelada.parent_codes) || [];
      const ehAdmin = state.role === 'admin';
      chainBadges.innerHTML = codes.map((c, idx) => `
        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg ${idx === 0 ? 'bg-purple-600 text-white shadow' : 'bg-card border border-borderLight text-slate-300'}">
          ${idx === 0 ? '⭐ Atual:' : '🔗'} #${escapeHtml(c)}
          ${ehAdmin && idx > 0 && diretas.includes(c) ? `
            <button type="button" data-h-click="removerPool" data-a="${escapeHtml(JSON.stringify([c]))}" title="Remover pool #${escapeHtml(c)}" aria-label="Remover pool #${escapeHtml(c)}" class="w-4 h-4 rounded-full bg-rose-500/20 hover:bg-rose-500 text-rose-400 hover:text-white flex items-center justify-center transition active:scale-95 ml-0.5">
              <i data-lucide="x" class="w-3 h-3 stroke-[2.5]"></i>
            </button>` : ''}
        </span>
      `).join("");
    } else {
      chainContainer.classList.add('hidden');
      chainBadges.innerHTML = "";
    }
  }

  // Banner Informativo no Dashboard
  const dashBanner = document.getElementById('dashboard-pool-banner');
  const dashCount = document.getElementById('dashboard-pool-count');
  const dashChips = document.getElementById('dashboard-pool-chips');
  if (dashBanner && dashCount && dashChips) {
    if (count > 1) {
      dashBanner.classList.remove('hidden');
      dashCount.textContent = `${count} Peladas Unidas`;
      dashChips.innerHTML = codes.map((c, idx) => `
        <span class="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] ${idx === 0 ? 'bg-purple-500/30 text-purple-200 border border-purple-400/40' : 'bg-surface/80 text-slate-400 border border-borderLight'}">
          #${escapeHtml(c)}
        </span>
      `).join("");
    } else {
      dashBanner.classList.add('hidden');
    }
  }

  refreshIcons();
}

// Sincroniza o estado atual (jogadores, times, confrontos) com o servidor SQLite
// Times só têm jogadores da lista e partidas só usam times existentes
function sanearEstadoLocal() {
  const ids = new Set((state.players || []).map(p => p.id));
  (state.teams || []).forEach(t => { t.players = (t.players || []).filter(p => ids.has(p.id)); });
  const teamIds = new Set((state.teams || []).map(t => t.id));
  state.fixtures = (state.fixtures || []).filter(f =>
    (!f.home_team_id || teamIds.has(f.home_team_id)) && (!f.away_team_id || teamIds.has(f.away_team_id)));
}

function sincronizarEstadoServidor(immediate = false) {
  if (!state.currentPelada || !state.currentPelada.code) return;
  if (state.role !== 'admin') return;

  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);

  const executarSync = async () => {
    try {
      sanearEstadoLocal();
      const res = await fetch(`/api/peladas/${state.currentPelada.code}/sync-state`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          players: state.players,
          teams: state.teams,
          fixtures: state.fixtures,
          config: state.config
        })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error("Sincronização recusada:", err.detail || res.status);
        if (err.detail) showToast(String(err.detail));
      }
    } catch (e) {
      console.error("Erro ao sincronizar estado com o servidor:", e);
    }
  };

  if (immediate) {
    executarSync();
  } else {
    syncDebounceTimer = setTimeout(executarSync, 200);
  }
}

// Controle do botão de som / mudo (toggle)
function atualizarBotaoSomUI() {
  const btn = document.getElementById('btn-toggle-sound');
  if (!btn) return;

  const isMuted = window.SoundManager ? window.SoundManager.settings.muted : false;
  if (isMuted) {
    btn.innerHTML = `<i id="sound-toggle-icon" data-lucide="volume-x" class="w-4 h-4 text-rose-500"></i>`;
    btn.title = 'Som desativado (Clique para ativar)';
    btn.classList.add('border-rose-500/50', 'hover:border-rose-500', 'text-rose-500', 'hover:text-rose-400');
    btn.classList.remove('border-borderLight', 'hover:border-neon-accent/50', 'text-slate-300', 'hover:text-neon-accent');
  } else {
    btn.innerHTML = `<i id="sound-toggle-icon" data-lucide="volume-2" class="w-4 h-4 text-neon-accent"></i>`;
    btn.title = 'Som ativado (Clique para mutar)';
    btn.classList.remove('border-rose-500/50', 'hover:border-rose-500', 'text-rose-500', 'hover:text-rose-400');
    btn.classList.add('border-borderLight', 'hover:border-neon-accent/50', 'text-slate-300', 'hover:text-neon-accent');
  }
  refreshIcons();
}

function toggleSoundMute() {
  if (window.SoundManager) {
    window.SoundManager.toggleMute();
    if (!window.SoundManager.settings.muted) {
      window.SoundManager.play('efeitos');
    }
  }
  atualizarBotaoSomUI();
}

// ==============================
// INICIALIZAÇÃO & TABS
// ==============================
document.addEventListener("DOMContentLoaded", async () => {
  updateTabPanesVisibility(0);
  switchTab('matchmaker');
  atualizarBotaoSomUI();
  const elStarsBoot = document.getElementById("cfg-stars-pct");
  if (elStarsBoot) {
    elStarsBoot.value = BALANCE_STARS_PCT_PADRAO;
    atualizarRotuloEstrelas(elStarsBoot);
  }
  await inicializarPelada();
  atualizarIndicadorNav();
  refreshIcons();

  const playersList = document.getElementById("players-list-container");
  if (playersList) {
    playersList.addEventListener("scroll", updatePlayersScrollIndicator, { passive: true });
  }
  const scorersList = document.getElementById("list-scorers");
  if (scorersList) {
    scorersList.addEventListener("scroll", updateScorersScrollIndicator, { passive: true });
  }
  const winnersList = document.getElementById("list-winners");
  if (winnersList) {
    winnersList.addEventListener("scroll", updateWinnersScrollIndicator, { passive: true });
  }
  window.addEventListener("resize", () => {
    updatePlayersScrollIndicator();
    updateScorersScrollIndicator();
    updateWinnersScrollIndicator();
  }, { passive: true });
});


let currentActiveTab = 'matchmaker';
let tabSlideTimeout = null;
let resizeDebounceTimeout = null;

function updateTabPanesVisibility(targetIndex) {
  const panes = document.querySelectorAll('.tab-slide-pane');
  panes.forEach((pane, idx) => {
    if (idx === targetIndex) {
      pane.classList.remove('tab-inactive');
    } else {
      pane.classList.add('tab-inactive');
    }
  });
}

function updateSliderPosition(animate = true) {
  const sections = ['matchmaker', 'fixtures', 'dashboard', 'settings'];
  const targetIndex = sections.indexOf(currentActiveTab);
  if (targetIndex === -1) return;

  const slider = document.getElementById('tabs-slider');
  if (slider) {
    if (!animate) {
      slider.style.transition = 'none';
    }
    // Define a variável CSS que controla a posição com fórmula percentual responsiva
    document.documentElement.style.setProperty('--active-tab-index', targetIndex);
    slider.style.transform = '';

    if (!animate) {
      // Força reflow para aplicar instantaneamente
      void slider.offsetHeight;
      slider.style.transition = '';
    }
  }
}

// Reposiciona as abas responsivamente durante o redimensionamento da janela
window.addEventListener('resize', () => {
  if (resizeDebounceTimeout) {
    clearTimeout(resizeDebounceTimeout);
  }
  updateSliderPosition(false);
  resizeDebounceTimeout = setTimeout(() => {
    const sections = ['matchmaker', 'fixtures', 'dashboard', 'settings'];
    const targetIndex = sections.indexOf(currentActiveTab);
    if (targetIndex !== -1) {
      updateTabPanesVisibility(targetIndex);
    }
  }, 100);
});

function switchTab(tabId) {
  const sections = ['matchmaker', 'fixtures', 'dashboard', 'settings'];
  const targetIndex = sections.indexOf(tabId);
  if (targetIndex === -1) return;

  if (tabId !== 'settings') {
    pararPreviewAlarme();
  }

  currentActiveTab = tabId;

  // Garante que a página sempre volte ao topo para evitar cair em áreas vazias
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

  const panes = document.querySelectorAll('.tab-slide-pane');

  if (tabSlideTimeout) {
    clearTimeout(tabSlideTimeout);
    tabSlideTimeout = null;
  }

  // Durante a animação de transição, todos os painéis precisam estar visíveis
  panes.forEach(pane => pane.classList.remove('tab-inactive'));

  // Atualiza posição utilizando a variável CSS vinculada à fórmula fluida
  updateSliderPosition(true);

  // Ao término do deslize do slider (380ms), esconde o excesso vertical das abas inativas
  tabSlideTimeout = setTimeout(() => {
    updateTabPanesVisibility(targetIndex);
  }, 400);

  // Atualiza os botões de navegação desktop e mobile
  sections.forEach((s, idx) => {
    const btn = document.getElementById(`tab-btn-${s}`);
    const btnMobile = document.getElementById(`tab-btn-mobile-${s}`);

    if (btn) {
      if (idx === targetIndex) {
        btn.classList.add('active', 'text-black');
        btn.classList.remove('text-slate-400');
      } else {
        btn.classList.remove('active', 'text-black');
        btn.classList.add('text-slate-400');
      }
    }
    if (btnMobile) {
      if (idx === targetIndex) {
        btnMobile.classList.add('text-neon-accent');
        btnMobile.classList.remove('text-slate-400');
      } else {
        btnMobile.classList.remove('text-neon-accent');
        btnMobile.classList.add('text-slate-400');
      }
    }
  });

  atualizarIndicadorNav();

  if (tabId === 'dashboard') {
    atualizarDashboard();
  }
  refreshIcons();
}

// Posiciona o retângulo verde atrás da aba ativa da navegação desktop
function atualizarIndicadorNav() {
  const pill = document.getElementById('nav-tab-pill');
  if (!pill) return;
  const btn = document.querySelector('nav .nav-tab.active');
  if (!btn || btn.offsetWidth === 0) {
    pill.style.opacity = '0';
    // Se o elemento acabou de ficar visível mas ainda não teve layout calculado pelo navegador
    if (btn && btn.offsetParent !== null) {
      requestAnimationFrame(() => {
        if (btn.offsetWidth > 0) {
          pill.style.width = `${btn.offsetWidth}px`;
          pill.style.height = `${btn.offsetHeight}px`;
          pill.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
          pill.style.opacity = '1';
        }
      });
    }
    return;
  }
  pill.style.width = `${btn.offsetWidth}px`;
  pill.style.height = `${btn.offsetHeight}px`;
  pill.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
  pill.style.opacity = '1';
}
window.addEventListener('resize', atualizarIndicadorNav);
window.addEventListener('load', atualizarIndicadorNav);

function showToast(msg) {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  if (!toast || !toastMsg) return;
  // Sempre texto puro: mensagens podem conter nomes digitados por usuários
  toastMsg.textContent = msg;
  toast.classList.remove("translate-y-24", "opacity-0");
  setTimeout(() => {
    toast.classList.add("translate-y-24", "opacity-0");
  }, 2500);
}

// ===== Janela modal única do sistema =====
// Pilha de janelas: só a do topo aparece. abrirModal() devolve Promise<{acao:'ok'|'cancel', valor}>.
// Opções: titulo, mensagem (mensagemHtml), icone, tom ('info'|'alerta'|'perigo'), largura ('md'|'lg'|'xl'),
// template (id de <template> com o conteúdo), corpo (function(elemento)), campo {valor, maxlength, placeholder},
// botoes {ok, cancel} (sem botoes = sem rodapé), cancelavel (padrão true), validar(valor) -> null | texto de aviso | false,
// aoRenderizar() (roda a cada desenho, para preencher conteúdo de template).
const APP_MODAL = { pilha: [] };
// Modelo de cor dos modais: cada tom tem a cor do ícone (icone), a caixa do ícone (caixa)
// e a cor do botão principal (botao), que é SEMPRE a mesma cor do ícone.
const TONS_MODAL = {
  info: { caixa: 'caixa-info', icone: 'icone-info', botao: 'bg-sky-400 hover:bg-sky-300 text-black shadow' },
  sucesso: { caixa: 'caixa-sucesso', icone: 'icone-sucesso', botao: 'bg-neon-accent hover:bg-emerald-400 text-black shadow' },
  aviso: { caixa: 'caixa-aviso', icone: 'icone-aviso', botao: 'bg-amber-400 hover:bg-amber-300 text-black shadow' },
  erro: { caixa: 'caixa-erro', icone: 'icone-erro', botao: 'bg-red-500 hover:bg-red-600 text-white shadow' }
};
// Ícone do cabeçalho escolhe o tom (ícone de informação = info, + = sucesso, ! = aviso, X = erro)
const ICONES_STATUS = {
  'info': 'info',
  'plus-circle': 'sucesso',
  'triangle-alert': 'aviso',
  'circle-x': 'erro'
};
// Tons antigos (sem ícone de status) continuam funcionando
const TOM_LEGADO = { info: 'info', alerta: 'aviso', perigo: 'aviso' };
const LARGURAS_MODAL = { md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl', '2xl': 'max-w-2xl' };

function topoModal() {
  return APP_MODAL.pilha[APP_MODAL.pilha.length - 1] || null;
}

function renderizarModalAtual() {
  const raiz = document.getElementById('app-modal');
  if (!raiz) return;
  const topo = topoModal();
  if (!topo) {
    raiz.classList.add('hidden');
    document.getElementById('app-modal-corpo').innerHTML = '';
    return;
  }
  const o = topo.opts;
  const tom = TONS_MODAL[ICONES_STATUS[o.icone || 'info'] || TOM_LEGADO[o.tom]] || TONS_MODAL.info;

  document.getElementById('app-modal-box').className =
    `bg-surface border border-borderLight rounded-3xl w-full ${LARGURAS_MODAL[o.largura] || 'max-w-md'} shadow-2xl relative animate-in fade-in zoom-in-95`;

  // Cabeçalho: só aparece quando há título ou mensagem (templates trazem o próprio)
  const cabecalho = document.getElementById('app-modal-cabecalho');
  const temCabecalho = !!(o.titulo || o.mensagem);
  cabecalho.classList.toggle('hidden', !temCabecalho);
  if (temCabecalho) {
    document.getElementById('app-modal-titulo').textContent = o.titulo || '';
    const msg = document.getElementById('app-modal-mensagem');
    if (o.mensagemHtml) msg.innerHTML = o.mensagem || ''; else msg.textContent = o.mensagem || '';
    msg.classList.toggle('hidden', !o.mensagem);
    const caixa = document.getElementById('app-modal-icone-caixa');
    const iconeNome = o.icone || 'info';
    caixa.className = `w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 ${tom.caixa}`;
    caixa.innerHTML = `<i data-lucide="${iconeNome}" class="w-6 h-6 ${tom.icone}"></i>`;
  }

  // Corpo: template clonado ou função que desenha o conteúdo
  const corpo = document.getElementById('app-modal-corpo');
  corpo.innerHTML = '';
  if (o.template) {
    const tpl = document.getElementById(o.template);
    if (tpl) corpo.appendChild(tpl.content.cloneNode(true));
  } else if (typeof o.corpo === 'function') {
    o.corpo(corpo);
  }
  corpo.classList.toggle('hidden', !corpo.childNodes.length);
  // Sem cabeçalho, o corpo precisa do próprio espaço no topo
  corpo.classList.toggle('pt-6', !temCabecalho);

  // Campo de texto opcional
  const campo = document.getElementById('app-modal-campo');
  const input = document.getElementById('app-modal-input');
  campo.classList.toggle('hidden', !o.campo);
  limparAvisoModal();
  if (o.campo) {
    input.value = o.campo.valor || '';
    if (o.campo.maxlength) input.maxLength = o.campo.maxlength; else input.removeAttribute('maxlength');
    input.placeholder = o.campo.placeholder || '';
  }

  // Rodapé: só quando há botões
  const rodape = document.getElementById('app-modal-rodape');
  rodape.classList.toggle('hidden', !o.botoes);
  if (o.botoes) {
    const ok = document.getElementById('app-modal-ok');
    ok.textContent = o.botoes.ok || 'OK';
    ok.className = `px-5 py-2 text-xs font-bold rounded-xl transition ${tom.botao}`;
    ok._base = ok.className;
    const cancelar = document.getElementById('app-modal-cancelar');
    cancelar.textContent = o.botoes.cancel || 'Cancelar';
    cancelar.classList.toggle('hidden', !o.botoes.cancel);
  }

  document.getElementById('app-modal-x').classList.toggle('hidden', o.cancelavel === false);
  raiz.classList.remove('hidden');
  refreshIcons();
  if (o.campo) { input.focus(); input.select(); }
  if (typeof o.aoRenderizar === 'function') o.aoRenderizar();
}

function abrirModal(opts = {}) {
  return new Promise((resolve) => {
    // Mesmo template aberto de novo substitui a janela anterior dele
    const topo = topoModal();
    if (opts.template && topo && topo.opts.template === opts.template) {
      APP_MODAL.pilha.pop();
      topo.resolve({ acao: 'cancel', valor: null });
    }
    APP_MODAL.pilha.push({ opts, resolve, valor: null });
    renderizarModalAtual();
  });
}

function fecharModal(acao = 'cancel') {
  const topo = APP_MODAL.pilha.pop();
  if (!topo) return;
  topo.resolve({ acao, valor: topo.valor });
  renderizarModalAtual();
}

// Fecha só se a janela do topo for a do template informado (evita fechar outra por engano)
function fecharModalDoTemplate(template) {
  const topo = topoModal();
  if (topo && topo.opts.template === template) fecharModal('ok');
}

function limparAvisoModal() {
  const aviso = document.getElementById('app-modal-aviso');
  if (aviso) { aviso.textContent = ''; aviso.classList.add('hidden'); }
}

// Resposta inválida: aviso abaixo do campo e botão vermelho que treme por 1s
function avisarModal(mensagem) {
  const aviso = document.getElementById('app-modal-aviso');
  if (aviso) { aviso.textContent = mensagem; aviso.classList.remove('hidden'); }
  const ok = document.getElementById('app-modal-ok');
  if (!ok || ok.classList.length === 0) return;
  clearTimeout(ok._piscaTimer);
  ok.className = 'px-5 py-2 text-xs font-bold rounded-xl transition shadow bg-rose-500 text-white';
  ok._piscaTimer = setTimeout(() => { ok.className = ok._base; }, 1000);
  ok.animate([
    { transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' },
    { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }
  ], { duration: 400 });
}

async function confirmarModalAtual() {
  const topo = topoModal();
  if (!topo) return;
  const o = topo.opts;
  const valor = o.campo ? document.getElementById('app-modal-input').value : null;
  topo.valor = valor;
  if (typeof o.validar === 'function') {
    const resposta = await o.validar(valor);
    // Durante a validação outra janela pode ter sido aberta/fechada
    if (topoModal() !== topo) return;
    if (resposta === false) { renderizarModalAtual(); return; }
    if (typeof resposta === 'string') { avisarModal(resposta); return; }
  }
  fecharModal('ok');
}

(function ligarModalUnico() {
  const raiz = document.getElementById('app-modal');
  if (!raiz) return;
  document.getElementById('app-modal-ok').addEventListener('click', confirmarModalAtual);
  document.getElementById('app-modal-cancelar').addEventListener('click', () => fecharModal('cancel'));
  document.getElementById('app-modal-x').addEventListener('click', () => fecharModal('cancel'));
  document.getElementById('app-modal-input').addEventListener('input', limparAvisoModal);
  document.addEventListener('keydown', (e) => {
    const topo = topoModal();
    if (!topo || e.defaultPrevented) return;
    const o = topo.opts;
    if (e.key === 'Escape') {
      if (o.cancelavel === false) return;
      e.preventDefault();
      // Diálogo sem cancelar (só OK) é dispensado como OK
      fecharModal(o.botoes && o.botoes.cancel ? 'cancel' : 'ok');
      return;
    }
    if (e.key === 'Enter') {
      if (o.campo && e.target === document.getElementById('app-modal-input')) {
        e.preventDefault();
        confirmarModalAtual();
        return;
      }
      // Mensagens simples: Enter confirma (formulários e templates tratam o próprio Enter)
      if (!o.campo && !o.template && typeof o.corpo !== 'function' && o.botoes) {
        e.preventDefault();
        confirmarModalAtual();
      }
    }
  });
})();

// opcoes.icone: ícone de status ('info' | 'plus-circle' | 'triangle-alert' | 'circle-x'); padrão 'info'
function showCustomAlert(message, title = "Aviso", allowHtml = false, opcoes = {}) {
  return abrirModal({
    titulo: title, mensagem: message, mensagemHtml: allowHtml, icone: opcoes.icone || 'info', tom: 'info',
    botoes: { ok: 'Entendido' }
  }).then(() => undefined);
}

function showCustomConfirm(message, title = "Confirmação", confirmText = "Confirmar", cancelText = "Cancelar", allowHtml = false, opcoes = {}) {
  return abrirModal({
    titulo: title, mensagem: message, mensagemHtml: allowHtml, icone: opcoes.icone || 'info', tom: 'info',
    botoes: { ok: confirmText, cancel: cancelText }
  }).then((r) => r.acao === 'ok');
}

// ==============================
// GESTÃO DE JOGADORES
// ==============================
function addSinglePlayer() {
  const input = document.getElementById("input-player-name");
  const isGk = document.getElementById("check-is-gk").checked;
  const level = parseInt(document.getElementById("select-level").value) || 3;
  const name = input.value.trim();

  if (!name) return;

  const normalizedName = name.toLowerCase();
  const alreadyExists = state.players.some(p => p.name.trim().toLowerCase() === normalizedName);
  if (alreadyExists) {
    showCustomAlert(`Já existe um jogador cadastrado com o nome "${name}".`, "Jogador Duplicado", false, { icone: 'circle-x' });
    return;
  }

  state.players.push({
    id: "p_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    name: name,
    level: level,
    is_goalkeeper: isGk
  });

  input.value = "";
  document.getElementById("check-is-gk").checked = false;
  document.getElementById("select-level").value = "3";
  input.focus();

  if (window.auditTracker) {
    window.auditTracker.track('add_player', 'btn-add-player', 'action', {
      name: name,
      level: level,
      is_goalkeeper: isGk
    });
  }

  renderPlayersList();
  showToast(`${name} adicionado!`);
}

function removePlayer(id) {
  state.players = state.players.filter(p => p.id !== id);
  state.teams.forEach(t => { t.players = t.players.filter(p => p.id !== id); });
  renderPlayersList();
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

async function clearPlayers() {
  if (state.players.length === 0) return;
  const confirmed = await showCustomConfirm(
    "Deseja realmente limpar toda a lista de jogadores cadastrados?",
    "Limpar Jogadores",
    "Limpar Lista",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (confirmed) {
    state.players = [];
    state.teams = [];
    state.fixtures = [];
    if (state.config) delete state.config.last_combination_at;
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();
    sincronizarEstadoServidor(true);
    showToast("Lista de jogadores limpa!");
  }
}

function togglePlayerRole(id) {
  const p = state.players.find(x => x.id === id);
  if (!p) return;
  p.is_goalkeeper = !p.is_goalkeeper;
  renderPlayersList();
  sincronizarEstadoServidor();
  showToast(`${p.name} agora é ${p.is_goalkeeper ? '🧤 Goleiro (GK)' : '🏃 Jogador de Linha (LIN)'}`);
}

function cyclePlayerLevel(id) {
  const p = state.players.find(x => x.id === id);
  if (!p) return;
  // Aumenta até 5, depois volta para 1
  p.level = p.level >= 5 ? 1 : p.level + 1;
  renderPlayersList();
  sincronizarEstadoServidor();
}

function renderPlayersList() {
  const container = document.getElementById("players-list-container");
  const countEl = document.getElementById("count-players");
  if (!container || !countEl) return;

  countEl.textContent = state.players.length;

  if (state.players.length === 0) {
    container.innerHTML = `
      <div class="text-center py-8 text-slate-500 text-sm">
        Nenhum jogador na lista ainda.<br>Adicione jogadores acima!
      </div>
    `;
    return;
  }

  const isLeader = state.role === 'admin';

  container.innerHTML = state.players.map((p, idx) => `
    <div ${isLeader ? `draggable="true" data-drag-kind="player" data-player-id="${p.id}" data-h-dragstart="onPlayerDragStart" data-a="${escapeHtml(JSON.stringify(["@event", p.id]))}" data-h-dragend="onDragEnd" title="Arraste para um time"` : ''} class="flex items-center justify-between p-2.5 bg-card/60 hover:bg-card border border-borderLight/40 rounded-xl transition ${isLeader ? 'cursor-grab active:cursor-grabbing select-none' : ''}">
      <div class="flex items-center space-x-2.5 min-w-0">
        ${isLeader ? '<i data-lucide="grip-vertical" class="w-3.5 h-3.5 text-slate-600 shrink-0"></i>' : ''}
        <span class="text-xs font-bold text-slate-500 w-5 text-center">${idx + 1}</span>
        ${isLeader ? `
          <button type="button" data-h-click="togglePlayerRole" data-a="${escapeHtml(JSON.stringify([p.id]))}" title="Clique para alternar entre LIN e GK" class="focus:outline-none transition-transform active:scale-90 cursor-pointer">
            ${p.is_goalkeeper 
              ? '<span class="badge-gk text-[10px] text-black font-extrabold px-1.5 py-0.5 rounded shadow hover:brightness-110">GK</span>' 
              : '<span class="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold px-1.5 py-0.5 rounded border border-slate-700">LIN</span>'
            }
          </button>
        ` : `
          <span>
            ${p.is_goalkeeper 
              ? '<span class="badge-gk text-[10px] text-black font-extrabold px-1.5 py-0.5 rounded shadow">GK</span>' 
              : '<span class="text-[10px] bg-slate-800 text-slate-400 font-bold px-1.5 py-0.5 rounded border border-slate-700">LIN</span>'
            }
          </span>
        `}
        <span id="nome-jogador-${p.id}" ${isLeader ? `data-h-dblclick="editarNomeJogador" data-a="${escapeHtml(JSON.stringify([p.id]))}" title="Clique duas vezes para renomear" class="text-sm font-semibold text-white truncate cursor-text"` : 'class="text-sm font-semibold text-white truncate"'}>${escapeHtml(p.name)}</span>
        ${isLeader ? `
          <button type="button" data-h-click="cyclePlayerLevel" data-a="${escapeHtml(JSON.stringify([p.id]))}" title="Clique para alterar nível (1 a 5 estrelas)" class="focus:outline-none hover:scale-105 active:scale-95 transition-transform cursor-pointer flex items-center px-1 py-0.5 rounded hover:bg-slate-800/60">
            <span class="text-amber-400 text-xs tracking-tighter select-none">${"★".repeat(p.level)}${"☆".repeat(5 - p.level)}</span>
          </button>
        ` : `
          <span class="text-amber-400 text-xs tracking-tighter select-none px-1">${"★".repeat(p.level)}${"☆".repeat(5 - p.level)}</span>
        `}
      </div>
      ${isLeader ? `
        <button data-h-click="removePlayer" data-a="${escapeHtml(JSON.stringify([p.id]))}" class="text-slate-500 hover:text-rose-400 p-1 transition" title="Remover jogador">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      ` : ''}
    </div>
  `).join("");

  sincronizarEstadoServidor();
  refreshIcons();
  updatePlayersScrollIndicator();
}

function updatePlayersScrollIndicator() {
  const container = document.getElementById("players-list-container");
  const indicatorDown = document.getElementById("players-scroll-indicator");
  const indicatorUp = document.getElementById("players-scroll-indicator-up");
  if (!container) return;

  const hasItems = state.players.length > 0;
  const hasMoreBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 10;
  const hasMoreAbove = container.scrollTop > 10;

  if (indicatorDown) {
    if (hasItems && hasMoreBelow) {
      indicatorDown.classList.remove("hidden");
    } else {
      indicatorDown.classList.add("hidden");
    }
  }

  if (indicatorUp) {
    if (hasItems && hasMoreAbove) {
      indicatorUp.classList.remove("hidden");
    } else {
      indicatorUp.classList.add("hidden");
    }
  }
}

function scrollPlayersListDown() {
  const container = document.getElementById("players-list-container");
  if (!container) return;
  container.scrollBy({ top: 140, behavior: "smooth" });
}

function scrollPlayersListUp() {
  const container = document.getElementById("players-list-container");
  if (!container) return;
  container.scrollBy({ top: -140, behavior: "smooth" });
}

function importBulkPlayers() {
  const textarea = document.getElementById("bulk-players-text");
  const text = textarea.value.trim();
  if (!text) return;

  const lines = text.split("\n");
  let addedCount = 0;

  lines.forEach(line => {
    let clean = line.replace(/^\d+[\.\-\)]\s*/, "").trim(); // Remove numeração de lista: 1. 2) etc
    if (!clean) return;

    // Detecta se é goleiro considerando parênteses, colchetes ou termos explícitos
    let isGk = false;
    const bracketMatches = clean.match(/[\(\[][^()\[\]]*[\)\]]/g) || [];
    for (const bm of bracketMatches) {
      if (/\b(goleiro|gk|g)\b/i.test(bm)) {
        isGk = true;
      }
    }
    if (/\b(goleiro|gk)\b/i.test(clean)) {
      isGk = true;
    }

    // Remove referências explícitas de goleiro para não sujar o nome
    let textWithoutGk = clean.replace(/[\(\[]\s*(goleiro|gk|g)\s*[\)\]]/gi, " ");
    textWithoutGk = textWithoutGk.replace(/\b(goleiro|gk)\b/gi, " ");

    let level = 3;
    let levelFound = false;

    // 1. Número entre parênteses ou colchetes: ex (5), [4], (3 estrelas)
    const parenNumMatch = textWithoutGk.match(/[\(\[]\s*(\d+)\s*(?:estrelas?|stars?)?\s*[\)\]]/i);
    if (parenNumMatch) {
      level = parseInt(parenNumMatch[1], 10);
      levelFound = true;
      textWithoutGk = textWithoutGk.replace(parenNumMatch[0], " ");
    }

    // 2. Número no final da linha (ex: "João Ricardo 5", "Matheus Felipe 2")
    if (!levelFound) {
      const endNumMatch = textWithoutGk.match(/\s+(\d+)\s*$/);
      if (endNumMatch) {
        level = parseInt(endNumMatch[1], 10);
        levelFound = true;
        textWithoutGk = textWithoutGk.substring(0, endNumMatch.index);
      }
    }

    // 3. Número isolado restante na linha (ex: quando o (G) vinha após o número)
    if (!levelFound) {
      const wordNumMatch = textWithoutGk.match(/\b(\d+)\b/);
      if (wordNumMatch) {
        level = parseInt(wordNumMatch[1], 10);
        levelFound = true;
        textWithoutGk = textWithoutGk.replace(wordNumMatch[0], " ");
      }
    }

    // Limites de estrelas entre 1 e 5
    if (levelFound) {
      if (level > 5) level = 5;
      if (level < 1) level = 1;
    }

    // Limpeza final do nome do jogador
    let playerName = textWithoutGk
      .replace(/\s*[\(\[][^()\[\]]*[\)\]]/g, " ")
      .replace(/[–—\-]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!playerName) return;

    const normalizedName = playerName.toLowerCase();
    const alreadyExists = state.players.some(p => p.name.trim().toLowerCase() === normalizedName);
    if (alreadyExists) return;

    state.players.push({
      id: "p_" + Date.now() + "_" + Math.floor(Math.random() * 10000) + "_" + addedCount,
      name: playerName,
      level: level,
      is_goalkeeper: isGk
    });
    addedCount++;
  });

  textarea.value = "";
  if (window.auditTracker && addedCount > 0) {
    window.auditTracker.track('bulk_add_players', 'btn-import-bulk-players', 'action', {
      imported_count: addedCount,
      total_players: state.players.length
    });
  }
  renderPlayersList();
  if (addedCount > 0) {
    showToast(`${addedCount} jogadores importados com sucesso!`);
  } else {
    showToast("Nenhum jogador novo adicionado (nomes duplicados ou vazios).");
  }
}

// ==============================
// SORTEIO E TABELA DE CONFRONTOS
// ==============================
async function sortearTimes() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (window.auditTracker) {
    window.auditTracker.track('balance_teams_click', 'btn-balance-teams', 'action', {
      player_count: state.players.length,
      players_per_team: state.config.players_per_team
    });
  }
  if (state.players.length < 4) {
    await showCustomAlert("Adicione pelo menos 4 jogadores para formar no mínimo 2 times!", "Poucos Jogadores");
    return false;
  }

  try {
    const res = await fetch("/api/balance-teams", {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({
        players: state.players,
        players_per_team: state.config.players_per_team,
        pelada_code: state.currentPelada?.code || null
      })
    });
    const teams = await res.json();
    state.teams = teams;
    state.config.last_combination_at = new Date().toISOString();
    renderTeamsGrid();
    sincronizarEstadoServidor();

    // Dispara confetes animados para celebrar o sorteio
    if (window.confetti) {
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.7 } });
    }

    showToast("Times sorteados e balanceados!");
    return true;
  } catch (err) {
    console.error(err);
    await showCustomAlert("Ocorreu um erro ao realizar o sorteio dos times.", "Erro no Sorteio", false, { icone: 'circle-x' });
    return false;
  }
}

// Início rápido: monta os times se ainda não existirem e gera as partidas já na aba Jogos
async function inicioRapido() {
  if (state.role !== 'admin') return;

  if (state.teams.length === 0) {
    const sorteado = await sortearTimes();
    if (!sorteado) return;
    await gerarTabelaConfrontos();
    return;
  }

  const semTime = state.players.filter(jogador =>
    !state.teams.some(t => (Array.isArray(t.players) ? t.players : []).some(p => p.id === jogador.id))
  );
  if (semTime.length > 0) {
    const lista = semTime.map(j => `• ${escapeHtml(j.name)}`).join('<br>');
    await showCustomAlert(`Os jogadores abaixo ainda não estão em nenhum time:<br>${lista}`, "Jogadores sem Time", true);
    return;
  }

  await gerarTabelaConfrontos();
}

// ==============================
// CABEÇALHO DA PELADA (NOME, DATA DA POOL E DESCRIÇÃO)
// ==============================
const PELADA_DESCRICAO_MAX = 140;
const PELADA_DESCRICAO_PLACEHOLDER = "Digite aqui uma descrição para sua pelada.";
let editandoDescricaoPelada = false;

function renderPeladaHeader() {
  const pelada = state.currentPelada || {};
  const nomeEl = document.getElementById('pelada-header-name');
  const dataEl = document.getElementById('pelada-header-date');
  const descEl = document.getElementById('pelada-header-desc');
  if (!nomeEl || !dataEl || !descEl) return;

  nomeEl.textContent = pelada.name || (pelada.code ? `Pelada #${pelada.code}` : '');
  dataEl.textContent = pelada.pool_started_at ? `desde ${pelada.pool_started_at}` : '';

  // Enquanto o líder digita a descrição, não sobrescreve o campo de edição
  if (editandoDescricaoPelada) return;

  const isLeader = state.role === 'admin';
  const descricao = (pelada.description || '').trim();
  const visivel = descricao || isLeader;
  descEl.className = `text-sm max-w-xl break-words ${descricao ? 'text-slate-400' : 'text-slate-500 italic'} ${visivel ? '' : 'hidden'} ${isLeader ? 'cursor-text' : ''}`;
  descEl.title = isLeader ? 'Clique duas vezes para editar' : '';
  descEl.textContent = descricao || (isLeader ? PELADA_DESCRICAO_PLACEHOLDER : '');
  descEl.ondblclick = () => editarDescricaoPelada();
}

function editarDescricaoPelada() {
  if (state.role !== 'admin' || !state.currentPelada || editandoDescricaoPelada) return;
  const descEl = document.getElementById('pelada-header-desc');
  if (!descEl) return;

  editandoDescricaoPelada = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.currentPelada.description || '';
  input.maxLength = PELADA_DESCRICAO_MAX;
  input.placeholder = PELADA_DESCRICAO_PLACEHOLDER;
  input.className = 'w-full max-w-xl bg-pitch border border-neon-accent rounded-lg px-2 py-1 text-sm text-white focus:outline-none placeholder:text-slate-500';
  descEl.className = 'w-full max-w-xl';
  descEl.textContent = '';
  descEl.appendChild(input);
  input.focus();
  input.select();

  let encerrado = false;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!encerrado) { encerrado = true; salvarDescricaoPelada(input.value); } }
    if (e.key === 'Escape') { e.preventDefault(); if (!encerrado) { encerrado = true; editandoDescricaoPelada = false; renderPeladaHeader(); } }
  });
  input.addEventListener('blur', () => {
    if (!encerrado) { encerrado = true; salvarDescricaoPelada(input.value); }
  });
}

async function salvarDescricaoPelada(valorDigitado) {
  editandoDescricaoPelada = false;
  const novaDescricao = (valorDigitado || '').replace(/\s+/g, ' ').trim();
  const anterior = state.currentPelada.description || '';
  if (novaDescricao === anterior) { renderPeladaHeader(); return; }

  state.currentPelada.description = novaDescricao;
  renderPeladaHeader();
  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/description`, {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ description: novaDescricao })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || "Falha ao salvar descrição");
    }
  } catch (err) {
    console.error(err);
    state.currentPelada.description = anterior;
    renderPeladaHeader();
    showToast("Não foi possível salvar a descrição da pelada.");
  }
}

function renderTeamsGrid() {
  atualizarRegrasFormato();
  const container = document.getElementById("teams-grid");
  const lastCombEl = document.getElementById("last-combination-info");

  if (lastCombEl) {
    if (state.config && state.config.last_combination_at) {
      try {
        const d = new Date(state.config.last_combination_at);
        if (!isNaN(d.getTime())) {
          const dataStr = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Sao_Paulo" });
          const horaStr = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Sao_Paulo" });
          lastCombEl.innerHTML = `Última combinação em: <span class="text-slate-300 font-medium">${dataStr} às ${horaStr}</span>`;
        } else {
          lastCombEl.innerHTML = "";
        }
      } catch (e) {
        lastCombEl.innerHTML = "";
      }
    } else {
      lastCombEl.innerHTML = "";
    }
  }

  if (!container) return;

  const isLeader = state.role === 'admin';

  if (state.teams.length === 0) {
    container.innerHTML = isLeader ? `
      <button type="button" data-h-click="adicionarTimeManual" class="md:col-span-2 w-full text-center py-16 border-2 border-dashed border-borderLight rounded-2xl text-slate-500 space-y-3 hover:border-neon-accent/60 hover:text-slate-300 transition cursor-pointer">
        <i data-lucide="users-2" class="w-12 h-12 mx-auto stroke-1 text-slate-600"></i>
        <p class="text-sm">Clique <strong class="text-neon-accent">aqui</strong> para criar os times</p>
      </button>
    ` : `
      <div class="md:col-span-2 text-center py-16 border-2 border-dashed border-borderLight rounded-2xl text-slate-500 space-y-3">
        <i data-lucide="users-2" class="w-12 h-12 mx-auto stroke-1 text-slate-600"></i>
        <p class="text-sm">Nenhum time montado ainda.</p>
      </div>
    `;
    refreshIcons();
    return;
  }

  container.innerHTML = state.teams.map((t) => {
    const players = Array.isArray(t.players) ? t.players : [];
    const totalLevel = players.reduce((sum, p) => {
      const lvl = (p.effective_level !== undefined && p.effective_level !== null) ? p.effective_level : p.level;
      return sum + lvl;
    }, 0);
    const avgStars = (totalLevel / (players.length || 1)).toFixed(1);
    const cor = t.color || getTeamColor(t.name);

    const dragAttrs = isLeader ? `
      draggable="true"
      data-drag-kind="team" data-team-id="${escapeHtml(t.id)}"
      data-h-dragstart="onTeamDragStart" data-a="${escapeHtml(JSON.stringify(["@event", t.id]))}"
      data-h-dragend="onDragEnd"
      data-h-dragover="onCardDragOver" data-a="${escapeHtml(JSON.stringify(["@event", t.id]))}"
      data-h-dragleave="onCardDragLeave" data-a="${escapeHtml(JSON.stringify(["@event"]))}"
      data-h-drop="onCardDrop" data-a="${escapeHtml(JSON.stringify(["@event", t.id]))}"
      title="Arraste para trocar de posição com outro time"` : '';

    return `
      <div id="team-card-${t.id}" data-team-card ${dragAttrs} class="bg-card border border-borderLight rounded-2xl p-5 space-y-3.5 relative overflow-hidden transition hover:border-slate-500 ${isLeader ? 'cursor-grab active:cursor-grabbing select-none' : ''}">
        <!-- Barra de Cor no Topo -->
        <div class="ds-0dcd82c1-${cor.slice(1)} absolute top-0 left-0 right-0 h-1.5"></div>

        <div class="flex items-center justify-between pt-1">
          <div class="flex items-center space-x-2.5 min-w-0">
            ${isLeader ? `
              <button type="button" data-h-click="abrirSeletorCor" data-a="${escapeHtml(JSON.stringify(["@event", t.id]))}" title="Clique para escolher a cor do time" class="ds-0dcd82c1-${cor.slice(1)} w-3.5 h-3.5 rounded-full shadow shrink-0 hover:scale-125 transition cursor-pointer"></button>
            ` : `
              <span class="ds-0dcd82c1-${cor.slice(1)} w-3.5 h-3.5 rounded-full shadow shrink-0"></span>
            `}
            <h4 id="nome-time-${t.id}" ${isLeader ? `data-h-dblclick="editarNomeTime" data-a="${escapeHtml(JSON.stringify([t.id]))}" title="Clique duas vezes para renomear" class="ds-c8c42c63-${cor.slice(1)} font-extrabold text-base truncate cursor-text"` : `class="font-extrabold text-base truncate"`}>${escapeHtml(t.name)}</h4>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <div class="text-[11px] font-bold text-slate-400 bg-pitch px-2 py-0.5 rounded-lg border border-borderLight" title="Força média do time">
              ★ ${avgStars} / 5.0
            </div>
            ${isLeader ? `
              <button type="button" data-h-click="removerTime" data-a="${escapeHtml(JSON.stringify([t.id]))}" title="Excluir time" aria-label="Excluir time" class="w-8 h-8 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </div>

        <!-- Lista de Jogadores do Time (área de soltar para jogadores) -->
        <div class="space-y-1.5">
          ${players.length === 0 ? `
            <div class="text-center text-[11px] text-slate-500 py-3 border border-dashed border-borderLight/60 rounded-lg">
              ${isLeader ? 'Arraste jogadores para cá' : 'Time sem jogadores'}
            </div>
          ` : ''}
          ${players.map(p => {
            const hasEff = p.effective_level !== undefined && p.effective_level !== null && Math.abs(p.effective_level - p.level) >= 0.05;
            return `
            <div class="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-surface/60 border border-borderLight/30">
              <span class="flex items-center gap-1.5 text-slate-200 min-w-0">
                ${p.is_goalkeeper ? '<span class="text-[10px] font-extrabold bg-amber-500 text-black px-1 rounded">GK</span>' : ''}
                <span class="truncate">${escapeHtml(p.name)}</span>
              </span>
              <div class="flex items-center gap-1.5 shrink-0">
                ${hasEff ? `<span class="text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1 py-0.2 rounded" title="Nível efetivo ponderado pelo histórico (vitórias e gols): ${p.effective_level.toFixed(1)}">⚡ ${p.effective_level.toFixed(1)}</span>` : ''}
                <span class="text-amber-400 text-[10px]" title="${p.level} estrelas cadastradas">${"★".repeat(p.level)}</span>
                ${isLeader ? `
                  <button type="button" data-h-click="removerJogadorDoTime" data-a="${escapeHtml(JSON.stringify([p.id, t.id]))}" title="Tirar do time" class="text-slate-500 hover:text-rose-400 transition">
                    <i data-lucide="x" class="w-3 h-3"></i>
                  </button>
                ` : ''}
              </div>
            </div>
          `;}).join("")}
        </div>
      </div>
    `;
  }).join("");

  refreshIcons();
}

// ==============================
// MONTAGEM MANUAL DE TIMES (ADMIN)
// ==============================
// Estado temporário de arrasto: { kind: 'team' | 'player', id }
let dragState = null;

function onTeamDragStart(event, teamId) {
  dragState = { kind: 'team', id: teamId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', teamId);
}

function onPlayerDragStart(event, playerId) {
  dragState = { kind: 'player', id: playerId };
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('text/plain', playerId);
}

function onDragEnd() {
  dragState = null;
  document.querySelectorAll('[data-team-card].ring-2').forEach(el => el.classList.remove('ring-2', 'ring-neon-accent'));
}

function onCardDragOver(event, teamId) {
  if (!dragState) return;
  if (dragState.kind === 'team' && dragState.id === teamId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = dragState.kind === 'team' ? 'move' : 'copy';
  this.classList.add('ring-2', 'ring-neon-accent');
}

function onCardDragLeave(event) {
  if (this.contains(event.relatedTarget)) return;
  this.classList.remove('ring-2', 'ring-neon-accent');
}

function onCardDrop(event, teamId) {
  event.preventDefault();
  const drag = dragState;
  onDragEnd();
  if (!drag) return;
  if (drag.kind === 'team') trocarPosicaoTimes(drag.id, teamId);
  else if (drag.kind === 'player') adicionarJogadorAoTime(drag.id, teamId);
}

// ==============================
// ARRASTAR PARTIDAS (ADMIN)
// ==============================
// Soltar sobre outra partida TROCA as duas de rodada; soltar sobre uma rodada MOVE a partida para ela.
// A dica piscante mostra onde a partida preserva o formato (vem do servidor; formato livre não tem dica).
let tokenAlvosPartida = 0;

function alvoPartidaSob(elemento, idArrastado) {
  const card = elemento?.closest('[data-match-id]');
  if (card && card.dataset.matchId !== idArrastado) return card;
  const bloco = elemento?.closest('[data-round-block]');
  return bloco || null;
}

async function mostrarAlvosPartida(matchId) {
  if (state.config.championship_type === 'custom') return;
  const token = ++tokenAlvosPartida;
  try {
    const res = await fetch('/api/championship/drop-targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payloadFormato(), moved_id: matchId })
    });
    if (!res.ok) return;
    const alvos = await res.json();
    if (token !== tokenAlvosPartida || dragState?.id !== matchId) return;
    alvos.cards.forEach(id => document.getElementById(`match-card-${id}`)?.classList.add('fixture-hint'));
    alvos.rounds.forEach(r => document.querySelector(`[data-round-block="${r}"]`)?.classList.add('fixture-hint'));
  } catch (e) {
    console.error('Erro ao calcular a dica de arraste:', e);
  }
}

function limparAlvosPartida() {
  tokenAlvosPartida++;
  document.querySelectorAll('.fixture-hint, .fixture-target').forEach(el => el.classList.remove('fixture-hint', 'fixture-target'));
}

function encerrarArrastePartida() {
  dragState = null;
  limparAlvosPartida();
  document.querySelectorAll('[data-match-id].opacity-40').forEach(el => el.classList.remove('opacity-40'));
}

function onFixtureDragStart(event, matchId) {
  if (state.role !== 'admin') { event.preventDefault(); return; }
  dragState = { kind: 'fixture', id: matchId };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', matchId);
  const card = this;
  setTimeout(() => card.classList.add('opacity-40'), 0); // depois do snapshot do arrasto
  mostrarAlvosPartida(matchId);
}

function onFixtureDragEnd() {
  encerrarArrastePartida();
}

function onFixtureDragOver(event, matchId) {
  if (dragState?.kind !== 'fixture') return;
  event.stopPropagation(); // o card tem prioridade sobre o bloco da rodada
  if (matchId === dragState.id) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  this.classList.add('fixture-target');
}

function onFixtureDragLeave(event) {
  if (this.contains(event.relatedTarget)) return;
  this.classList.remove('fixture-target');
}

function onFixtureDrop(event, matchId) {
  if (dragState?.kind !== 'fixture') return;
  event.preventDefault();
  event.stopPropagation();
  const origem = dragState.id;
  encerrarArrastePartida();
  if (origem !== matchId) trocarRodadasPartidas(origem, matchId);
}

function onRoundDragOver(event) {
  if (dragState?.kind !== 'fixture') return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  this.classList.add('fixture-target');
}

function onRoundDrop(event, rodada) {
  if (dragState?.kind !== 'fixture') return;
  event.preventDefault();
  const origem = dragState.id;
  encerrarArrastePartida();
  moverPartidaParaRodada(origem, Number(rodada));
}

function trocarRodadasPartidas(idA, idB) {
  const i = state.fixtures.findIndex(m => m.id === idA);
  const j = state.fixtures.findIndex(m => m.id === idB);
  if (i < 0 || j < 0 || i === j) return;
  // Troca as posições na lista (o que o usuário vê) e as rodadas: a lista continua ordenada por rodada
  const a = state.fixtures[i];
  const b = state.fixtures[j];
  state.fixtures[i] = b;
  state.fixtures[j] = a;
  [a.round_number, b.round_number] = [b.round_number, a.round_number];
  aplicarMovimentoPartida();
}

function moverPartidaParaRodada(idPartida, rodada) {
  const m = state.fixtures.find(f => f.id === idPartida);
  if (!m || m.round_number === rodada) return;
  m.round_number = rodada;
  aplicarMovimentoPartida();
}

function aplicarMovimentoPartida() {
  state.fixtures.sort((a, b) => (a.round_number || 0) - (b.round_number || 0)); // estável: mantém a ordem dentro da rodada
  renderFixtures(); // recalcula o [MOD]
  sincronizarEstadoServidor();
}

// Alvo do arrasto de times/jogadores (toque)
function alvoTimeSob(elemento, a) {
  const card = elemento?.closest('[data-team-card]') || null;
  return card && !(a.kind === 'team' && card.dataset.teamId === a.id) ? card : null;
}

// ==============================
// ARRASTAR POR TOQUE (CELULAR)
// ==============================
// O toque só arrasta após ~250 ms pressionado; se o dedo se mover antes, vira rolagem normal.
let arrasteToque = null;

// No toque, desliga o arrasto nativo do navegador (o mouse continua com HTML5 DnD)
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-drag-kind]');
  if (el) el.draggable = e.pointerType === 'mouse' && !e.target.closest('button, input, select, textarea');
}, true);

document.addEventListener('touchstart', (e) => {
  if (state.role !== 'admin' || e.touches.length !== 1) return;
  if (e.target.closest('button, input, select, textarea')) return;
  const el = e.target.closest('[data-drag-kind]');
  if (!el) return;
  const t = e.touches[0];
  const rect = el.getBoundingClientRect();
  const kind = el.dataset.dragKind;
  arrasteToque = {
    kind,
    id: kind === 'player' ? el.dataset.playerId : (kind === 'fixture' ? el.dataset.matchId : el.dataset.teamId),
    el,
    x0: t.clientX,
    y0: t.clientY,
    offX: t.clientX - rect.left,
    offY: t.clientY - rect.top,
    largura: rect.width,
    ativo: false,
    ghost: null,
    alvo: null,
    timer: setTimeout(ativarArrasteToque, 250)
  };
}, { passive: true });

function ativarArrasteToque() {
  const a = arrasteToque;
  if (!a) return;
  a.ativo = true;
  dragState = { kind: a.kind, id: a.id };

  // "Fantasma" que acompanha o dedo; o original fica esmaecido
  const ghost = a.el.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.removeAttribute('draggable');
  ghost.className = `${a.el.className} fixed z-[70] pointer-events-none shadow-2xl ring-2 ring-neon-accent`;
  ghost.style.width = `${a.largura}px`;
  ghost.style.left = `${a.x0 - a.offX}px`;
  ghost.style.top = `${a.y0 - a.offY}px`;
  document.body.appendChild(ghost);
  a.ghost = ghost;
  a.el.classList.add('opacity-40');
  if (navigator.vibrate) navigator.vibrate(15);
  if (kind === 'fixture') mostrarAlvosPartida(a.id);
}

document.addEventListener('touchmove', (e) => {
  const a = arrasteToque;
  if (!a) return;
  const t = e.touches[0];
  if (!a.ativo) {
    // Movimento antes do long-press: cancela e deixa a página rolar
    if (Math.hypot(t.clientX - a.x0, t.clientY - a.y0) > 10) cancelarArrasteToque();
    return;
  }
  e.preventDefault();
  // Mantém o fantasma dentro da tela
  const esquerda = Math.min(Math.max(8, t.clientX - a.offX), window.innerWidth - a.largura - 8);
  a.ghost.style.left = `${esquerda}px`;
  a.ghost.style.top = `${t.clientY - a.offY}px`;

  // Rolagem automática perto das bordas (a barra de navegação fica embaixo)
  if (t.clientY < 80) window.scrollBy(0, -12);
  else if (t.clientY > window.innerHeight - 110) window.scrollBy(0, 12);

  // Alvo sob o dedo (o fantasma não recebe eventos)
  const sob = document.elementFromPoint(t.clientX, t.clientY);
  const valido = a.kind === 'fixture' ? alvoPartidaSob(sob, a.id) : alvoTimeSob(sob, a);
  const classes = a.kind === 'fixture' ? ['fixture-target'] : ['ring-2', 'ring-neon-accent'];
  if (a.alvo !== valido) {
    a.alvo?.classList.remove(...classes);
    valido?.classList.add(...classes);
    a.alvo = valido;
  }
}, { passive: false });

function finalizarArrasteToque(e) {
  const a = arrasteToque;
  if (!a) return;
  if (!a.ativo) { cancelarArrasteToque(); return; }
  e.preventDefault(); // evita o clique fantasma depois de arrastar
  const { kind, id, alvo } = a;
  cancelarArrasteToque();
  if (!alvo) return;
  if (kind === 'fixture') {
    if (alvo.dataset.matchId) trocarRodadasPartidas(id, alvo.dataset.matchId);
    else moverPartidaParaRodada(id, Number(alvo.dataset.roundBlock));
  } else if (kind === 'team') trocarPosicaoTimes(id, alvo.dataset.teamId);
  else adicionarJogadorAoTime(id, alvo.dataset.teamId);
}

function cancelarArrasteToque() {
  const a = arrasteToque;
  if (!a) return;
  clearTimeout(a.timer);
  a.ghost?.remove();
  a.el.classList.remove('opacity-40');
  a.alvo?.classList.remove('ring-2', 'ring-neon-accent', 'fixture-target');
  if (a.ativo) dragState = null;
  if (a.ativo && a.kind === 'fixture') limparAlvosPartida();
  arrasteToque = null;
}

document.addEventListener('touchend', finalizarArrasteToque, { passive: false });
document.addEventListener('touchcancel', cancelarArrasteToque);

function adicionarTimeManual() {
  if (state.role !== 'admin') return;

  // Usa a primeira cor da paleta que ainda não está em uso
  const coresUsadas = new Set(state.teams.map(t => (t.color || '').toLowerCase()));
  const paleta = teamPalette().find(p => !coresUsadas.has(p.color.toLowerCase()))
    || teamPalette()[state.teams.length % teamPalette().length];

  const base = `Time ${paleta.label}`;
  let nome = base;
  for (let n = 2; state.teams.some(t => t.name === nome); n++) nome = `${base} ${n}`;

  state.teams.push({
    id: `team_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`,
    name: nome,
    color: paleta.color,
    players: []
  });
  renderTeamsGrid();
  sincronizarEstadoServidor();
  showToast(`${nome} criado!`);
}

async function removerTime(teamId) {
  const time = state.teams.find(t => t.id === teamId);
  if (!time) return;
  const nPartidas = state.fixtures.filter(f => f.home_team_id === teamId || f.away_team_id === teamId).length;
  const avisoPartidas = nPartidas > 0 ? `\n\nAtenção: ${nPartidas} partida(s) deste time também saem da tabela (o histórico já salvo é mantido).` : "";
  const confirmed = await showCustomConfirm(
    `Remover o time "${time.name}"? Os jogadores continuam na lista.${avisoPartidas}`,
    "Remover Time",
    "Remover",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;
  state.teams = state.teams.filter(t => t.id !== teamId);
  state.fixtures = state.fixtures.filter(f => f.home_team_id !== teamId && f.away_team_id !== teamId);
  renderTeamsGrid();
  renderFixtures();
  sincronizarEstadoServidor();
}

function trocarCorTime(teamId, cor) {
  const time = state.teams.find(t => t.id === teamId);
  if (!time || !cor) return;
  time.color = cor;
  renderTeamsGrid();
  renderFixtures();
  atualizarOpcoesTimesModal();
  sincronizarEstadoServidor();
}

// Seletor de cor: só as cores da paleta do servidor (teamPalette)
let seletorCorTeamId = null;

function abrirSeletorCor(event, teamId) {
  event.stopPropagation();
  const botao = this;
  const time = state.teams.find(t => t.id === teamId);
  if (!time) return;
  fecharSeletorCor();
  seletorCorTeamId = teamId;

  const pop = document.createElement('div');
  pop.id = 'seletor-cor-time';
  pop.className = 'fixed z-[60] flex items-center gap-2 p-2 bg-slate-900/95 backdrop-blur border border-borderLight rounded-xl shadow-2xl';
  pop.innerHTML = teamPalette().map(p => {
    const selecionada = (time.color || '').toLowerCase() === p.color.toLowerCase();
    return `<button type="button" title="${p.label}" data-h-click="escolherCorTime" data-a="${escapeHtml(JSON.stringify([p.color]))}" class="ds-0dcd82c1-${p.color.slice(1)} w-6 h-6 rounded-full transition hover:scale-110 ${selecionada ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''}"></button>`;
  }).join('');
  document.body.appendChild(pop);

  const r = botao.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  setTimeout(() => {
    document.addEventListener('mousedown', fecharSeletorCorFora);
    window.addEventListener('scroll', fecharSeletorCor, { once: true, capture: true });
  }, 0);
}

function fecharSeletorCorFora(event) {
  const pop = document.getElementById('seletor-cor-time');
  if (pop && pop.contains(event.target)) return;
  fecharSeletorCor();
}

function fecharSeletorCor() {
  document.getElementById('seletor-cor-time')?.remove();
  document.removeEventListener('mousedown', fecharSeletorCorFora);
  seletorCorTeamId = null;
}

function escolherCorTime(cor) {
  const id = seletorCorTeamId;
  fecharSeletorCor();
  if (id) trocarCorTime(id, cor);
}

// Renomear: duplo clique no nome do time
const NOME_TIME_MAX = 30;

function editarNomeTime(teamId) {
  const time = state.teams.find(t => t.id === teamId);
  const titulo = document.getElementById(`nome-time-${teamId}`);
  if (!time || !titulo || titulo.querySelector('input')) return;

  // Card não pode ser arrastado enquanto o usuário digita
  const card = document.getElementById(`team-card-${teamId}`);
  if (card) card.draggable = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = time.name;
  input.maxLength = NOME_TIME_MAX;
  input.className = 'w-full bg-pitch border border-neon-accent rounded-lg px-2 py-0.5 text-base font-extrabold text-white focus:outline-none';
  titulo.textContent = '';
  titulo.appendChild(input);
  input.focus();
  input.select();

  let encerrado = false;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (!encerrado) { encerrado = true; renomearTime(teamId, input.value); } }
    if (e.key === 'Escape') { e.preventDefault(); if (!encerrado) { encerrado = true; renderTeamsGrid(); } }
  });
  input.addEventListener('blur', () => {
    if (!encerrado) { encerrado = true; renomearTime(teamId, input.value); }
  });
}

function renomearTime(teamId, nomeDigitado) {
  const time = state.teams.find(t => t.id === teamId);
  if (!time) return;
  const novoNome = (nomeDigitado || '').replace(/\s+/g, ' ').trim();

  if (!novoNome || novoNome === time.name) { renderTeamsGrid(); return; }
  if (novoNome.length > NOME_TIME_MAX) {
    showToast(`Use no máximo ${NOME_TIME_MAX} caracteres.`);
    renderTeamsGrid();
    return;
  }
  // Nomes únicos: a cor e a legenda dos jogos são buscadas pelo nome em alguns lugares
  const duplicado = state.teams.some(t => t.id !== teamId && t.name.toLowerCase() === novoNome.toLowerCase());
  if (duplicado) {
    showToast(`Já existe um time chamado "${novoNome}".`);
    renderTeamsGrid();
    return;
  }

  time.name = novoNome;
  // Atualiza os jogos já criados, para a aba Jogos não mostrar o nome antigo
  state.fixtures.forEach(m => {
    if (m.home_team_id === teamId) m.home_team_name = novoNome;
    if (m.away_team_id === teamId) m.away_team_name = novoNome;
  });
  renderTeamsGrid();
  renderFixtures();
  sincronizarEstadoServidor();
}

function trocarPosicaoTimes(idOrigem, idDestino) {
  const i = state.teams.findIndex(t => t.id === idOrigem);
  const j = state.teams.findIndex(t => t.id === idDestino);
  if (i < 0 || j < 0 || i === j) return;
  [state.teams[i], state.teams[j]] = [state.teams[j], state.teams[i]];
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

function adicionarJogadorAoTime(playerId, teamId) {
  const jogador = state.players.find(p => p.id === playerId);
  const destino = state.teams.find(t => t.id === teamId);
  if (!jogador || !destino) return;
  if (!Array.isArray(destino.players)) destino.players = [];
  if (destino.players.some(p => p.id === playerId)) return;

  // Cada jogador fica em um único time
  state.teams.forEach(t => {
    if (Array.isArray(t.players)) t.players = t.players.filter(p => p.id !== playerId);
  });
  destino.players.push({
    id: jogador.id,
    name: jogador.name,
    level: jogador.level,
    is_goalkeeper: jogador.is_goalkeeper
  });
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

function removerJogadorDoTime(playerId, teamId) {
  const time = state.teams.find(t => t.id === teamId);
  if (!time || !Array.isArray(time.players)) return;
  time.players = time.players.filter(p => p.id !== playerId);
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

async function gerarTabelaConfrontos() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (state.config.championship_type === "custom") {
    showToast("O formato Livre não tem padrão de tabela: adicione as partidas manualmente.");
    return;
  }
  if (state.teams.length < 2) {
    await showCustomAlert("Você precisa sortear pelo menos 2 times primeiro!", "Times Insuficientes");
    return;
  }

  // Tabela de turnos: calcula antes de perguntar. Se o servidor recusar (ex.: time sem jogadores), avisa e para.
  let tabelaCalculada = null;
  if (state.config.championship_type !== "king") {
    try {
      const res = await fetch("/api/generate-schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teams: state.teams,
          rounds: state.config.total_rounds || 1,
          first_home_id: state.config.first_match_home_id || null,
          first_away_id: state.config.first_match_away_id || null
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        await showCustomAlert(data.detail || "Erro ao gerar tabela de confrontos.", "Não é possível gerar a tabela", false,
          { icone: 'circle-x' });
        return;
      }
      tabelaCalculada = data;
    } catch (err) {
      console.error(err);
      await showCustomAlert("Erro ao gerar tabela de confrontos.", "Erro no Agendamento", false, { icone: 'circle-x' });
      return;
    }
  }

  // Se já houver partidas geradas na tabela, exige confirmação para recriar
  if (state.fixtures && state.fixtures.length > 0) {
    const confirmed = await showCustomConfirm(
      "Deseja realmente recriar a tabela de confrontos? Todos os placares e eventos atuais serão substituídos.",
      "Recriar Tabela",
      "Recriar Tabela",
      "Cancelar",
      false,
      { icone: 'triangle-alert' }
    );
    if (!confirmed) return;
  }

  // Rei da Pelada: gera só a primeira partida; as seguintes saem conforme os resultados
  if (state.config.championship_type === "king") {
    state.fixtures = [];
    atualizarBaseRegras();
    const ok = await gerarProximaPartidaRei();
    switchTab("fixtures");
    if (ok) showToast("Rei da Pelada: primeira partida pronta!");
    return;
  }

  state.fixtures = tabelaCalculada;
  atualizarBaseRegras();

  renderFixtures();
  sincronizarEstadoServidor();
  switchTab("fixtures");
  showToast(`${tabelaCalculada.length} confrontos agendados!`);
}

// ==============================
// REI DA PELADA
// ==============================
function corpoRei() {
  const c = state.config;
  return {
    teams: state.teams,
    fixtures: state.fixtures.map(f => ({
      id: f.id, home_team_id: f.home_team_id, away_team_id: f.away_team_id,
      home_score: f.home_score, away_score: f.away_score, finished: !!f.finished,
      winner_team_id: f.winner_team_id ?? null, is_draw: !!f.is_draw, played_at: f.played_at ?? null
    })),
    first_home_id: c.first_match_home_id || null,
    first_away_id: c.first_match_away_id || null,
    draw_rule: c.king_draw_rule || "both",
    max_consecutive_wins: c.king_max_consecutive_wins || 0,
    points_win: c.points_win || 3,
    points_draw: c.points_draw ?? 1
  };
}

async function consultarRei() {
  const res = await fetch("/api/king/next-match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpoRei())
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Falha ao calcular a próxima partida.");
  }
  return res.json();
}

// Cria a próxima partida do Rei da Pelada (se não houver uma em aberto)
async function gerarProximaPartidaRei() {
  if (state.fixtures.some(f => !f.finished)) return false;
  try {
    const data = await consultarRei();
    if (!data.match) return false;
    state.fixtures.push(data.match);
    renderFixtures();
    sincronizarEstadoServidor();
    return true;
  } catch (err) {
    console.error(err);
    await showCustomAlert(err.message || "Erro ao gerar a próxima partida.", "Rei da Pelada", false,
      { icone: 'circle-x' });
    return false;
  }
}

// Faixa com quem está em campo e a fila de espera
async function atualizarFilaRei() {
  const el = document.getElementById("king-queue-banner");
  if (!el) return;
  try {
    const data = await consultarRei();
    const banner = document.getElementById("king-queue-banner");
    if (!banner || !data) return;
    const nome = id => (state.teams.find(t => t.id === id) || {}).name || id;
    const fila = (data.queue || []).map(id => renderTeamBadge(nome(id), id)).join(" ");
    banner.innerHTML = `<i data-lucide="clock" class="w-3.5 h-3.5 text-slate-400 shrink-0"></i><span class="font-bold text-slate-300">Fila de espera:</span> ${fila || '<span class="text-slate-500">ninguém</span>'}`;
    refreshIcons();
  } catch (e) {
    el.textContent = "";
  }
}

// ==============================
// GESTÃO DE PARTIDAS LIVRES (TIPO LIVRE)
// ==============================
function atualizarOpcoesTimesModal(changedSide = null) {
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  if (!homeSelect || !awaySelect || state.teams.length < 2) return;

  // Garante de forma defensiva que os valores iniciais nunca sejam iguais
  let currentHome = homeSelect.value || state.teams[0].id;
  let currentAway = awaySelect.value || state.teams[1].id;

  if (currentHome === currentAway) {
    const fallbackAway = state.teams.find(t => t.id !== currentHome);
    if (fallbackAway) currentAway = fallbackAway.id;
  }

  // Renderiza opções do Mandante e do Visitante (sem bloqueio: escolher um time já usado no outro lado troca os lados)
  const optionsHtml = (selectedId) => state.teams.map(t => {
    const teamColor = t.color || getTeamColor(t.id || t.name);
    return `<option class="ds-b7c26a56-${teamColor.slice(1)}" value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>● ${escapeHtml(t.name)}</option>`;
  }).join("");
  homeSelect.innerHTML = optionsHtml(currentHome);
  awaySelect.innerHTML = optionsHtml(currentAway);

  homeSelect.value = currentHome;
  awaySelect.value = currentAway;
  // Guarda a seleção atual: é o "valor anterior" usado pela troca automática no próximo change
  homeSelect.dataset.anterior = currentHome;
  awaySelect.dataset.anterior = currentAway;

  const selectedHomeTeam = state.teams.find(t => t.id === currentHome);
  const selectedAwayTeam = state.teams.find(t => t.id === currentAway);
  if (selectedHomeTeam) homeSelect.style.color = selectedHomeTeam.color || getTeamColor(selectedHomeTeam.name);
  if (selectedAwayTeam) awaySelect.style.color = selectedAwayTeam.color || getTeamColor(selectedAwayTeam.name);
}

// Ao escolher um time que já está no outro lado, os dois lados são trocados
function trocarLadosPartidaLivre(ladoAlterado) {
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  if (!homeSelect || !awaySelect) return;

  const outroSelect = ladoAlterado === "home" ? awaySelect : homeSelect;
  const alterado = ladoAlterado === "home" ? homeSelect : awaySelect;
  if (outroSelect.value === alterado.value) {
    // Valor que o lado alterado tinha antes da escolha passa para o outro lado
    const anterior = alterado.dataset.anterior;
    const fallback = state.teams.find(t => t.id !== alterado.value);
    outroSelect.value = (anterior && anterior !== alterado.value) ? anterior : (fallback ? fallback.id : outroSelect.value);
  }
  atualizarOpcoesTimesModal(ladoAlterado);
}

function onCustomHomeChange() {
  trocarLadosPartidaLivre("home");
}

function onCustomAwayChange() {
  trocarLadosPartidaLivre("away");
}

function abrirModalNovaPartida(prefilledRound = null) {
  if (state.teams.length < 2) {
    showCustomAlert("Monte ou sorteie pelo menos 2 times antes de adicionar partidas!", "Sem Times");
    return;
  }

  // Fora do Livre, a partida avulsa pode fugir do formato e marca [MOD]
  const isCustom = state.config.championship_type === "custom";
  abrirModal({
    template: 'tpl-custom-match',
    titulo: isCustom ? "Nova Partida Livre" : "Nova Partida",
    icone: 'plus-circle',
    tom: 'info',
    largura: 'md',
    mensagemHtml: true,
    mensagem: '<p>Escolha a rodada e os dois times que vão se enfrentar.</p>',
    botoes: { ok: 'Adicionar Partida', cancel: 'Cancelar' },
    validar: validarNovaPartidaLivre,
    aoRenderizar: () => preencherNovaPartida(prefilledRound)
  });
}

function preencherNovaPartida(prefilledRound) {
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  const roundInput = document.getElementById("custom-match-round");
  const avisoMod = document.getElementById("custom-match-mod-hint");

  if (!homeSelect || !awaySelect || !roundInput) return;

  const isCustom = state.config.championship_type === "custom";
  if (avisoMod) avisoMod.classList.toggle("hidden", isCustom);

  // Garante seleção inicial de times distintos
  homeSelect.value = state.teams[0].id;
  awaySelect.value = state.teams[1].id;
  atualizarOpcoesTimesModal();

  // Sugere o próximo número de rodada
  if (prefilledRound) {
    roundInput.value = prefilledRound;
  } else if (state.fixtures.length > 0) {
    const maxRound = Math.max(...state.fixtures.map(m => m.round_number || 1));
    roundInput.value = maxRound;
  } else {
    roundInput.value = 1;
  }

  refreshIcons();
}

function submeterNovaPartida(event) {
  event.preventDefault();
  confirmarModalAtual();
}

// Valida a partida livre. Devolve o aviso (string) ou cria a partida e devolve null (fecha a janela).
function validarNovaPartidaLivre() {
  const roundNum = Math.max(1, parseInt(document.getElementById("custom-match-round").value) || 1);
  const homeId = document.getElementById("custom-match-home").value;
  const awayId = document.getElementById("custom-match-away").value;

  if (homeId === awayId) return "O time mandante e o visitante não podem ser o mesmo!";

  const homeTeam = state.teams.find(t => t.id === homeId);
  const awayTeam = state.teams.find(t => t.id === awayId);
  if (!homeTeam || !awayTeam) return "Times selecionados não foram encontrados.";
  if (!(homeTeam.players || []).length || !(awayTeam.players || []).length) return "Os dois times precisam ter jogadores.";

  if (window.SoundManager) window.SoundManager.play('efeitos');
  const newMatch = {
    id: "m_custom_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    round_number: roundNum,
    home_team_id: homeTeam.id,
    home_team_name: homeTeam.name,
    away_team_id: awayTeam.id,
    away_team_name: awayTeam.name,
    home_score: 0,
    away_score: 0,
    home_players: (homeTeam.players || []).map(p => ({ id: p.id, name: p.name })),
    away_players: (awayTeam.players || []).map(p => ({ id: p.id, name: p.name })),
    events: [],
    winner_team_id: null,
    is_draw: false,
    finished: false,
    played_at: null
  };

  state.fixtures.push(newMatch);
  // Ordena por rodada
  state.fixtures.sort((a, b) => a.round_number - b.round_number);

  renderFixtures();
  sincronizarEstadoServidor();
  showToast(`Partida adicionada à Rodada ${roundNum}!`);
  return null;
}

async function removerPartidaCustomizada(matchId) {
  const match = state.fixtures.find(m => m.id === matchId);
  if (!match) return;

  const quebraFormato = ["single", "double", "king"].includes(state.config.championship_type)
    ? `\n\nAtenção: remover esta partida quebra o formato do campeonato e o título passará a indicar [MOD]. Você pode continuar, pois as regras da pelada são flexíveis.`
    : "";
  const confirmed = await showCustomConfirm(
    `Deseja realmente remover a partida "${match.home_team_name} x ${match.away_team_name}" da tabela?${quebraFormato}`,
    "Remover Partida",
    "Sim, Remover",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  // Se a partida estava salva no banco, remove também da persistência
  if (match.finished && state.currentPelada && state.currentPelada.code) {
    try {
      const pCode = state.currentPelada.code;
      const deleteUrl = `/api/matches/${matchId}?pelada_code=${pCode}`;
      await fetch(deleteUrl, {
        method: "DELETE",
        headers: getAuthHeaders()
      });
    } catch (e) {
      console.error("Erro ao deletar partida do banco:", e);
    }
  }

  state.fixtures = state.fixtures.filter(m => m.id !== matchId);
  renderFixtures();
  sincronizarEstadoServidor(true);
  await atualizarDashboard();
  showToast("Partida removida!");
}

async function limparTodasRodadas() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (!state.fixtures || state.fixtures.length === 0) {
    await showCustomAlert("Não há rodadas ou confrontos cadastrados para remover.", "Tabela Vazia");
    return;
  }

  const totalJogos = state.fixtures.length;
  const confirmed = await showCustomConfirm(
    `Deseja realmente remover todas as rodadas e confrontos (${totalJogos} ${totalJogos === 1 ? 'partida' : 'partidas'})?`,
    "Remover Todas as Rodadas",
    "Sim, Remover Tudo",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  state.fixtures = [];
  if (window.auditTracker) {
    window.auditTracker.track('delete_all_fixtures', 'btn-clear-fixtures', 'action', {
      cleared_matches_count: totalJogos
    });
  }
  renderFixtures();
  sincronizarEstadoServidor();
  showToast("Todas as rodadas foram removidas da tabela!");
}

const CHAVES_REGRAS = ["championship_type", "first_match_home_id", "first_match_away_id", "king_draw_rule", "king_max_consecutive_wins"];

function snapshotRegras(cfg) {
  const snap = {};
  CHAVES_REGRAS.forEach(k => { snap[k] = cfg[k] ?? null; });
  return snap;
}

// A base do [MOD]: regras vigentes quando a tabela foi montada. Sem partidas finalizadas, mudar regra não quebra nada
function atualizarBaseRegras(regrasAnteriores = null) {
  const temFinalizada = (state.fixtures || []).some(f => f.finished);
  if (!temFinalizada) {
    state.config.rules_baseline = snapshotRegras(state.config);
  } else if (!state.config.rules_baseline && regrasAnteriores) {
    state.config.rules_baseline = regrasAnteriores; // pelada antiga: a base é o que valia antes desta mudança
  }
}

const NOME_FORMATO = { single: "Turno Único", double: "Turno e Retorno", king: "Rei da Pelada", custom: "Livre" };
let tokenChecagemFormato = 0;

// Título "Rodadas e Confrontos - Formato" e a marca [MOD] quando edições fugiram das regras
// Dados do formato enviados ao servidor para checar o [MOD] e as dicas de arraste
function payloadFormato() {
  const c = state.config;
  return {
    championship_type: c.championship_type || "single",
    team_ids: state.teams.map(t => t.id),
    fixtures: state.fixtures.map(f => ({
      id: f.id, round_number: f.round_number ?? null,
      home_team_id: f.home_team_id, away_team_id: f.away_team_id,
      home_score: f.home_score, away_score: f.away_score, finished: !!f.finished,
      winner_team_id: f.winner_team_id ?? null, is_draw: !!f.is_draw, played_at: f.played_at ?? null
    })),
    draw_rule: c.king_draw_rule || "both",
    max_consecutive_wins: c.king_max_consecutive_wins || 0,
    points_win: c.points_win || 3,
    points_draw: c.points_draw ?? 1,
    rules: snapshotRegras(c),
    rules_baseline: c.rules_baseline || null
  };
}

async function atualizarTituloFormato() {
  const tipo = state.config.championship_type || "single";
  const nome = document.getElementById("fixtures-format-name");
  const mod = document.getElementById("fixtures-mod-flag");
  if (nome) nome.textContent = ` - ${NOME_FORMATO[tipo] || NOME_FORMATO.single}`;
  if (!mod) return;
  const token = ++tokenChecagemFormato;
  if (!state.fixtures.length) { mod.classList.add("hidden"); return; }
  try {
    const res = await fetch("/api/championship/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadFormato())
    });
    const data = await res.json();
    if (token === tokenChecagemFormato) mod.classList.toggle("hidden", !data.modified);
  } catch (e) {
    if (token === tokenChecagemFormato) mod.classList.add("hidden");
  }
}

// Clique na bolinha: vai para Jogos da Rodada e centraliza uma partida em andamento.
// Com várias partidas rolando, cada clique avança para a próxima (volta ao início no fim).
let ultimaPartidaEmAndamentoId = null;
function irParaPartidaEmAndamento() {
  const emAndamento = (state.fixtures || []).filter(x => !x.finished && x.timer_status === 'running');
  if (emAndamento.length === 0) {
    showToast('Nenhuma partida em andamento.');
    return;
  }
  const idxAtual = emAndamento.findIndex(x => x.id === ultimaPartidaEmAndamentoId);
  const m = emAndamento[(idxAtual + 1) % emAndamento.length];
  ultimaPartidaEmAndamentoId = m.id;
  // Se já está em Jogos da Rodada, só rola até o cartão (sem voltar ao topo)
  const jaNaAba = currentActiveTab === 'fixtures';
  if (!jaNaAba) switchTab('fixtures');
  // Ao trocar de aba, espera o painel renderizar antes de rolar
  setTimeout(() => {
    const card = document.getElementById(`match-card-${m.id}`);
    if (!card) return;
    // Centro da área visível: abaixo do cabeçalho sticky
    const headerH = document.getElementById('app-header')?.offsetHeight || 0;
    const rect = card.getBoundingClientRect();
    const alvo = window.scrollY + rect.top + rect.height / 2 - (window.innerHeight + headerH) / 2;
    window.scrollTo({ top: Math.max(0, alvo), behavior: 'smooth' });
  }, jaNaAba ? 0 : 350);
}

// Bolinha de status do cabeçalho: verde piscando se alguma partida estiver rolando
function atualizarStatusPelada() {
  const dot = document.getElementById('pelada-status-dot');
  if (!dot) return;
  const emAndamento = (state.fixtures || []).some(m => !m.finished && m.timer_status === 'running');
  // Mesmo efeito do ponto do VS no cartão: núcleo sólido + anel pulsando (animate-ping)
  dot.innerHTML = emAndamento
    ? `<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>`
    : `<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-slate-500"></span>`;
  dot.title = emAndamento ? 'Partida em andamento' : 'Nenhuma partida em andamento';
}

function renderFixtures() {
  atualizarTituloFormato();
  atualizarStatusPelada();
  const container = document.getElementById("fixtures-container");
  const badgeMobile = document.getElementById("badge-pending-matches-mobile");
  if (!container) return;

  const pending = state.fixtures.filter(m => !m.finished).length;
  if (badgeMobile) {
    badgeMobile.textContent = pending;
    badgeMobile.classList.toggle("hidden", pending === 0);
  }

  if (state.fixtures.length === 0) {
    const isCustom = state.config.championship_type === "custom";
    const isLeader = state.role === 'admin';
    if (isLeader) {
      // Área clicável: cria a primeira partida (livre) ou gera os confrontos (preset)
      const acao = isCustom ? 'abrirModalNovaPartida' : 'gerarTabelaConfrontos';
      const texto = isCustom
        ? 'Clique <strong class="text-neon-accent">aqui</strong> para criar a primeira partida'
        : 'Sorteie os times e clique <strong class="text-neon-accent">aqui</strong> para gerar os confrontos';
      container.innerHTML = `
        <button type="button" data-h-click="${acao}" class="w-full bg-surface border-2 border-dashed border-borderLight hover:border-neon-accent/60 rounded-3xl p-12 text-center text-slate-500 hover:text-slate-300 space-y-3 transition cursor-pointer">
          <i data-lucide="calendar-plus" class="w-12 h-12 mx-auto stroke-1"></i>
          <p class="text-sm">${texto}</p>
        </button>
      `;
    } else {
      container.innerHTML = `
        <div class="bg-surface border border-borderLight rounded-3xl p-12 text-center text-slate-500 space-y-3">
          <i data-lucide="calendar-x" class="w-12 h-12 mx-auto stroke-1"></i>
          <p class="text-sm">Nenhum confronto gerado ainda.</p>
        </div>
      `;
    }
    refreshIcons();
    return;
  }

  // Agrupa por Rodada
  const roundsMap = {};
  state.fixtures.forEach(m => {
    if (!roundsMap[m.round_number]) roundsMap[m.round_number] = [];
    roundsMap[m.round_number].push(m);
  });

  const isLeader = state.role === 'admin';

  const isKing = state.config.championship_type === "king";
  let html = "";
  for (const [roundNum, matches] of Object.entries(roundsMap)) {
    const blocoRodada = isLeader && !isKing
      ? `data-round-block="${roundNum}" data-h-dragover="onRoundDragOver" data-h-dragleave="onFixtureDragLeave" data-h-drop="onRoundDrop" data-a="${escapeHtml(JSON.stringify(["@event", roundNum]))}"`
      : "";
    html += `
      <div class="space-y-3" ${blocoRodada}>
        <div class="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
          <div class="flex items-center space-x-2">
            <i data-lucide="layers" class="w-4 h-4 text-emerald-400"></i>
            <span>${isKing ? "Partida" : "Rodada"} ${roundNum}</span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${matches.map(m => renderSingleMatchCard(m)).join("")}
        </div>
      </div>
    `;
  }
  // Rei da Pelada: fila de espera logo abaixo da última partida (preenchida por atualizarFilaRei)
  if (isKing) html += `<div id="king-queue-banner" class="flex flex-wrap items-center gap-1.5 text-xs text-slate-400"></div>`;

  container.innerHTML = html;
  refreshIcons();
  aplicarEfeitosGol();
  if (isKing) atualizarFilaRei();

  // Inicia o tick se houver partidas com cronômetro em execução
  const hasRunningTimer = (state.fixtures || []).some(m => !m.finished && m.timer_status === 'running');
  if (hasRunningTimer) {
    startGlobalMatchTimerTick();
  }
}

// "DD/MM/YYYY HH:MM:SS" -> "DD/MM/YYYY HH:MM"
function formatarDataEdicao(texto) {
  return String(texto || "").replace(/^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}):\d{2}$/, "$1");
}

function renderSingleMatchCard(m) {
  const isFinished = m.finished;
  const isCustomMode = state.config.championship_type === "custom";
  const isLeader = state.role === 'admin';
  const homeColor = getTeamColor(m.home_team_id || m.home_team_name);
  const awayColor = getTeamColor(m.away_team_id || m.away_team_name);
  
  const arrastar = isLeader
    ? `data-drag-kind="fixture" data-h-dragstart="onFixtureDragStart" data-h-dragend="onFixtureDragEnd" data-h-dragover="onFixtureDragOver" data-h-dragleave="onFixtureDragLeave" data-h-drop="onFixtureDrop" data-a="${escapeHtml(JSON.stringify(["@event", m.id]))}"`
    : "";
  const pillCronometro = m.started_at ? `
    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-pitch/80 border border-borderLight shadow-inner text-slate-300 whitespace-nowrap">
      <span class="text-[11px] text-slate-400">Início em <strong class="text-white font-mono">${escapeHtml(m.started_at)}</strong></span>
      ${!isFinished ? `
        <span class="w-1.5 h-1.5 rounded-full ${m.timer_status === 'running' ? 'bg-emerald-400 animate-pulse' : (m.timer_status === 'paused' ? 'bg-amber-400' : 'bg-slate-500')}"></span>
        <span id="match-timer-${m.id}" class="font-mono font-black text-xs ${m.timer_status === 'running' ? 'text-emerald-400' : (m.timer_status === 'paused' ? 'text-amber-400' : 'text-slate-300')}">
          ${formatMatchRemainingTime(m)}
        </span>
        ${m.timer_status === 'paused' ? `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="none" class="w-3.5 h-3.5 text-amber-400 shrink-0" role="img" aria-label="Pausado" title="Pausado"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          ${isLeader ? `
            <button
              type="button"
              data-h-click="removerInicioPartida" data-a="${escapeHtml(JSON.stringify([m.id]))}"
              title="Descartar início da partida"
              aria-label="Descartar início da partida"
              class="w-4 h-4 rounded-full bg-rose-500/20 hover:bg-rose-500 text-rose-400 hover:text-white flex items-center justify-center transition active:scale-95 ml-0.5">
              <i data-lucide="x" class="w-3 h-3 stroke-[2.5]"></i>
            </button>
          ` : ''}
        ` : ''}
      ` : ''}
    </span>` : '';
  return `
    <div id="match-card-${m.id}" data-match-id="${m.id}" ${arrastar} class="${isLeader ? 'fixture-draggable ' : ''}bg-surface border ${isFinished ? 'border-borderLight/40 opacity-90' : 'border-borderLight hover:border-emerald-500/50'} rounded-3xl p-5 space-y-4 transition shadow-lg relative overflow-hidden">
      <!-- Status Cravado / Gravado Centralizado com Frisos Metálicos -->
      <div class="flex items-center gap-3 pt-0.5 pb-0.5">
        <div class="flex-1 match-finished-groove-left"></div>
        <span class="match-finished-carved text-xs sm:text-[13px] font-black uppercase select-none tracking-[0.25em] shrink-0">
          ${isFinished ? 'Partida Finalizada' : 'Em Aberto'}
        </span>
        <div class="flex-1 match-finished-groove-right"></div>
      </div>
      
      <!-- Linha dos Times e Placar -->
      <div class="flex items-center justify-between gap-4">
        
        <!-- Mandante -->
        <div id="side-home-${m.id}" class="flex-1 text-center space-y-2">
          <h4 class="ds-c8c42c63-${homeColor.slice(1)} font-extrabold text-sm sm:text-base truncate">${escapeHtml(m.home_team_name)}</h4>
          ${(!isFinished && isLeader) ? `
            <div class="flex items-center justify-center gap-1.5">
              <button data-h-click="adjustScore" data-a="${escapeHtml(JSON.stringify([m.id, "home", -1]))}" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-slate-700 text-slate-300 font-bold text-xs transition">-</button>
              <span id="score-home-${m.id}" class="text-2xl font-black text-white w-8">${m.home_score}</span>
              <button data-h-click="adjustScore" data-a="${escapeHtml(JSON.stringify([m.id, "home", 1]))}" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-neon-accent hover:text-black font-bold text-xs transition">+</button>
            </div>
          ` : `
            <div class="text-3xl font-black text-white">${m.home_score}</div>
          `}
        </div>

        <!-- Divisor VS Interativo com Cronômetro -->
        <div class="text-center px-1 sm:px-2 flex flex-col items-center justify-center select-none shrink-0 overflow-visible translate-y-1">
          <button 
            type="button"
            ${(!isFinished && isLeader) ? `data-h-click="toggleMatchTimer" data-a="${escapeHtml(JSON.stringify([m.id]))}"` : ''}
            ${(!isFinished && !isLeader) ? 'disabled' : ''}
            title="${isFinished ? 'Partida encerrada' : (!isLeader ? 'Apenas o administrador controla o cronômetro' : (m.timer_status === 'running' ? 'Pausar cronômetro' : 'Iniciar / Retomar cronômetro'))}"
            aria-label="${isFinished ? 'Partida encerrada' : 'Controlar cronômetro da partida'}"
            class="relative inline-flex items-center justify-center p-1.5 rounded-2xl group transition focus:outline-none ${(!isFinished && isLeader) ? 'cursor-pointer vs-btn-active' : 'cursor-default opacity-80'}">
            <span class="text-4xl sm:text-5xl font-black italic tracking-wider vs-silver-metal select-none">VS</span>
            ${(!isFinished && m.timer_status === 'running') ? `
              <span class="absolute -top-1 -right-1 flex h-3 w-3">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span class="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            ` : ''}
          </button>
        </div>

        <!-- Visitante -->
        <div id="side-away-${m.id}" class="flex-1 text-center space-y-2">
          <h4 class="ds-c8c42c63-${awayColor.slice(1)} font-extrabold text-sm sm:text-base truncate">${escapeHtml(m.away_team_name)}</h4>
          ${(!isFinished && isLeader) ? `
            <div class="flex items-center justify-center gap-1.5">
              <button data-h-click="adjustScore" data-a="${escapeHtml(JSON.stringify([m.id, "away", -1]))}" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-slate-700 text-slate-300 font-bold text-xs transition">-</button>
              <span id="score-away-${m.id}" class="text-2xl font-black text-white w-8">${m.away_score}</span>
              <button data-h-click="adjustScore" data-a="${escapeHtml(JSON.stringify([m.id, "away", 1]))}" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-neon-accent hover:text-black font-bold text-xs transition">+</button>
            </div>
          ` : `
            <div class="text-3xl font-black text-white">${m.away_score}</div>
          `}
        </div>

      </div>
      
      <!-- Atribuição rápida de gols aos atletas; cronômetro centralizado na mesma linha -->
      ${!isFinished ? `
        <div class="pt-2 border-t border-borderLight/40 grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:gap-2 text-xs">
          <div class="justify-self-start min-w-0">
            ${isLeader ? `
              <button data-h-click="abrirAtribuicaoGols" data-a="${escapeHtml(JSON.stringify([m.id]))}" title="Quem fez os gols? (${m.events ? m.events.length : 0})" aria-label="Quem fez os gols" class="w-8 h-8 bg-slate-500/10 hover:bg-slate-500/20 text-slate-300 border border-slate-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                <i data-lucide="user-check" class="w-4 h-4"></i>
              </button>
            ` : `
              <span class="text-[11px] text-slate-500 flex items-center gap-1">
                <i data-lucide="clock" class="w-3.5 h-3.5 text-amber-400"></i> Em andamento
              </span>
            `}
          </div>
          <div class="justify-self-center min-w-0">${pillCronometro}</div>
          <div class="justify-self-end">
            ${isLeader ? `
              <div class="flex items-center gap-2">
                ${`
                <button data-h-click="removerPartidaCustomizada" data-a="${escapeHtml(JSON.stringify([m.id]))}" title="Excluir Partida" aria-label="Excluir Partida" class="w-8 h-8 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
                `}
                <button data-h-click="salvarPartidaFinalizada" data-a="${escapeHtml(JSON.stringify([m.id]))}" title="Salvar Resultado" aria-label="Salvar Resultado" class="w-8 h-8 bg-neon-accent/10 hover:bg-neon-accent/20 text-neon-accent border border-neon-accent/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                  <i data-lucide="save" class="w-4 h-4"></i>
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      ` : `
        <div class="pt-2 border-t border-borderLight/30 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs text-slate-400">
          <div class="justify-self-start min-w-0">
            ${m.edited_at ? `
              <span class="text-rose-500 font-semibold text-[11px]" title="Partida editada depois de finalizada">* Editada em ${escapeHtml(formatarDataEdicao(m.edited_at))}</span>
            ` : ''}
          </div>
          <div class="justify-self-center min-w-0 order-first sm:order-none">${pillCronometro}</div>
          <div class="justify-self-end flex items-center gap-2">
            <button data-h-click="verDetalhesPartida" data-a="${escapeHtml(JSON.stringify([m.id]))}" title="Ver detalhes" aria-label="Ver detalhes" class="w-8 h-8 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
              <i data-lucide="info" class="w-4 h-4 icone-info"></i>
            </button>
            ${isLeader ? `
              <button data-h-click="reabrirPartida" data-a="${escapeHtml(JSON.stringify([m.id]))}" title="Editar Partida" aria-label="Editar Partida" class="w-8 h-8 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </div>
      `}
    </div>
  `;
}

// ==============================
// CRONÔMETRO REGRESSIVO DE PARTIDA
// ==============================
let activeMatchTimers = new Set();
let matchTimerIntervalId = null;

function getMatchDurationSeconds() {
  const mins = (state.config && state.config.match_duration_minutes) ? parseInt(state.config.match_duration_minutes, 10) : 10;
  return (isNaN(mins) || mins <= 0 ? 10 : mins) * 60;
}

function calculateMatchRemainingSeconds(m) {
  const totalSeconds = getMatchDurationSeconds();
  let elapsed = m.timer_elapsed_seconds || 0;
  if (m.timer_status === 'running' && m.timer_updated_at) {
    const delta = Math.max(0, Math.floor((Date.now() - m.timer_updated_at) / 1000));
    elapsed += delta;
  }
  const remaining = Math.max(0, totalSeconds - elapsed);
  return { remaining, elapsed, total: totalSeconds };
}

function formatMatchRemainingTime(m) {
  const { remaining } = calculateMatchRemainingSeconds(m);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function startGlobalMatchTimerTick() {
  if (matchTimerIntervalId) return;
  matchTimerIntervalId = setInterval(() => {
    let hasRunning = false;
    (state.fixtures || []).forEach(m => {
      if (m.finished || m.timer_status !== 'running') return;
      hasRunning = true;
      const el = document.getElementById(`match-timer-${m.id}`);
      const { remaining } = calculateMatchRemainingSeconds(m);
      if (el) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (remaining === 0) {
          el.classList.add('text-rose-500', 'animate-bounce');
          el.classList.remove('text-emerald-400');
        }
      }
      // Se chegou a zero e o alarme ainda não foi disparado para esta contagem
      if (remaining === 0 && !m._alarmTriggered) {
        m._alarmTriggered = true;
        m.timer_status = 'stopped';
        const alarmFile = obterSomAlarme();
        if (window.SoundManager) {
          window.SoundManager.playAlarm(alarmFile);
        }
        showToast("⏰ Fim de jogo! Tempo esgotado.");
        if (state.role === 'admin') {
          sincronizarEstadoServidor(true);
        }
        renderFixtures();
      }
    });

    if (!hasRunning && matchTimerIntervalId) {
      clearInterval(matchTimerIntervalId);
      matchTimerIntervalId = null;
    }
  }, 1000);
}

async function toggleMatchTimer(matchId) {
  if (state.role !== 'admin') return;
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m || m.finished) return;

  if (window.SoundManager) window.SoundManager.play('efeitos');

  const now = Date.now();
  const nowBRT = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });

  if (!m.started_at) {
    // 1º Clique: Inicia a contagem
    m.started_at = nowBRT;
    m.timer_status = 'running';
    m.timer_elapsed_seconds = 0;
    m.timer_updated_at = now;
    m._alarmTriggered = false;
    showToast(`Partida iniciada às ${nowBRT}! Cronômetro correndo.`);
  } else if (m.timer_status === 'running') {
    // Pausa o cronômetro
    const elapsedNow = Math.floor((now - (m.timer_updated_at || now)) / 1000);
    m.timer_elapsed_seconds = (m.timer_elapsed_seconds || 0) + elapsedNow;
    m.timer_status = 'paused';
    m.timer_updated_at = now;
    showToast("Cronômetro pausado.");
  } else if (m.timer_status === 'paused') {
    // Retoma o cronômetro
    m.timer_status = 'running';
    m.timer_updated_at = now;
    showToast("Cronômetro retomado!");
  } else {
    // Reinicia caso tenha parado/zerado
    m.timer_status = 'running';
    m.timer_elapsed_seconds = 0;
    m.timer_updated_at = now;
    m._alarmTriggered = false;
    showToast("Cronômetro reiniciado!");
  }

  renderFixtures();
  startGlobalMatchTimerTick();

  if (state.role === 'admin') {
    sincronizarEstadoServidor(true);
  }
}

async function removerInicioPartida(matchId) {
  if (state.role !== 'admin') return;
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m || m.finished) return;

  if (window.SoundManager) window.SoundManager.play('efeitos');

  m.started_at = null;
  m.timer_status = 'stopped';
  m.timer_elapsed_seconds = 0;
  m.timer_updated_at = null;
  m._alarmTriggered = false;

  renderFixtures();
  showToast("Início da partida descartado.");

  if (state.role === 'admin') {
    sincronizarEstadoServidor(true);
  }
}

function atualizarBotaoPreviewAlarme(isPlaying) {
  const btn = document.getElementById("btn-preview-alarm");
  if (!btn) return;
  btn.innerHTML = `<i id="icon-preview-alarm" data-lucide="${isPlaying ? 'square' : 'play'}" class="w-4 h-4 fill-current"></i>`;
  btn.setAttribute("title", isPlaying ? "Parar teste de som" : "Ouvir som do alarme");
  if (window.lucide && typeof window.lucide.createIcons === "function") {
    window.refreshIcons();
  }
}

function pararPreviewAlarme() {
  if (window.SoundManager && typeof window.SoundManager.stopPreview === 'function') {
    window.SoundManager.stopPreview();
  }
  atualizarBotaoPreviewAlarme(false);
}

const ALARME_PADRAO = 'standard-emergency-warning-signal.mp3';

// Som do alarme é preferência pessoal (por dispositivo), não da pelada
function obterSomAlarme() {
  try { return localStorage.getItem('futmatch_alarm_sound') || ALARME_PADRAO; } catch (e) { return ALARME_PADRAO; }
}

function carregarSomAlarme() {
  const el = document.getElementById("cfg-alarm-sound");
  if (!el) return;
  el.value = obterSomAlarme();
  if (el.value !== obterSomAlarme()) el.value = ALARME_PADRAO;
}

function aoMudarSomAlarme() {
  pararPreviewAlarme();
  const el = document.getElementById("cfg-alarm-sound");
  if (!el) return;
  try { localStorage.setItem('futmatch_alarm_sound', el.value); } catch (e) {}
  showToast("Preferência salva!");
}

function testarSomAlarme() {
  const select = document.getElementById("cfg-alarm-sound");
  if (!select) return;
  const soundFile = select.value;

  if (window.SoundManager) {
    const isPlaying = window.SoundManager.togglePreview(soundFile, (playing) => {
      atualizarBotaoPreviewAlarme(playing);
    });
    atualizarBotaoPreviewAlarme(isPlaying);
  }
}

// Efeito de gol pendente: é aplicado no cartão logo após o re-render da aba
let goalFxPendente = null;

function aplicarEfeitosGol() {
  const fx = goalFxPendente;
  goalFxPendente = null;
  if (!fx) return;
  const side = document.getElementById(`side-${fx.side}-${fx.matchId}`);
  const score = document.getElementById(`score-${fx.side}-${fx.matchId}`);
  if (!side) return;
  const verde = fx.tipo === 'add';

  // Placar pisca 3x (0,5s cada), vermelho no menos e verde no mais
  if (score) {
    const classe = verde ? 'goal-score-blink-green' : 'goal-score-blink-red';
    score.classList.add(classe);
    setTimeout(() => score.classList.remove(classe), 1600);
  }

  // Degradê suave em todo o cartão, saindo da borda do lado do time (esquerda ou direita), piscando 3x
  const card = side.closest('[id^="match-card-"]') || side;
  card.classList.add('goal-fx-host');
  const flash = document.createElement('span');
  const lado = fx.side === 'home' ? 'left' : 'right';
  flash.className = `goal-card-flash goal-card-flash-${verde ? 'green' : 'red'}-${lado}`;
  card.appendChild(flash);
  setTimeout(() => flash.remove(), 1600);

  // Só no mais: confete branco e a cor do time (lida do nome do time já renderizado)
  if (verde) {
    const nomeTime = side.querySelector('h4');
    // canvas-confetti aceita hex de forma garantida: converte o rgb(...) computado
    const rgb = nomeTime ? getComputedStyle(nomeTime).color.match(/\d+/g) : null;
    const corTime = rgb ? '#' + rgb.slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('') : '#ffffff';
    dispararConfetes(side, corTime);
  }
}

// Confetes na área do cartão (atrás do texto e dos botões), caindo por 3s
function dispararConfetes(side, cor) {
  if (!window.confetti || typeof window.confetti.create !== 'function') return;
  const card = side.closest('[id^="match-card-"]') || side;
  if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
  card.classList.add('goal-fx-host');
  const cardRect = card.getBoundingClientRect();
  const sideRect = side.getBoundingClientRect();
  // Faixa horizontal do lado do time, normalizada em relação ao cartão
  const xMin = (sideRect.left - cardRect.left) / cardRect.width;
  const xMax = (sideRect.right - cardRect.left) / cardRect.width;
  const canvas = document.createElement('canvas');
  canvas.className = 'goal-confetti-canvas';
  canvas.width = card.offsetWidth;
  canvas.height = card.offsetHeight;
  card.appendChild(canvas);
  const fire = window.confetti.create(canvas, { resize: false, useWorker: false });
  const duracao = 3000;
  const cores = ['#ffffff', cor];
  const inicio = performance.now();
  const timer = setInterval(() => {
    if (performance.now() - inicio >= duracao) { clearInterval(timer); return; }
    const x = xMin + Math.random() * (xMax - xMin);
    fire({ particleCount: 5, angle: 270, spread: 50, startVelocity: 6, gravity: 0.9, origin: { x, y: 0 }, colors: cores, ticks: 220, scalar: 0.9 });
  }, 120);
  setTimeout(() => canvas.remove(), duracao + 2000);
}

function adjustScore(matchId, side, delta) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m || m.finished) return;
  const antes = side === 'home' ? m.home_score : m.away_score;

  if (side === 'home') {
    const newScore = Math.max(0, m.home_score + delta);
    m.home_score = newScore;
    document.getElementById(`score-home-${matchId}`).textContent = m.home_score;
    // Se o novo placar for menor que o número de gols atribuídos ao time da casa, ajusta
    const homePlayerIds = new Set((m.home_players || []).map(p => p.id));
    if (m.events) {
      let homeGoalsEvents = m.events.filter(e => homePlayerIds.has(e.player_id) && e.event_type === "goal");
      while (homeGoalsEvents.length > m.home_score) {
        const removed = homeGoalsEvents.pop();
        const idx = m.events.findIndex(e => e.id === removed.id);
        if (idx !== -1) m.events.splice(idx, 1);
      }
    }
  } else {
    const newScore = Math.max(0, m.away_score + delta);
    m.away_score = newScore;
    document.getElementById(`score-away-${matchId}`).textContent = m.away_score;
    // Se o novo placar for menor que o número de gols atribuídos ao time visitante, ajusta
    const awayPlayerIds = new Set((m.away_players || []).map(p => p.id));
    if (m.events) {
      let awayGoalsEvents = m.events.filter(e => awayPlayerIds.has(e.player_id) && e.event_type === "goal");
      while (awayGoalsEvents.length > m.away_score) {
        const removed = awayGoalsEvents.pop();
        const idx = m.events.findIndex(e => e.id === removed.id);
        if (idx !== -1) m.events.splice(idx, 1);
      }
    }
  }
  const depois = side === 'home' ? m.home_score : m.away_score;
  if (depois !== antes) {
    goalFxPendente = { matchId, side, tipo: delta > 0 ? 'add' : 'remove' };
    renderFixtures();
  }
  sincronizarEstadoServidor(true);
}

// Modal de Atribuição de Gols aos Atletas
function abrirAtribuicaoGols(matchId) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;

  if (!m.events) m.events = [];

  const totalGoalsInScore = (m.home_score || 0) + (m.away_score || 0);
  if (totalGoalsInScore === 0) {
    showCustomAlert(
      "A partida está 0 x 0! Ajuste o placar no jogo com os botões + antes de definir quem marcou os gols.",
      "Placar Zerado"
    );
    return;
  }

  abrirModalDetalhesPartida(() => renderConteudoAtribuicaoGols(matchId), { titulo: 'Atribuir Gols', mensagem: 'Registre os gols de cada jogador.', icone: 'info', botoes: null });
}

function renderConteudoAtribuicaoGols(matchId) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;
  if (!m.events) m.events = [];

  const content = document.getElementById("modal-content");
  if (!content) return;

  const homePlayerIds = new Set((m.home_players || []).map(p => p.id));
  const awayPlayerIds = new Set((m.away_players || []).map(p => p.id));

  const homeGoalsAssigned = m.events.filter(e => homePlayerIds.has(e.player_id) && e.event_type === "goal").length;
  const awayGoalsAssigned = m.events.filter(e => awayPlayerIds.has(e.player_id) && e.event_type === "goal").length;

  const homeRemaining = Math.max(0, m.home_score - homeGoalsAssigned);
  const awayRemaining = Math.max(0, m.away_score - awayGoalsAssigned);
  const totalGoalsInScore = (m.home_score || 0) + (m.away_score || 0);
  const homeColor = getTeamColor(m.home_team_id || m.home_team_name);
  const awayColor = getTeamColor(m.away_team_id || m.away_team_name);

  content.innerHTML = `
    <div>
      <div class="flex items-center justify-between pr-6">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="goal" class="w-5 h-5 text-neon-accent"></i>
          <span>Artilharia da Partida</span>
        </h3>
        <span class="text-xs px-2.5 py-1 rounded-xl bg-card border border-borderLight font-extrabold flex items-center gap-1.5">
          <span class="ds-c8c42c63-${homeColor.slice(1)}">${escapeHtml(m.home_team_name)}</span>
          <span class="text-white">${m.home_score} x ${m.away_score}</span>
          <span class="ds-c8c42c63-${awayColor.slice(1)}">${escapeHtml(m.away_team_name)}</span>
        </span>
      </div>
      <p class="text-xs text-slate-400 mt-1">Distribua os gols marcados no placar entre os atletas de cada equipe:</p>
      
      <!-- Status de Gols por Time -->
      <div class="grid grid-cols-2 gap-2 mt-3">
        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="ds-c8c42c63-${homeColor.slice(1)} font-bold truncate">${escapeHtml(m.home_team_name)}</div>
          <div class="flex items-center justify-between mt-1 text-[11px]">
            <span class="text-slate-400">Atribuídos: <strong class="text-white">${homeGoalsAssigned}/${m.home_score}</strong></span>
            ${homeRemaining === 0 ? '<span class="text-emerald-400 font-bold">✓ Completo</span>' : `<span class="text-amber-400 font-bold">Faltam ${homeRemaining}</span>`}
          </div>
        </div>

        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="ds-c8c42c63-${awayColor.slice(1)} font-bold truncate">${escapeHtml(m.away_team_name)}</div>
          <div class="flex items-center justify-between mt-1 text-[11px]">
            <span class="text-slate-400">Atribuídos: <strong class="text-white">${awayGoalsAssigned}/${m.away_score}</strong></span>
            ${awayRemaining === 0 ? '<span class="text-emerald-400 font-bold">✓ Completo</span>' : `<span class="text-amber-400 font-bold">Faltam ${awayRemaining}</span>`}
          </div>
        </div>
      </div>
    </div>

    <div id="goals-players-scroll" class="space-y-4 max-h-72 overflow-y-auto pr-1">
      <!-- Time Mandante -->
      <div class="space-y-1.5">
        <div class="ds-c8c42c63-${homeColor.slice(1)} text-[11px] font-bold uppercase tracking-wider flex items-center justify-between">
          <span>${escapeHtml(m.home_team_name)} (Placar: ${m.home_score})</span>
          <span class="text-slate-400 font-normal lowercase">${homeGoalsAssigned}/${m.home_score} marcados</span>
        </div>
        ${(m.home_players || []).map(p => {
          const goalsCount = m.events.filter(e => e.player_id === p.id && e.event_type === "goal").length;
          const canAdd = m.home_score > homeGoalsAssigned;
          return `
            <div class="flex items-center justify-between p-2.5 bg-card rounded-xl border border-borderLight/50 text-xs">
              <div class="flex items-center gap-2">
                <span class="font-bold text-white">${escapeHtml(p.name)}</span>
                ${p.is_goalkeeper ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">GK</span>' : ''}
              </div>
              <div class="flex items-center gap-2">
                <span class="text-neon-accent font-extrabold text-xs">${goalsCount} ⚽</span>
                ${goalsCount > 0 ? `
                  <button data-h-click="removerGolJogador" data-a="${escapeHtml(JSON.stringify([m.id, p.id]))}" class="w-6 h-6 rounded-lg bg-cardLight hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 font-bold transition flex items-center justify-center text-xs">-</button>
                ` : ''}
                <button data-match-id="${escapeHtml(m.id)}" data-player-id="${escapeHtml(p.id)}" data-player-name="${escapeHtml(p.name)}" data-h-click="adicionarGolJogadorDeBotao" data-a="${escapeHtml(JSON.stringify(["@this"]))}" ${!canAdd ? 'disabled' : ''} class="px-2.5 py-1 ${canAdd ? 'bg-cardLight hover:bg-neon-accent hover:text-black text-white' : 'bg-cardLight/40 text-slate-600 cursor-not-allowed'} font-bold rounded-lg transition text-xs">+ Gol</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <!-- Time Visitante -->
      <div class="space-y-1.5 pt-2 border-t border-borderLight/40">
        <div class="ds-c8c42c63-${awayColor.slice(1)} text-[11px] font-bold uppercase tracking-wider flex items-center justify-between">
          <span>${escapeHtml(m.away_team_name)} (Placar: ${m.away_score})</span>
          <span class="text-slate-400 font-normal lowercase">${awayGoalsAssigned}/${m.away_score} marcados</span>
        </div>
        ${(m.away_players || []).map(p => {
          const goalsCount = m.events.filter(e => e.player_id === p.id && e.event_type === "goal").length;
          const canAdd = m.away_score > awayGoalsAssigned;
          return `
            <div class="flex items-center justify-between p-2.5 bg-card rounded-xl border border-borderLight/50 text-xs">
              <div class="flex items-center gap-2">
                <span class="font-bold text-white">${escapeHtml(p.name)}</span>
                ${p.is_goalkeeper ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">GK</span>' : ''}
              </div>
              <div class="flex items-center gap-2">
                <span class="text-neon-accent font-extrabold text-xs">${goalsCount} ⚽</span>
                ${goalsCount > 0 ? `
                  <button data-h-click="removerGolJogador" data-a="${escapeHtml(JSON.stringify([m.id, p.id]))}" class="w-6 h-6 rounded-lg bg-cardLight hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 font-bold transition flex items-center justify-center text-xs">-</button>
                ` : ''}
                <button data-match-id="${escapeHtml(m.id)}" data-player-id="${escapeHtml(p.id)}" data-player-name="${escapeHtml(p.name)}" data-h-click="adicionarGolJogadorDeBotao" data-a="${escapeHtml(JSON.stringify(["@this"]))}" ${!canAdd ? 'disabled' : ''} class="px-2.5 py-1 ${canAdd ? 'bg-cardLight hover:bg-neon-accent hover:text-black text-white' : 'bg-cardLight/40 text-slate-600 cursor-not-allowed'} font-bold rounded-lg transition text-xs">+ Gol</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>

    <div class="pt-3 border-t border-borderLight flex items-center justify-between">
      <span class="text-[11px] text-slate-400">Total: ${m.events.length} de ${totalGoalsInScore} gols atribuídos</span>
      <button data-h-click="concluirAtribuicaoGols" data-a="${escapeHtml(JSON.stringify([m.id]))}" class="px-5 py-2 bg-neon-accent text-black font-extrabold text-xs rounded-xl shadow">Concluir</button>
    </div>
  `;
}

// Os dados vão em data-* (escapados como texto) e são lidos via dataset: nada é interpolado em código JS.
function adicionarGolJogadorDeBotao(botao) {
  adicionarGolJogador(botao.dataset.matchId, botao.dataset.playerId, botao.dataset.playerName);
}

function adicionarGolJogador(matchId, playerId, playerName) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;
  if (!m.events) m.events = [];

  const homePlayerIds = new Set((m.home_players || []).map(p => p.id));
  const awayPlayerIds = new Set((m.away_players || []).map(p => p.id));

  const isHome = homePlayerIds.has(playerId);
  const isAway = awayPlayerIds.has(playerId);

  // Gol só pode ser atribuído a quem está escalado na partida (snapshot de jogadores de cada time)
  if (!isHome && !isAway) {
    showToast("Este jogador não está escalado nesta partida.");
    return;
  }

  const homeGoalsAssigned = m.events.filter(e => homePlayerIds.has(e.player_id) && e.event_type === "goal").length;
  const awayGoalsAssigned = m.events.filter(e => awayPlayerIds.has(e.player_id) && e.event_type === "goal").length;

  if (isHome) {
    const homeBadge = m.home_team_name;
    if (m.home_score === 0) {
      showToast(`${homeBadge} está com 0 gols no placar!`);
      return;
    }
    if (homeGoalsAssigned >= m.home_score) {
      showToast(`Limite de gols atingido para ${homeBadge} (${m.home_score} gols)`);
      return;
    }
  } else if (isAway) {
    const awayBadge = m.away_team_name;
    if (m.away_score === 0) {
      showToast(`${awayBadge} está com 0 gols no placar!`);
      return;
    }
    if (awayGoalsAssigned >= m.away_score) {
      showToast(`Limite de gols atingido para ${awayBadge} (${m.away_score} gols)`);
      return;
    }
  } else {
    showToast("Jogador não pertence a nenhum dos dois times da partida.");
    return;
  }

  m.events.push({
    id: "ev_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    match_id: matchId,
    player_id: playerId,
    player_name: playerName,
    event_type: "goal"
  });

  const scrollEl = document.getElementById("goals-players-scroll");
  const previousScrollTop = scrollEl ? scrollEl.scrollTop : 0;

  renderConteudoAtribuicaoGols(matchId);
  refreshIcons();

  const newScrollEl = document.getElementById("goals-players-scroll");
  if (newScrollEl) {
    newScrollEl.scrollTop = previousScrollTop;
  }
}

function removerGolJogador(matchId, playerId) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m || !m.events) return;

  const idx = m.events.slice().reverse().findIndex(e => e.player_id === playerId && e.event_type === "goal");
  if (idx !== -1) {
    const realIdx = m.events.length - 1 - idx;
    m.events.splice(realIdx, 1);
  }

  const scrollEl = document.getElementById("goals-players-scroll");
  const previousScrollTop = scrollEl ? scrollEl.scrollTop : 0;

  renderConteudoAtribuicaoGols(matchId);
  refreshIcons();

  const newScrollEl = document.getElementById("goals-players-scroll");
  if (newScrollEl) {
    newScrollEl.scrollTop = previousScrollTop;
  }
}

function concluirAtribuicaoGols(matchId) {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  closeModal();
  renderFixtures();
  sincronizarEstadoServidor(true);
}

async function reabrirPartida(matchId) {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;

  const isKing = state.config.championship_type === "king";
  const ultimaFinalizada = state.fixtures.map(f => !!f.finished).lastIndexOf(true);
  const avisoRei = (isKing && state.fixtures.indexOf(m) !== ultimaFinalizada)
    ? `\n\n`
    : "";
  const confirmed = await showCustomConfirm(
    `Deseja reabrir a partida "${m.home_team_name} x ${m.away_team_name}" para edição?${avisoRei}`,
    "Editar Partida",
    "Reabrir para Edição",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  if (!state.currentPelada || !state.currentPelada.code) {
    showToast("Entre em uma pelada para alterar o histórico.");
    return;
  }
  try {
    const pCode = state.currentPelada.code;
    const deleteUrl = `/api/matches/${matchId}?pelada_code=${pCode}`;
    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: getAuthHeaders()
    });

    if (res.ok) {
      m.finished = false;
      m.reopened = true; // ao salvar de novo, a partida passa a mostrar a marca de edição
      renderFixtures();
      sincronizarEstadoServidor();
      await atualizarDashboard();
      showToast("Partida reaberta para edição!");
    } else {
      throw new Error("Erro ao reabrir partida");
    }
  } catch (err) {
    console.error(err);
    await showCustomAlert("Não foi possível reabrir a partida para edição.", "Erro", false, { icone: 'circle-x' });
  }
}

async function salvarPartidaFinalizada(matchId) {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;

  if (!m.events) m.events = [];

  const homePlayerIds = new Set((m.home_players || []).map(p => p.id));
  const awayPlayerIds = new Set((m.away_players || []).map(p => p.id));

  const homeGoalsAssigned = m.events.filter(e => homePlayerIds.has(e.player_id) && e.event_type === "goal").length;
  const awayGoalsAssigned = m.events.filter(e => awayPlayerIds.has(e.player_id) && e.event_type === "goal").length;

  if (homeGoalsAssigned < m.home_score || awayGoalsAssigned < m.away_score) {
    const totalAssigned = homeGoalsAssigned + awayGoalsAssigned;
    const totalScore = m.home_score + m.away_score;
    const confirmed = await showCustomConfirm(
      `O placar da partida é ${m.home_score} x ${m.away_score} (${totalScore} gols), mas apenas ${totalAssigned} gols foram atribuídos aos jogadores. Deseja abrir a artilharia para distribuir os gols restantes?`,
      "Gols Pendentes de Atribuição",
      "Distribuir Gols Agora",
      "Salvar Mesmo Assim"
    );

    if (confirmed) {
      abrirAtribuicaoGols(matchId);
      return;
    }
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    showToast("Entre em uma pelada para salvar o resultado.");
    return;
  }
  try {
    const pCode = state.currentPelada.code;
    const saveUrl = `/api/matches/save?pelada_code=${pCode}`;
    const res = await fetch(saveUrl, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(m)
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      if (res.status === 403) {
        state.role = 'spectator';
        updateRoleUI();
        await showCustomAlert(
          "Sua sessão de Administrador expirou ou não possui permissão. Acesse a aba Configurações para reinserir a senha mestra.",
          "Sessão Expirada"
        );
        switchTab('settings');
        return;
      }
      throw new Error(errData.detail || "Falha ao gravar a partida no servidor.");
    }

    const data = await res.json();
    m.finished = true;
    // O servidor define o vencedor (winner_team_id) e o empate: a tela usa esses campos
    m.winner_team_id = data.match.winner_team_id;
    m.is_draw = data.match.is_draw;
    if (m.reopened) {
      m.edited_at = data.match.played_at;
      m.reopened = false;
    } else {
      m.played_at = data.match.played_at;
    }
    m.timer_status = 'stopped';

    renderFixtures();
    sincronizarEstadoServidor();
    if (state.config.championship_type === "king") await gerarProximaPartidaRei();
    await atualizarDashboard();
    showToast(`Resultado salvo! ${m.home_team_name} ${m.home_score} x ${m.away_score} ${m.away_team_name}`);
  } catch (err) {
    console.error(err);
    await showCustomAlert(err.message || "Falha ao salvar a partida.", "Erro na Gravação", false, { icone: 'circle-x' });
  }
}

// ==============================
// DASHBOARD & HISTÓRICO SQLITE
// ==============================
async function atualizarDashboard() {
  if (!state.currentPelada || !state.currentPelada.code) return;
  try {
    const pCode = state.currentPelada.code;
    const url = `/api/dashboard?pelada_code=${pCode}`;
    const res = await fetch(url);
    const data = await res.json();

    // KPIs
    document.getElementById("kpi-matches").textContent = data.summary.total_matches;
    document.getElementById("kpi-goals").textContent = data.summary.total_goals;
    document.getElementById("kpi-avg-goals").textContent = data.summary.avg_goals_per_match.toFixed(1);

    if (data.top_scorers && data.top_scorers.length > 0) {
      document.getElementById("kpi-top-scorer").textContent = data.top_scorers[0].name;
      const g = data.top_scorers[0].goals;
      document.getElementById("kpi-top-scorer-goals").textContent = `${g} ${g < 2 ? 'gol marcado' : 'gols marcados'}`;
    } else {
      document.getElementById("kpi-top-scorer").textContent = "-";
      document.getElementById("kpi-top-scorer-goals").textContent = "0 gol";
    }

    if (data.top_winners && data.top_winners.length > 0) {
      const best = data.top_winners[0];
      document.getElementById("kpi-top-winner").textContent = best.name;
      document.getElementById("kpi-top-winner-rate").textContent = `${best.wins} ${best.wins < 2 ? 'vitória' : 'vitórias'} (${best.win_rate}%)`;
    } else {
      document.getElementById("kpi-top-winner").textContent = "-";
      document.getElementById("kpi-top-winner-rate").textContent = "0 vitória (0%)";
    }

    // Tabela Leaderboard Times
    renderLeaderboard(data.leaderboard);

    // Destaques Individuais
    renderIndividualRankings(data.top_scorers, data.top_winners);

    // Gráfico de Evolução Cronológica (Gols, Vitórias e Aproveitamento)
    const matchesForEvolution = data.all_matches || data.recent_matches || [];
    renderDashboardEvolutionChart(matchesForEvolution);

    // Histórico de Partidas (com paginação de 6 em 6)
    const matchesForHistory = data.all_matches || data.recent_matches || [];
    renderMatchesHistory(matchesForHistory);

  } catch (err) {
    console.error("Erro ao atualizar métricas:", err);
  }
}

function renderLeaderboard(leaderboard) {
  const tbody = document.getElementById("table-leaderboard-body");
  if (!tbody) return;

  if (!leaderboard || leaderboard.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="py-6 text-center text-slate-500">Nenhuma partida finalizada no histórico.</td></tr>`;
    return;
  }

  tbody.innerHTML = leaderboard.map((t, idx) => {
    const sg = t.goals_scored - t.goals_conceded;
    const sgColor = sg > 0 ? 'text-emerald-400' : sg < 0 ? 'text-rose-400' : 'text-slate-400';
    const teamColor = getTeamColor(t.team_id || t.name);

    // Posições no pódio com cores ouro, prata, bronze e natural (cinza claro)
    let posClass = "text-slate-400 font-medium";
    if (idx === 0) {
      posClass = "text-amber-400 font-extrabold"; // 1º Ouro
    } else if (idx === 1) {
      posClass = "text-slate-300 font-bold"; // 2º Prata
    } else if (idx === 2) {
      posClass = "text-[#cd7f32] font-bold"; // 3º Bronze
    }

    return `
      <tr class="hover:bg-card/40 transition">
        <td class="py-2.5 font-bold flex items-center space-x-2">
          <span class="w-5 text-center ${posClass}">${idx + 1}</span>
          <span class="ds-c8c42c63-${teamColor.slice(1)}">${escapeHtml(t.name)}</span>
        </td>
        <td class="py-2.5 text-center text-slate-300">${t.matches}</td>
        <td class="py-2.5 text-center text-slate-300">${t.wins}</td>
        <td class="py-2.5 text-center text-slate-300">${t.draws}</td>
        <td class="py-2.5 text-center text-slate-300">${t.losses}</td>
        <td class="py-2.5 text-center text-slate-300">${t.goals_scored}</td>
        <td class="py-2.5 text-center text-slate-300">${t.goals_conceded}</td>
        <td class="py-2.5 text-center font-semibold ${sgColor}">${sg > 0 ? '+' : ''}${sg}</td>
        <td class="py-2.5 text-right font-black text-neon-accent text-sm">${t.points}</td>
      </tr>
    `;
  }).join("");
}

function renderIndividualRankings(scorers, winners) {
  const scorersEl = document.getElementById("list-scorers");
  const winnersEl = document.getElementById("list-winners");

  if (scorersEl) {
    if (!scorers || scorers.length === 0 || scorers[0].goals === 0) {
      scorersEl.innerHTML = `<p class="text-xs text-slate-500 py-1.5">Nenhum gol atribuído ainda.</p>`;
    } else {
      scorersEl.innerHTML = scorers.filter(s => s.goals > 0).slice(0, 10).map((s, idx) => `
        <div class="flex items-center justify-between text-xs py-1.5 px-3 rounded-xl bg-card border border-borderLight/40">
          <span class="flex items-center gap-2 text-white font-medium">
            <span class="text-amber-400 font-bold">${idx + 1}.</span>
            ${escapeHtml(s.name)}
          </span>
          <span class="font-extrabold text-neon-accent">${s.goals} ⚽</span>
        </div>
      `).join("");
    }
  }

  if (winnersEl) {
    if (!winners || winners.length === 0 || winners[0].wins === 0) {
      winnersEl.innerHTML = `<p class="text-xs text-slate-500 py-1.5">Sem jogos concluídos.</p>`;
    } else {
      winnersEl.innerHTML = winners.filter(w => w.wins > 0).slice(0, 10).map((w, idx) => `
        <div class="flex items-center justify-between text-xs py-1.5 px-3 rounded-xl bg-card border border-borderLight/40">
          <span class="flex items-center gap-2 text-white font-medium">
            <span class="text-yellow-400 font-bold">${idx + 1}.</span>
            ${escapeHtml(w.name)}
          </span>
          <span class="font-extrabold text-slate-300">${w.wins} vitórias</span>
        </div>
      `).join("");
    }
  }

  updateScorersScrollIndicator();
  updateWinnersScrollIndicator();
  refreshIcons();
}

function updateScorersScrollIndicator() {
  const container = document.getElementById("list-scorers");
  const indicatorDown = document.getElementById("scorers-scroll-indicator-down");
  const indicatorUp = document.getElementById("scorers-scroll-indicator-up");
  if (!container) return;

  const hasItems = container.children.length > 0 && !container.querySelector("p");
  const hasMoreBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 8;
  const hasMoreAbove = container.scrollTop > 8;

  if (indicatorDown) {
    if (hasItems && hasMoreBelow) {
      indicatorDown.classList.remove("hidden");
    } else {
      indicatorDown.classList.add("hidden");
    }
  }

  if (indicatorUp) {
    if (hasItems && hasMoreAbove) {
      indicatorUp.classList.remove("hidden");
    } else {
      indicatorUp.classList.add("hidden");
    }
  }
}

function scrollScorersListDown() {
  const container = document.getElementById("list-scorers");
  if (!container) return;
  container.scrollBy({ top: 100, behavior: "smooth" });
}

function scrollScorersListUp() {
  const container = document.getElementById("list-scorers");
  if (!container) return;
  container.scrollBy({ top: -100, behavior: "smooth" });
}

function updateWinnersScrollIndicator() {
  const container = document.getElementById("list-winners");
  const indicatorDown = document.getElementById("winners-scroll-indicator-down");
  const indicatorUp = document.getElementById("winners-scroll-indicator-up");
  if (!container) return;

  const hasItems = container.children.length > 0 && !container.querySelector("p");
  const hasMoreBelow = container.scrollHeight - container.scrollTop - container.clientHeight > 8;
  const hasMoreAbove = container.scrollTop > 8;

  if (indicatorDown) {
    if (hasItems && hasMoreBelow) {
      indicatorDown.classList.remove("hidden");
    } else {
      indicatorDown.classList.add("hidden");
    }
  }

  if (indicatorUp) {
    if (hasItems && hasMoreAbove) {
      indicatorUp.classList.remove("hidden");
    } else {
      indicatorUp.classList.add("hidden");
    }
  }
}

function scrollWinnersListDown() {
  const container = document.getElementById("list-winners");
  if (!container) return;
  container.scrollBy({ top: 100, behavior: "smooth" });
}

function scrollWinnersListUp() {
  const container = document.getElementById("list-winners");
  if (!container) return;
  container.scrollBy({ top: -100, behavior: "smooth" });
}

// ==============================
// GRÁFICO DE EVOLUÇÃO CRONOLÓGICA (CHART.JS)
// ==============================
let evolutionChartInstance = null;
window.evolutionChartInstance = null;
let currentEvolutionMetric = 'goals'; // 'goals' | 'wins' | 'consistency' | 'avg_goals'
let selectedChartPlayerIds = new Set();
let cachedEvolutionMatches = [];
let chartAvailablePlayers = [];

// Registra positioner customizado do Chart.js para o tooltip seguir o cursor do mouse
if (typeof Chart !== 'undefined' && Chart.Tooltip && Chart.Tooltip.positioners) {
  Chart.Tooltip.positioners.followMouse = function(items, eventPosition) {
    if (!eventPosition || eventPosition.x === undefined) {
      return false;
    }
    return {
      x: eventPosition.x,
      y: eventPosition.y
    };
  };
}

const CHART_PALETTE = [
  '#00f59b', // neon accent
  '#38bdf8', // sky
  '#fbbf24', // amber
  '#f43f5e', // rose
  '#a855f7', // purple
  '#34d399', // emerald
  '#f97316', // orange
  '#e879f9', // fuchsia
  '#22d3ee', // cyan
  '#a3e635', // lime
  '#818cf8', // indigo
  '#fb7185'  // pink
];

// Marcadores por jogador: cor × forma × preenchimento × traço.
// 12 cores × 8 formas × 2 preenchimentos × 2 traços = 384 combinações.
// Cor = idx % 12 e forma = idx % 8: o par só se repete a cada 24 jogadores,
// então até 24 jogadores têm combinação cor+forma única.
const CHART_MARKER_SHAPES = {
  circle: '<circle cx="12" cy="12" r="9"/>',
  triangle: '<polygon points="12,3 21.5,20 2.5,20"/>',
  square: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/>',
  diamond: '<polygon points="12,2 22,12 12,22 2,12"/>',
  hexagon: '<polygon points="21,12 16.5,19.8 7.5,19.8 3,12 7.5,4.2 16.5,4.2"/>',
  pentagon: '<polygon points="12,3 20.6,9.2 17.3,19.3 6.7,19.3 3.4,9.2"/>',
  star: '<polygon points="12,2 14.5,8.6 21.5,8.9 16,13.3 17.9,20.1 12,16.2 6.1,20.1 8,13.3 2.5,8.9 9.5,8.6"/>',
  cross: '<polygon points="9,3 15,3 15,9 21,9 21,15 15,15 15,21 9,21 9,15 3,15 3,9 9,9"/>'
};
const CHART_MARKER_SHAPE_KEYS = Object.keys(CHART_MARKER_SHAPES);
const CHART_MARKER_BG = '#111827';

function getPlayerChartStyle(idx) {
  const colors = CHART_PALETTE.length;
  const shapes = CHART_MARKER_SHAPE_KEYS.length;
  return {
    color: CHART_PALETTE[idx % colors],
    shape: CHART_MARKER_SHAPE_KEYS[idx % shapes],
    filled: Math.floor(idx / (colors * shapes)) % 2 === 0,
    dash: Math.floor(idx / (colors * shapes * 2)) % 2 === 1 ? [7, 4] : []
  };
}

function buildChartMarkerSvg(style) {
  const body = CHART_MARKER_SHAPES[style.shape];
  const paint = style.filled
    ? `fill="${style.color}" stroke="${CHART_MARKER_BG}" stroke-width="1.5"`
    : `fill="${CHART_MARKER_BG}" stroke="${style.color}" stroke-width="2.5"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g ${paint}>${body}</g></svg>`;
}

function getChartMarkerDataUri(style) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(buildChartMarkerSvg(style));
}

const chartMarkerImageCache = new Map();
function getChartMarkerImage(style) {
  const key = `${style.shape}|${style.color}|${style.filled}`;
  let img = chartMarkerImageCache.get(key);
  if (!img) {
    img = new Image(14, 14);
    // Chart.js desenha o marcador só após carregar; redesenha quando estiver pronto
    img.onload = () => { if (evolutionChartInstance) evolutionChartInstance.update('none'); };
    img.src = getChartMarkerDataUri(style);
    chartMarkerImageCache.set(key, img);
  }
  return img;
}

// O Chart.js não usa imagens como pointStyle nos pontos de linha (só na legenda),
// então o marcador de cada ponto é desenhado por este plugin.
const playerMarkerPlugin = {
  id: 'playerMarkers',
  afterDatasetsDraw(chart) {
    const ctx = chart.ctx;
    chart.data.datasets.forEach((ds, dsIdx) => {
      const img = ds.markerImage;
      const meta = chart.getDatasetMeta(dsIdx);
      if (!img || meta.hidden) return;
      meta.data.forEach(pt => {
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
        ctx.drawImage(img, pt.x - img.width / 2, pt.y - img.height / 2, img.width, img.height);
      });
    });
  }
};

function setDashboardChartMetric(metric) {
  if (currentEvolutionMetric === metric) return;
  currentEvolutionMetric = metric;

  // Atualizar botões visuais
  const btnGoals = document.getElementById("chart-metric-goals");
  const btnWins = document.getElementById("chart-metric-wins");
  const btnConsistency = document.getElementById("chart-metric-consistency");
  const btnAvgGoals = document.getElementById("chart-metric-avg-goals");

  const activeClasses = ["bg-cardLight", "text-white", "shadow-sm"];
  const inactiveClasses = ["text-slate-400"];

  [btnGoals, btnWins, btnConsistency, btnAvgGoals].forEach(btn => {
    if (!btn) return;
    btn.classList.remove(...activeClasses);
    btn.classList.add(...inactiveClasses);
  });

  const activeBtn = metric === 'goals'
    ? btnGoals
    : (metric === 'wins' ? btnWins : (metric === 'avg_goals' ? btnAvgGoals : btnConsistency));
  if (activeBtn) {
    activeBtn.classList.remove(...inactiveClasses);
    activeBtn.classList.add(...activeClasses);
  }

  updateDashboardEvolutionChart();
}

function togglePlayerFilterDropdown(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("chart-player-filter-menu");
  if (menu) {
    menu.classList.toggle("hidden");
  }
}

// Fechar dropdown de filtros ao clicar fora
document.addEventListener("click", (e) => {
  const menu = document.getElementById("chart-player-filter-menu");
  const btn = document.getElementById("btn-chart-player-filter");
  if (menu && !menu.classList.contains("hidden")) {
    if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
      menu.classList.add("hidden");
    }
  }
});

function filterChartPlayerSearch(query) {
  const q = (query || "").toLowerCase().trim();
  const items = document.querySelectorAll(".chart-player-item");
  items.forEach(el => {
    const name = el.getAttribute("data-player-name") || "";
    if (!q || name.includes(q)) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });
}

function selectAllChartPlayers(selectAll) {
  if (selectAll) {
    chartAvailablePlayers.forEach(p => selectedChartPlayerIds.add(String(p.id)));
  } else {
    selectedChartPlayerIds.clear();
  }
  syncChartPlayerCheckboxes();
  updateDashboardEvolutionChart();
  if (window.lucide) refreshIcons();
}

function onToggleChartPlayerCheckbox(playerId, checked) {
  const pid = String(playerId);
  if (checked) {
    selectedChartPlayerIds.add(pid);
  } else {
    selectedChartPlayerIds.delete(pid);
  }
  updateChartPlayerFilterLabel();
  updateDashboardEvolutionChart();
}

function updateChartPlayerFilterLabel() {
  const labelEl = document.getElementById("label-chart-player-filter");
  if (!labelEl) return;
  const total = chartAvailablePlayers.length;
  const selectedCount = selectedChartPlayerIds.size;

  if (selectedCount === 0) {
    labelEl.textContent = "Nenhum Selecionado";
  } else if (selectedCount === total) {
    labelEl.textContent = "Todos os Jogadores";
  } else if (selectedCount === 1) {
    const singleId = Array.from(selectedChartPlayerIds)[0];
    const found = chartAvailablePlayers.find(p => String(p.id) === singleId);
    labelEl.textContent = found ? found.name : "1 Jogador";
  } else {
    labelEl.textContent = `${selectedCount} Selecionados`;
  }
}

function syncChartPlayerCheckboxes() {
  const container = document.getElementById("chart-player-checkboxes");
  if (!container) return;

  container.innerHTML = chartAvailablePlayers.map((p, idx) => {
    const pid = String(p.id);
    const isChecked = selectedChartPlayerIds.has(pid);
    const markerSrc = getChartMarkerDataUri(getPlayerChartStyle(idx));
    return `
      <label class="chart-player-item flex items-center justify-between p-1.5 rounded-lg hover:bg-cardLight/60 cursor-pointer text-xs" data-player-name="${escapeHtml(p.name.toLowerCase())}">
        <span class="flex items-center gap-2 truncate pr-2">
          <img src="${markerSrc}" width="12" height="12" alt="" class="flex-shrink-0">
          <span class="text-slate-200 truncate font-medium">${escapeHtml(p.name)}</span>
        </span>
        <input type="checkbox" ${isChecked ? 'checked' : ''} data-h-change="onToggleChartPlayerCheckbox" data-a="${escapeHtml(JSON.stringify([pid, "@checked"]))}" class="rounded border-borderLight text-neon-accent focus:ring-0 cursor-pointer accent-[#00f59b]">
      </label>
    `;
  }).join("");

  updateChartPlayerFilterLabel();
}

function parseMatchPlayedAt(playedAtStr) {
  if (!playedAtStr) return 0;
  // Formato retornado pelo backend: "DD/MM/YYYY HH:MM:SS"
  const parts = playedAtStr.split(" ");
  if (parts.length === 2) {
    const dmy = parts[0].split("/");
    const hms = parts[1].split(":");
    if (dmy.length === 3 && hms.length >= 2) {
      return new Date(
        parseInt(dmy[2], 10),
        parseInt(dmy[1], 10) - 1,
        parseInt(dmy[0], 10),
        parseInt(hms[0], 10),
        parseInt(hms[1], 10),
        parseInt(hms[2] || 0, 10)
      ).getTime();
    }
  }
  const parsed = Date.parse(playedAtStr);
  return isNaN(parsed) ? 0 : parsed;
}

function renderDashboardEvolutionChart(matches) {
  cachedEvolutionMatches = Array.isArray(matches) ? matches : [];

  // 1. Extrair todos os jogadores únicos participantes das partidas
  const playersMap = new Map();
  cachedEvolutionMatches.forEach(m => {
    (m.home_players || []).forEach(p => {
      if (p && p.id != null) playersMap.set(String(p.id), p.name || `Jogador ${p.id}`);
    });
    (m.away_players || []).forEach(p => {
      if (p && p.id != null) playersMap.set(String(p.id), p.name || `Jogador ${p.id}`);
    });
    (m.events || []).forEach(ev => {
      if (ev && ev.player_id != null) {
        playersMap.set(String(ev.player_id), ev.player_name || `Jogador ${ev.player_id}`);
      }
    });
  });

  chartAvailablePlayers = Array.from(playersMap.entries()).map(([id, name]) => ({ id, name }));
  chartAvailablePlayers.sort((a, b) => a.name.localeCompare(b.name));

  // Inicializar seleção: se estiver vazio ou se for a primeira vez, seleciona todos
  if (selectedChartPlayerIds.size === 0 && chartAvailablePlayers.length > 0) {
    chartAvailablePlayers.forEach(p => selectedChartPlayerIds.add(String(p.id)));
  } else {
    // Remover da seleção ids que não existem mais
    const validIds = new Set(chartAvailablePlayers.map(p => String(p.id)));
    selectedChartPlayerIds.forEach(id => {
      if (!validIds.has(id)) selectedChartPlayerIds.delete(id);
    });
  }

  syncChartPlayerCheckboxes();
  updateDashboardEvolutionChart();
  if (window.lucide) refreshIcons();
}

/* Série de evolução por jogador (usada pelo dashboard e pelo relatório PDF).
   Retorna os rótulos do eixo X e os datasets com os valores acumulados da métrica. */
function calcularSerieEvolucao(matches, jogadores, idsSelecionados, metrica) {
  // Filtrar apenas partidas finalizadas e ordenar cronologicamente (mais antiga para mais recente)
  const finished = matches
    .filter(m => m.finished !== false)
    .slice()
    .sort((a, b) => {
      const ta = parseMatchPlayedAt(a.played_at);
      const tb = parseMatchPlayedAt(b.played_at);
      if (ta !== tb) return ta - tb;
      return (a.round_number || 0) - (b.round_number || 0);
    });


  // Rótulos do eixo X em ordem cronológica
  const labels = finished.map((m, idx) => `Jogo ${idx + 1}`);

  // Para cada partida, pré-calcular os jogadores que atuaram em cada time
  // e os gols marcados por evento
  const matchDetails = finished.map((m, idx) => {
    const homePids = new Set((m.home_players || []).map(p => String(p.id)));
    const awayPids = new Set((m.away_players || []).map(p => String(p.id)));
    
    // Contagem de gols nesta partida específica
    const goalsThisMatch = {};
    (m.events || []).forEach(ev => {
      if (ev.event_type === "goal" && ev.player_id != null) {
        const pid = String(ev.player_id);
        goalsThisMatch[pid] = (goalsThisMatch[pid] || 0) + 1;
      }
    });

    return {
      index: idx + 1,
      match: m,
      homePids,
      awayPids,
      goalsThisMatch,
      playedAt: m.played_at || 'Data não gravada',
      scoreText: `${m.home_team_name} ${m.home_score} x ${m.away_score} ${m.away_team_name}`,
      isDraw: !!m.is_draw,
      winnerTeamId: m.winner_team_id,
      homeTeamId: m.home_team_id,
      awayTeamId: m.away_team_id
    };
  });

  // Construir dados acumulados para cada jogador selecionado
  const datasets = [];
  jogadores.forEach((player, pIdx) => {
    const pid = String(player.id);
    if (!idsSelecionados.has(pid)) return;

    const style = getPlayerChartStyle(pIdx);
    let cumulativeGoals = 0;
    let cumulativeWins = 0;
    let cumulativePlayedMatches = 0;

    const dataPoints = [];
    const pointMetadata = [];

    matchDetails.forEach(md => {
      const inHome = md.homePids.has(pid);
      const inAway = md.awayPids.has(pid);
      const playedInMatch = inHome || inAway;

      const scoredInMatch = md.goalsThisMatch[pid] || 0;
      cumulativeGoals += scoredInMatch;

      let wonInMatch = false;
      if (playedInMatch && !md.isDraw) {
        if (inHome && md.winnerTeamId === md.homeTeamId) wonInMatch = true;
        if (inAway && md.winnerTeamId === md.awayTeamId) wonInMatch = true;
      }

      if (playedInMatch) {
        cumulativePlayedMatches += 1;
        if (wonInMatch) cumulativeWins += 1;
      }

      const winRate = cumulativePlayedMatches > 0
        ? Math.round((cumulativeWins / cumulativePlayedMatches) * 1000) / 10
        : 0;

      const avgGoals = cumulativePlayedMatches > 0
        ? Math.round((cumulativeGoals / cumulativePlayedMatches) * 100) / 100
        : 0;

      let currentVal = 0;
      if (metrica === 'goals') {
        currentVal = cumulativeGoals;
      } else if (metrica === 'wins') {
        currentVal = cumulativeWins;
      } else if (metrica === 'avg_goals') {
        currentVal = avgGoals;
      } else {
        currentVal = winRate;
      }

      dataPoints.push(currentVal);
      pointMetadata.push({
        playerName: player.name,
        matchIndex: md.index,
        playedAt: md.playedAt,
        scoreText: md.scoreText,
        playedInMatch,
        wonInMatch,
        scoredInMatch,
        cumulativeGoals,
        cumulativeWins,
        cumulativePlayedMatches,
        winRate,
        avgGoals
      });
    });

    let metricLabel = "Gols Acumulados";
    if (metrica === 'wins') metricLabel = "Vitórias Acumuladas";
    if (metrica === 'consistency') metricLabel = "Aproveitamento de Vitórias (%)";
    if (metrica === 'avg_goals') metricLabel = "Média de Gols / Partida";

    datasets.push({
      label: player.name,
      data: dataPoints,
      borderColor: style.color,
      backgroundColor: style.color + '22',
      borderWidth: 2.5,
      borderDash: style.dash,
      tension: 0.25,
      fill: false,
      markerImage: getChartMarkerImage(style),
      pointStyle: getChartMarkerImage(style), // usado pela legenda
      pointRadius: 0,
      hitRadius: 10,
      metaDetails: pointMetadata
    });
  });

  return { labels, datasets };
}

function updateDashboardEvolutionChart() {
  const canvas = document.getElementById("dashboard-evolution-chart");
  const emptyEl = document.getElementById("dashboard-chart-empty");
  if (!canvas) return;

  const { labels, datasets } = calcularSerieEvolucao(cachedEvolutionMatches, chartAvailablePlayers, selectedChartPlayerIds, currentEvolutionMetric);

  if (labels.length === 0 || selectedChartPlayerIds.size === 0 || chartAvailablePlayers.length === 0) {
    if (emptyEl) emptyEl.classList.remove("hidden");
    if (evolutionChartInstance) {
      evolutionChartInstance.destroy();
      evolutionChartInstance = null;
    }
    return;
  }

  if (emptyEl) emptyEl.classList.add("hidden");

  if (evolutionChartInstance) {
    evolutionChartInstance.destroy();
  }

  const ctx = canvas.getContext("2d");
  let yAxisTitle = "Gols";
  if (currentEvolutionMetric === 'wins') yAxisTitle = "Vitórias";
  if (currentEvolutionMetric === 'consistency') yAxisTitle = "Aproveitamento (%)";
  if (currentEvolutionMetric === 'avg_goals') yAxisTitle = "Média de Gols";

  evolutionChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: datasets
    },
    plugins: [playerMarkerPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#94a3b8',
            font: { family: 'Outfit', size: 11, weight: '600' },
            boxWidth: 12,
            boxHeight: 12,
            padding: 12,
            usePointStyle: true
          }
        },
        tooltip: {
          enabled: true,
          position: 'followMouse',
          backgroundColor: '#162032',
          titleColor: '#00f59b',
          titleFont: { family: 'Outfit', size: 14, weight: '700' },
          bodyColor: '#e2e8f0',
          bodyFont: { family: 'Outfit', size: 13, weight: '500' },
          borderColor: '#26354a',
          borderWidth: 1,
          padding: 14,
          boxPadding: 6,
          cornerRadius: 12,
          displayColors: true,
          usePointStyle: true,
          callbacks: {
            labelPointStyle: function(context) {
              return { pointStyle: datasets[context.datasetIndex].pointStyle, rotation: 0 };
            },
            title: function(items) {
              if (!items.length) return '';
              const firstItem = items[0];
              const ds = datasets[firstItem.datasetIndex];
              const meta = ds.metaDetails[firstItem.dataIndex];
              return `Partida ${meta.matchIndex} • ${meta.playedAt}`;
            },
            beforeBody: function(items) {
              if (!items.length) return '';
              const firstItem = items[0];
              const ds = datasets[firstItem.datasetIndex];
              const meta = ds.metaDetails[firstItem.dataIndex];
              return `Placar: ${meta.scoreText}`;
            },
            label: function(context) {
              const ds = datasets[context.datasetIndex];
              const meta = ds.metaDetails[context.dataIndex];
              const pName = meta.playerName;

              if (currentEvolutionMetric === 'goals') {
                const termoGol = meta.cumulativeGoals < 2 ? 'gol' : 'gols';
                return `${pName}: ${meta.cumulativeGoals} ${termoGol}`;
              } else if (currentEvolutionMetric === 'wins') {
                const termoVitoria = meta.cumulativeWins < 2 ? 'vitória' : 'vitórias';
                return `${pName}: ${meta.cumulativeWins} ${termoVitoria}`;
              } else if (currentEvolutionMetric === 'avg_goals') {
                const termoGolMedia = meta.avgGoals < 2 ? 'gol por jogo' : 'gols por jogo';
                return `${pName}: ${meta.avgGoals.toFixed(2)} ${termoGolMedia}`;
              } else {
                return `${pName}: ${meta.winRate}% de aproveitamento`;
              }
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: '#1e293b',
            drawBorder: false
          },
          ticks: {
            color: '#64748b',
            font: { family: 'Outfit', size: 11 }
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: '#1e293b',
            drawBorder: false
          },
          ticks: {
            color: '#64748b',
            font: { family: 'Outfit', size: 11 },
            stepSize: currentEvolutionMetric === 'consistency' ? 20 : (currentEvolutionMetric === 'avg_goals' ? 0.5 : 1),
            callback: function(val) {
              if (currentEvolutionMetric === 'consistency') return `${val}%`;
              if (currentEvolutionMetric === 'avg_goals') return Number(val).toFixed(1);
              return val;
            }
          },
          title: {
            display: true,
            text: yAxisTitle,
            color: '#94a3b8',
            font: { family: 'Outfit', size: 11, weight: '600' }
          },
          max: currentEvolutionMetric === 'consistency' ? 100 : undefined
        }
      }
    }
  });
  window.evolutionChartInstance = evolutionChartInstance;
}

let allHistoryMatches = [];
let currentHistoryPage = 1;
const HISTORY_PAGE_SIZE = 6;
let isHistorySliding = false;

function buildHistoryPageHtml(matchesSlice) {
  if (!matchesSlice || matchesSlice.length === 0) {
    return `<p class="text-sm text-slate-500 text-center py-6">Nenhuma partida finalizada no histórico.</p>`;
  }

  return matchesSlice.map(m => {
    const homeColor = getTeamColor(m.home_team_id || m.home_team_name);
    const awayColor = getTeamColor(m.away_team_id || m.away_team_name);

    return `
      <div class="p-4 bg-card hover:bg-cardLight border border-borderLight rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3 transition">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-slate-400">Rodada ${m.round_number}</span>
            <span class="text-slate-600">•</span>
            <span class="text-xs text-emerald-400 font-medium">🕒 ${m.played_at || 'Data não gravada'} (Brasília)</span>
          </div>

          <div class="text-base font-extrabold flex items-center gap-3">
            <span class="ds-c8c42c63-${homeColor.slice(1)} flex items-center gap-1.5">
              ${m.winner_team_id === m.home_team_id ? '<span class="text-xs" title="Vencedor">🏆</span>' : ''}
              ${escapeHtml(m.home_team_name)}
            </span>
            <span class="px-2.5 py-0.5 rounded-lg bg-pitch border border-borderLight text-white font-black text-sm">${m.home_score} - ${m.away_score}</span>
            <span class="ds-c8c42c63-${awayColor.slice(1)} flex items-center gap-1.5">
              ${m.winner_team_id === m.away_team_id ? '<span class="text-xs" title="Vencedor">🏆</span>' : ''}
              ${escapeHtml(m.away_team_name)}
            </span>
          </div>
        </div>

        <button data-h-click="verDetalhesPartida" data-a="${escapeHtml(JSON.stringify([m.id]))}" class="text-xs px-3 py-2 bg-surface hover:bg-card border border-borderLight rounded-xl text-slate-300 hover:text-white transition flex items-center justify-center gap-1.5 self-start md:self-auto">
          <i data-lucide="eye" class="w-3.5 h-3.5 text-neon-accent"></i>
          <span>Ver Integrantes & Detalhes</span>
        </button>
      </div>
    `;
  }).join("");
}

function updateHistoryPaginationUI() {
  const paginationEl = document.getElementById("history-pagination");
  if (!paginationEl) return;

  const totalPages = Math.ceil(allHistoryMatches.length / HISTORY_PAGE_SIZE);

  if (allHistoryMatches.length > HISTORY_PAGE_SIZE) {
    paginationEl.classList.remove("hidden");
    const startIdx = (currentHistoryPage - 1) * HISTORY_PAGE_SIZE;
    const endIdx = Math.min(startIdx + HISTORY_PAGE_SIZE, allHistoryMatches.length);

    const rangeEl = document.getElementById("history-page-range");
    const totalCountEl = document.getElementById("history-total-count");
    const pageIndicatorEl = document.getElementById("history-page-indicator");
    const prevBtn = document.getElementById("history-prev-btn");
    const nextBtn = document.getElementById("history-next-btn");

    if (rangeEl) rangeEl.textContent = `${startIdx + 1}-${endIdx}`;
    if (totalCountEl) totalCountEl.textContent = allHistoryMatches.length;
    if (pageIndicatorEl) pageIndicatorEl.textContent = `${currentHistoryPage} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = currentHistoryPage <= 1 || isHistorySliding;
    if (nextBtn) nextBtn.disabled = currentHistoryPage >= totalPages || isHistorySliding;
  } else {
    paginationEl.classList.add("hidden");
  }
}

function updateHistoryActionButtonsState(totalMatches) {
  const count = typeof totalMatches === "number" ? totalMatches : allHistoryMatches.length;
  const hasMatches = count > 0;

  const btnPdf = document.getElementById("btn-export-pdf");
  if (btnPdf) {
    btnPdf.disabled = !hasMatches;
    btnPdf.title = hasMatches
      ? "Gerar relatório em PDF de folha única"
      : "Nenhuma partida finalizada para gerar relatório";
  }

  const btnClear = document.getElementById("btn-clear-history");
  if (btnClear) {
    const isLeader = state.role === 'admin';
    btnClear.disabled = !hasMatches || !isLeader;
    btnClear.title = !hasMatches
      ? "Nenhuma partida finalizada no histórico"
      : (!isLeader ? "Apenas o administrador pode limpar o histórico" : "Limpar histórico");
  }
}

function updatePdfExportButtonState(totalMatches) {
  updateHistoryActionButtonsState(totalMatches);
}

function renderMatchesHistory(matches) {
  const container = document.getElementById("history-matches-list");
  const slider = document.getElementById("history-slider");
  if (!container) return;

  allHistoryMatches = Array.isArray(matches) ? matches : [];
  updateHistoryActionButtonsState(allHistoryMatches.length);

  if (allHistoryMatches.length === 0) {
    container.innerHTML = `<p class="text-sm text-slate-500 text-center py-6">Nenhuma partida finalizada no histórico.</p>`;
    const paginationEl = document.getElementById("history-pagination");
    if (paginationEl) paginationEl.classList.add("hidden");
    return;
  }

  const totalPages = Math.ceil(allHistoryMatches.length / HISTORY_PAGE_SIZE);
  if (currentHistoryPage > totalPages) {
    currentHistoryPage = totalPages;
  }
  if (currentHistoryPage < 1) {
    currentHistoryPage = 1;
  }

  const startIdx = (currentHistoryPage - 1) * HISTORY_PAGE_SIZE;
  const endIdx = Math.min(startIdx + HISTORY_PAGE_SIZE, allHistoryMatches.length);
  const pageMatches = allHistoryMatches.slice(startIdx, endIdx);

  if (slider) {
    slider.style.transition = 'none';
    slider.style.transform = 'translateX(0%)';
    slider.innerHTML = `<div id="history-matches-list" class="w-full shrink-0 space-y-3">${buildHistoryPageHtml(pageMatches)}</div>`;
  } else {
    container.innerHTML = buildHistoryPageHtml(pageMatches);
  }

  updateHistoryPaginationUI();
  refreshIcons();
}

function mudarPaginaHistorico(delta) {
  if (isHistorySliding) return;

  const totalPages = Math.ceil(allHistoryMatches.length / HISTORY_PAGE_SIZE);
  const targetPage = currentHistoryPage + delta;
  if (targetPage < 1 || targetPage > totalPages) return;

  const slider = document.getElementById("history-slider");
  if (!slider) {
    currentHistoryPage = targetPage;
    renderMatchesHistory(allHistoryMatches);
    return;
  }

  isHistorySliding = true;

  // Desabilita botões temporariamente
  const prevBtn = document.getElementById("history-prev-btn");
  const nextBtn = document.getElementById("history-next-btn");
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  // Fatia da página alvo
  const targetStart = (targetPage - 1) * HISTORY_PAGE_SIZE;
  const targetEnd = Math.min(targetStart + HISTORY_PAGE_SIZE, allHistoryMatches.length);
  const targetMatches = allHistoryMatches.slice(targetStart, targetEnd);

  const currentPaneHtml = slider.firstElementChild ? slider.firstElementChild.outerHTML : '';
  const incomingPaneHtml = `<div class="w-full shrink-0 space-y-3">${buildHistoryPageHtml(targetMatches)}</div>`;

  // delta > 0: avança para a direita (empurra atual para a esquerda)
  // delta < 0: retrocede para a esquerda (empurra atual para a direita)
  if (delta > 0) {
    slider.style.transition = 'none';
    slider.style.transform = 'translateX(0px)';
    slider.innerHTML = currentPaneHtml + incomingPaneHtml;
    void slider.offsetWidth; // Força reflow

    // Desloca 100% da largura + espaçamento gap (1.5rem = 24px)
    slider.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
    slider.style.transform = 'translateX(calc(-100% - 1.5rem))';
  } else {
    slider.style.transition = 'none';
    slider.style.transform = 'translateX(calc(-100% - 1.5rem))';
    slider.innerHTML = incomingPaneHtml + currentPaneHtml;
    void slider.offsetWidth; // Força reflow

    slider.style.transition = 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)';
    slider.style.transform = 'translateX(0px)';
  }

  currentHistoryPage = targetPage;
  updateHistoryPaginationUI();

  setTimeout(() => {
    slider.style.transition = 'none';
    slider.style.transform = 'translateX(0%)';
    slider.innerHTML = `<div id="history-matches-list" class="w-full shrink-0 space-y-3">${buildHistoryPageHtml(targetMatches)}</div>`;
    refreshIcons();
    isHistorySliding = false;
    updateHistoryPaginationUI();
  }, 460);
}

// Lado vencedor de uma partida: 'home', 'away' ou null (empate, sem resultado ou não finalizada).
// Fonte única: winner_team_id, definido pelo servidor ao salvar o resultado.
function ladoVencedor(match) {
  if (match.is_draw || !match.finished || !match.winner_team_id) return null;
  if (match.winner_team_id === match.home_team_id) return 'home';
  if (match.winner_team_id === match.away_team_id) return 'away';
  return null;
}

async function verDetalhesPartida(matchId) {
  // Procura no estado local ou busca do backend
  let match = state.fixtures.find(m => m.id === matchId);

  if (!match && state.currentPelada && state.currentPelada.code) {
    try {
      const pCode = state.currentPelada.code;
      const url = `/api/matches?pelada_code=${pCode}`;
      const res = await fetch(url);
      const list = await res.json();
      match = list.find(m => m.id === matchId);
    } catch (e) {
      console.error(e);
    }
  }

  if (!match) {
    await showCustomAlert("Partida não encontrada no registro.", "Não Encontrado");
    return;
  }

  abrirModalDetalhesPartida(null, {
    titulo: 'Detalhes da Partida',
    mensagem: `Rodada ${match.round_number}<br>${escapeHtml(match.played_at || '')}`,
    mensagemHtml: true,
    largura: '2xl',
    icone: 'info',
    botoes: { ok: 'Fechar' }
  });
  const content = document.getElementById("modal-content");
  if (!content) return;

  const lado = ladoVencedor(match);
  const isDraw = !!match.is_draw;
  const isHomeWinner = lado === 'home';
  const isAwayWinner = lado === 'away';
  const isHomeLoser = lado === 'away';
  const isAwayLoser = lado === 'home';
  const homeColor = getTeamColor(match.home_team_id || match.home_team_name);
  const awayColor = getTeamColor(match.away_team_id || match.away_team_name);

  // Mapeia contagem de gols por jogador
  const playerGoalsCount = {};
  if (match.events && Array.isArray(match.events)) {
    match.events.forEach(ev => {
      if (ev.event_type === "goal" || !ev.event_type) {
        if (ev.player_id) {
          playerGoalsCount[ev.player_id] = (playerGoalsCount[ev.player_id] || 0) + 1;
        }
        if (ev.player_name) {
          playerGoalsCount[ev.player_name.toLowerCase().trim()] = (playerGoalsCount[ev.player_name.toLowerCase().trim()] || 0) + 1;
        }
      }
    });
  }

  // lado 'mandante' (esquerda): nome alinhado à direita e bolas na borda esquerda
  // lado 'visitante' (direita): nome alinhado à esquerda e bolas na borda direita
  const renderPlayerItem = (p, lado) => {
    const pName = typeof p === 'string' ? p : p.name;
    const pId = typeof p === 'object' && p.id ? p.id : null;
    const countById = pId && playerGoalsCount[pId] !== undefined ? playerGoalsCount[pId] : 0;
    const countByName = pName && playerGoalsCount[pName.toLowerCase().trim()] !== undefined ? playerGoalsCount[pName.toLowerCase().trim()] : 0;
    const count = Math.max(countById, countByName);
    const balls = count > 0 ? `<span class="inline-flex items-center gap-0.5 text-base select-none">${'⚽'.repeat(count)}</span>` : '';
    const mandante = lado === 'mandante';
    const nome = `<span class="font-medium text-slate-200 text-sm md:text-base ${mandante ? 'text-right' : 'text-left'}">${escapeHtml(pName)}</span>`;
    // o slot das bolas fica sempre no DOM para que o justify-between mantenha o alinhamento
    const slotBolas = `<span class="shrink-0">${balls}</span>`;

    return `
      <li class="flex items-center justify-between gap-2 py-1 px-1.5 rounded-lg hover:bg-surface/50 transition">
        ${mandante ? `${slotBolas}${nome}` : `${nome}${slotBolas}`}
      </li>
    `;
  };

  content.innerHTML = `
    <!-- Placar centralizado entre as duas colunas de elenco (colunas laterais de mesma largura) -->
    <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 md:gap-4">
      <div class="flex items-center justify-end gap-2 min-w-0 text-right">
        ${isHomeWinner ? '<span class="text-2xl md:text-3xl leading-none" title="Vencedor">🏆</span>' : ''}
        <span class="ds-c8c42c63-${homeColor.slice(1)} text-3xl md:text-4xl font-black break-words">${escapeHtml(match.home_team_name)}</span>
      </div>
      <span class="text-white bg-pitch px-4 py-1.5 rounded-xl border border-borderLight text-2xl md:text-3xl font-black">${match.home_score} x ${match.away_score}</span>
      <div class="flex items-center justify-start gap-2 min-w-0 text-left">
        <span class="ds-c8c42c63-${awayColor.slice(1)} text-3xl md:text-4xl font-black break-words">${escapeHtml(match.away_team_name)}</span>
        ${isAwayWinner ? '<span class="text-2xl md:text-3xl leading-none" title="Vencedor">🏆</span>' : ''}
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm pt-2">
      <!-- Elenco Mandante -->
      <div class="space-y-2 bg-card p-4 rounded-2xl border ${
        isHomeWinner
          ? 'border-emerald-500/40 bg-emerald-950/20'
          : isHomeLoser
          ? 'border-rose-500/40 bg-rose-950/20'
          : isDraw
          ? 'border-yellow-400/50 bg-yellow-400/5'
          : 'border-borderLight'
      }">
        <h4 class="font-bold text-base md:text-lg flex items-center justify-end pb-1 border-b border-borderLight/40">
          ${isHomeWinner ? '<span class="text-xs text-emerald-400 font-extrabold uppercase bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">Venceu</span>' : ''}
          ${isHomeLoser ? '<span class="text-xs text-rose-400 font-extrabold uppercase bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">Perdeu</span>' : ''}
          ${isDraw ? '<span class="text-xs text-amber-400 font-extrabold uppercase bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">Empate</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-200">
          ${(match.home_players || []).map((p) => renderPlayerItem(p, 'mandante')).join("")}
        </ul>
      </div>

      <!-- Elenco Visitante -->
      <div class="space-y-2 bg-card p-4 rounded-2xl border ${
        isAwayWinner
          ? 'border-emerald-500/40 bg-emerald-950/20'
          : isAwayLoser
          ? 'border-rose-500/40 bg-rose-950/20'
          : isDraw
          ? 'border-yellow-400/50 bg-yellow-400/5'
          : 'border-borderLight'
      }">
        <h4 class="font-bold text-base md:text-lg flex items-center justify-start pb-1 border-b border-borderLight/40">
          ${isAwayWinner ? '<span class="text-xs text-emerald-400 font-extrabold uppercase bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">Venceu</span>' : ''}
          ${isAwayLoser ? '<span class="text-xs text-rose-400 font-extrabold uppercase bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">Perdeu</span>' : ''}
          ${isDraw ? '<span class="text-xs text-amber-400 font-extrabold uppercase bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">Empate</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-200">
          ${(match.away_players || []).map((p) => renderPlayerItem(p, 'visitante')).join("")}
        </ul>
      </div>
    </div>

  `;

  refreshIcons();
}

function abrirModalDetalhesPartida(aoRenderizar, extras = {}) {
  return abrirModal({ template: 'tpl-match-details', largura: 'xl', aoRenderizar, ...extras });
}

function closeModal() {
  fecharModalDoTemplate('tpl-match-details');
}

async function limparHistorico() {
  if (allHistoryMatches.length === 0) {
    await showCustomAlert("Não há nenhuma partida gravada para limpar.", "Aviso");
    return;
  }
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const confirmed = await showCustomConfirm(
    "Atenção: deseja realmente limpar todo o histórico salvo desta pelada?",
    "Limpar Histórico",
    "Limpar Histórico",
    "Cancelar",
    false,
    { icone: 'triangle-alert' }
  );
  if (!confirmed) return;

  try {
    if (!state.currentPelada || !state.currentPelada.code) return;
    const pCode = state.currentPelada.code;
    const url = `/api/matches?pelada_code=${pCode}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: getAuthHeaders()
    });
    if (res.ok) {
      showToast("Histórico zerado com sucesso!");
      await atualizarDashboard();
    }
  } catch (err) {
    console.error(err);
  }
}

// ==============================
// CONFIGURAÇÕES
// ==============================
async function carregarConfiguracoes() {
  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const url = pCode ? `/api/config?pelada_code=${pCode}` : "/api/config";
    const res = await fetch(url);
    const cfg = await res.json();
    state.config = cfg;

    const elPerTeam = document.getElementById("cfg-players-per-team");
    const elDuration = document.getElementById("cfg-duration");
    const elRounds = document.getElementById("cfg-rounds");

    if (elPerTeam) elPerTeam.value = cfg.players_per_team;
    if (elDuration) elDuration.value = cfg.match_duration_minutes;
    if (elRounds) {
      if (cfg.championship_type) {
        elRounds.value = cfg.championship_type;
      } else {
        elRounds.value = cfg.total_rounds === 2 ? "double" : "single";
      }
    }
    const elDraw = document.getElementById("cfg-king-draw-rule");
    const elMaxWins = document.getElementById("cfg-king-max-wins");
    if (elDraw) elDraw.value = cfg.king_draw_rule || "both";
    if (elMaxWins) elMaxWins.value = cfg.king_max_consecutive_wins || 0;
    const elStars = document.getElementById("cfg-stars-pct");
    if (elStars) {
      elStars.value = Number.isInteger(cfg.balance_stars_pct) ? cfg.balance_stars_pct : BALANCE_STARS_PCT_PADRAO;
      atualizarRotuloEstrelas(elStars);
    }
    atualizarVisibilidadeControlesFormato();
  } catch (e) {
    console.warn("Usando configurações padrão.");
  } finally {
    carregarSomAlarme();
  }
}

const FORMATO_INFO = {
  single: { titulo: "Regras do Turno Único", dica: "Todos os times se enfrentam uma vez.", inicio: true, rei: false },
  double: { titulo: "Regras do Turno e Retorno", dica: "Todos se enfrentam duas vezes, ida e volta.", inicio: true, rei: false },
  king: { titulo: "Regras do Rei da Pelada", dica: "O vencedor fica em campo e o próximo da fila entra. As partidas são geradas uma a uma.", inicio: true, rei: true },
  custom: { titulo: "Regras do Formato Livre", dica: "Você monta os confrontos com os times e rodadas que quiser.", inicio: false, rei: false }
};

// Mostra apenas as regras do formato escolhido e preenche os times de abertura
function atualizarRegrasFormato() {
  const tipo = state.config.championship_type || "single";
  const info = FORMATO_INFO[tipo] || FORMATO_INFO.single;
  const setVisible = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle("hidden", !on); };
  const title = document.getElementById("rules-format-title");
  const hint = document.getElementById("cfg-format-hint");
  if (title) title.textContent = info.titulo;
  if (hint) hint.textContent = info.dica;
  setVisible("rules-start", info.inicio);
  setVisible("rules-king", info.rei);
  setVisible("rules-none", !info.inicio && !info.rei);

  const home = document.getElementById("cfg-first-home");
  const away = document.getElementById("cfg-first-away");
  if (!home || !away) return;
  const teams = state.teams || [];
  const opcoes = (sel, valor) => `<option value="">${sel}</option>` + teams.map(t =>
    `<option value="${escapeHtml(t.id)}" ${t.id === valor ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("");
  const ids = new Set(teams.map(t => t.id));
  const h = ids.has(state.config.first_match_home_id) ? state.config.first_match_home_id : "";
  const a = ids.has(state.config.first_match_away_id) ? state.config.first_match_away_id : "";
  home.innerHTML = opcoes("Automático", h);
  away.innerHTML = opcoes("Automático", a);
  home.value = h;
  away.value = a;
}

function atualizarVisibilidadeControlesFormato() {
  atualizarRegrasFormato();
  const isLeader = state.role === "admin";
  const btnAdd = document.getElementById("btn-add-custom-match");
  if (btnAdd) btnAdd.classList.toggle("hidden", !isLeader);
}

let autoSaveConfigTimeout = null;

// Envio do formulário de configurações: nunca recarrega a página
function submitConfiguracoes(event) {
  event.preventDefault();
  autoSalvarConfiguracoes();
}

// Rótulo ao lado do controle de peso e balão de info de "Times Montados": mostram a divisão real
function atualizarRotuloEstrelas(el) {
  // Pelo despachante de eventos, o elemento chega como `this` (sem argumentos)
  el = el || this;
  if (!el) return;
  const pct = parseInt(el.value, 10) || 0;
  const label = document.getElementById("cfg-stars-label");
  if (label) label.textContent = `${pct}% estrelas · ${100 - pct}% histórico`;
  atualizarInfoBalanceamento(pct);
}

function atualizarInfoBalanceamento(pct) {
  const texto = `Balanceamento: ${pct}% estrelas base + ${100 - pct}% histórico (vitórias e gols).`;
  const btn = document.getElementById("info-balanceamento-btn");
  const balao = document.getElementById("info-balanceamento-texto");
  if (btn) btn.title = texto;
  if (balao) balao.textContent = texto;
}

function autoSalvarConfiguracoes(immediate = false) {
  if (state.role !== 'admin') return;

  if (autoSaveConfigTimeout) {
    clearTimeout(autoSaveConfigTimeout);
    autoSaveConfigTimeout = null;
  }

  if (immediate) {
    salvarConfiguracoes();
  } else {
    autoSaveConfigTimeout = setTimeout(() => {
      salvarConfiguracoes();
    }, 450);
  }
}

async function salvarConfiguracoes(event) {
  if (event && event.preventDefault) event.preventDefault();
  if (state.role !== 'admin') return;

  const perTeamInput = document.getElementById("cfg-players-per-team");
  const durationInput = document.getElementById("cfg-duration");
  const roundsInput = document.getElementById("cfg-rounds");

  if (!perTeamInput || !durationInput || !roundsInput) return;

  let perTeam = parseInt(perTeamInput.value, 10);
  let duration = parseInt(durationInput.value, 10);
  const selectedFormat = roundsInput.value;

  if (isNaN(perTeam) || perTeam < 2) perTeam = 5;
  if (perTeam > 11) perTeam = 11;

  if (isNaN(duration) || duration < 1) duration = 10;
  if (duration > 90) duration = 90;

  let rounds = 1;
  let champType = selectedFormat;
  if (selectedFormat === "double") {
    rounds = 2;
  } else if (selectedFormat === "custom" || selectedFormat === "king") {
    rounds = 0; // Indicador de formato sem tabela fixa (livre ou Rei da Pelada)
  } else {
    rounds = 1;
    champType = "single";
  }

  const regrasAnteriores = snapshotRegras(state.config);
  state.config.players_per_team = perTeam;
  state.config.match_duration_minutes = duration;
  state.config.total_rounds = rounds;
  state.config.championship_type = champType;

  const elHome = document.getElementById("cfg-first-home");
  const elAway = document.getElementById("cfg-first-away");
  let firstHome = elHome && elHome.value ? elHome.value : null;
  let firstAway = elAway && elAway.value ? elAway.value : null;
  if (firstHome && firstHome === firstAway) {
    // Mesmo time nos dois lados: mantém o que acabou de ser escolhido e zera o outro
    if (document.activeElement === elAway) firstHome = null; else firstAway = null;
    if (elHome) elHome.value = firstHome || "";
    if (elAway) elAway.value = firstAway || "";
  }
  state.config.first_match_home_id = firstHome;
  state.config.first_match_away_id = firstAway;
  const elDraw = document.getElementById("cfg-king-draw-rule");
  const elMaxWins = document.getElementById("cfg-king-max-wins");
  state.config.king_draw_rule = elDraw ? elDraw.value : "both";
  let maxWins = elMaxWins ? parseInt(elMaxWins.value, 10) : 0;
  if (isNaN(maxWins) || maxWins < 0) maxWins = 0;
  if (maxWins > 50) maxWins = 50;
  state.config.king_max_consecutive_wins = maxWins;
  const elStars = document.getElementById("cfg-stars-pct");
  let starsPct = elStars ? parseInt(elStars.value, 10) : 40;
  if (isNaN(starsPct) || starsPct < 0) starsPct = 40;
  if (starsPct > 100) starsPct = 100;
  state.config.balance_stars_pct = starsPct;
  atualizarBaseRegras(regrasAnteriores);

  try {
    if (!state.currentPelada || !state.currentPelada.code) {
      showToast("Entre em uma pelada para salvar as configurações.");
      return;
    }
    const url = `/api/config?pelada_code=${state.currentPelada.code}`;
    const res = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(state.config)
    });
    if (res.ok) {
      if (window.auditTracker) {
        window.auditTracker.track('update_config', 'settings_modal', 'action', {
          players_per_team: perTeam,
          duration: duration,
          rounds: rounds
        });
      }
      atualizarVisibilidadeControlesFormato();
      renderFixtures();
      sincronizarEstadoServidor();
      showToast("Parâmetros salvos!");
    }
  } catch (e) {
    console.error("Erro ao salvar configurações automaticamente:", e);
  }
}

// Utility
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Paleta de cores de time vem do servidor (team_colors em GET /api/peladas/{code})
function teamPalette() {
  return (state.currentPelada && Array.isArray(state.currentPelada.team_colors))
    ? state.currentPelada.team_colors
    : [];
}

function getTeamColor(teamIdentifier, fallback = "#38bdf8") {
  if (!teamIdentifier) return fallback;
  const strId = String(teamIdentifier).trim();
  const lower = strId.toLowerCase();

  // 1. Procura no estado dos times atuais por ID ou por Nome
  if (Array.isArray(state.teams)) {
    const found = state.teams.find(t =>
      (t.id && String(t.id).toLowerCase() === lower) ||
      (t.name && String(t.name).trim().toLowerCase() === lower)
    );
    if (found && found.color) return found.color;
  }

  // 2. Mapeamento heurístico baseado no nome da cor ou colete
  if (lower.includes("verde") || lower.includes("green")) return "#84cc16";
  if (lower.includes("laranja") || lower.includes("orange")) return "#f97316";
  if (lower.includes("azul") || lower.includes("blue")) return "#3b82f6";
  if (lower.includes("vermelho") || lower.includes("red")) return "#ef4444";
  if (lower.includes("amarelo") || lower.includes("yellow")) return "#eab308";
  if (lower.includes("preto") || lower.includes("black")) return "#94a3b8"; // tom mais visível em dark theme
  if (lower.includes("roxo") || lower.includes("purple") || lower.includes("violeta")) return "#a855f7";
  if (lower.includes("magenta")) return "#f0abfc";
  if (lower.includes("rosa") || lower.includes("pink")) return "#f472b6";
  if (lower.includes("cinza") || lower.includes("gray") || lower.includes("grey")) return "#94a3b8";

  // 3. Fallback na paleta padrão por índice se for numérico ou conhecido
  const paletteMatch = teamPalette().find(p => `time ${p.label}`.toLowerCase() === lower);
  if (paletteMatch) return paletteMatch.color;

  return fallback;
}

function renderTeamBadge(teamName, teamIdOrColor = null, extraClasses = "") {
  if (!teamName) return "";
  const color = (teamIdOrColor && String(teamIdOrColor).startsWith("#"))
    ? teamIdOrColor
    : getTeamColor(teamIdOrColor || teamName);
  return `<span class="ds-c8c42c63-${color.slice(1)} font-extrabold inline-block ${extraClasses}">${escapeHtml(teamName)}</span>`;
}

/* ========================================================
   GERADOR DE RELATÓRIO PDF (2 FOLHAS A4)
   Folha 1: mesmo conteúdo do dashboard do site (KPIs, classificação
   e destaques individuais), com os mesmos ícones e textos. Se o resumo
   não couber, os blocos que sobram vão para folhas extras (medidos como
   no histórico, sem cortar nada).
   Folha 2: histórico completo de partidas, em ordem crescente de
   rodada, com placar e autor de cada gol. Nomes de times na cor do time.
   O html2canvas renderiza tabelas, blocos e SVG (ícones Lucide) com
   precisão, mas desalinha texto em flexbox, grid, emojis e caixas
   inline. Por isso o layout usa tabelas e evita esses recursos.
   ======================================================== */
const PDF_CORES = {
  fundoCard: "rgba(17, 24, 39, 0.85)",
  borda: "rgba(255, 255, 255, 0.12)",
  bordaSuave: "rgba(255, 255, 255, 0.06)",
  texto: "#f1f5f9",
  textoClaro: "#cbd5e1",
  textoSuave: "#94a3b8",
  textoApagado: "#64748b",
  destaque: "#00f59b",
  destaqueSublinhado: "#00cc80",
  ouro: "#fbbf24",
  prata: "#cbd5e1",
  bronze: "#cd7f32",
  azul: "#38bdf8",
  roxo: "#a855f7",
  amarelo: "#facc15",
  derrota: "#f87171",
};


function pdfTruncar(texto, max) {
  const s = String(texto ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function pdfIcone(nome, cor, tamanho) {
  return `<i class="ds-c8c42c63-${cor.slice(1)}" data-lucide="${nome}" width="${tamanho}" height="${tamanho}"></i>`;
}

function pdfFundo() {
  return `
    <img class="ds-09d0c408" src="/static/bg-pitch.jpg" alt="" />
    <div class="ds-ab0efa33"></div>
    <div class="ds-a20c2c9a"></div>`;
}

const PDF_LOGO_SRC = "/static/icons/icon-512.png";

function pdfCabecalho(nomePelada, codigo, geradoEm) {
  const codigoHtml = codigo
    ? `<span class="ds-7061826e">#${escapeHtml(codigo)}</span>`
    : "";
  return `
    <table class="ds-960750ce"><tr>
      <td class="ds-d6a28982">
        <img class="ds-pdf-logo" src="${PDF_LOGO_SRC}" alt="" width="46" height="46" />
      </td>
      <td class="ds-4d58fd8f">
        <div class="ds-288adda1">Fut<span class="ds-c6aa0a14">Match</span></div>
        <div class="ds-71fff306">Relatório &amp; Estatísticas da Pelada: <strong class="ds-16f85fc0">${escapeHtml(pdfTruncar(nomePelada, 28))}</strong>&nbsp;&nbsp;${codigoHtml}</div>
      </td>
      <td class="ds-7901ac1e">
        <div class="ds-71628b19">Gerado em</div>
        <div class="ds-76462b6f">${geradoEm}</div>
      </td>
    </tr></table>`;
}

function pdfSecao(icone, cor, titulo, subtitulo, deslocamento = -8) {
  return `
    <table class="ds-3a20740c"><tr>
      <td class="ds-6988fb3a-${cor.slice(1)}"></td>
      <td class="ds-f0b089a8-${cor.slice(1)}">${pdfIcone(icone, cor, 18)}</td>
      <td class="ds-2aa9c472"><span class="ds-3884519e-${String(deslocamento).replace('-','m')}">${titulo}</span></td>
    </tr></table>
    ${subtitulo ? `<div class="ds-6f59fd0c">${subtitulo}</div>` : ""}
    <div class="ds-ce80f992"></div>`;
}

function pdfCard(conteudo, classeExtra = "") {
  return `<div class="ds-d6c06699 ${classeExtra}">${conteudo}</div>`;
}

function pdfKpi(rotulo, icone, cor, valor, sub, margemEsquerda, ehTexto) {
  return `
    <div class="ds-05dcf9ec-${String(margemEsquerda).replace('-','m')}">
      <table class="ds-b468078e"><tr>
        <td class="ds-11af79c3"><span class="ds-357a6da9">${rotulo}</span></td>
        <td class="ds-d0eb2ed6-${cor.slice(1)}">${pdfIcone(icone, cor, 16)}</td>
      </tr></table>
      <div class="ds-d0c665f3-${(ehTexto ? 22 : 30)}">${valor}</div>
      <div class="ds-1b064eb7">${sub}</div>
    </div>`;
}

function pdfTabelaClassificacao(leaderboard, corPorNome) {
  const cabeca = (texto, classeExtra = "") =>
    `<th class="ds-ccece863 ${classeExtra}">${texto}</th>`;
  const celula = `padding: 0 4px; height: 44px; font-size: 12px; line-height: 16px; text-align: center; vertical-align: middle; color: ${PDF_CORES.textoClaro}; border-bottom: 1px solid ${PDF_CORES.bordaSuave};`;

  const linhas = leaderboard.slice(0, 6).map((t, idx) => {
    const sg = (t.goals_scored || 0) - (t.goals_conceded || 0);
    const sgCor = sg > 0 ? "#34d399" : (sg < 0 ? PDF_CORES.derrota : PDF_CORES.textoSuave);
    const cor = getTeamColor(t.id || t.name, corPorNome[t.name] || PDF_CORES.textoClaro);
    const corPos = idx === 0 ? PDF_CORES.ouro : idx === 1 ? PDF_CORES.prata : idx === 2 ? PDF_CORES.bronze : PDF_CORES.textoSuave;
    return `
      <tr>
        <td class="ds-ddb2ac36">
          <span class="ds-39e9d999-${corPos.slice(1)}">${idx + 1}º</span><span class="ds-f90571e4-${cor.slice(1)}">${escapeHtml(pdfTruncar(t.name, 20))}</span>
        </td>
        <td class="ds-78e1bc9f">${t.matches}</td>
        <td class="ds-c8015e50">${t.wins}</td>
        <td class="ds-78e1bc9f">${t.draws}</td>
        <td class="ds-39dde90f">${t.losses}</td>
        <td class="ds-78e1bc9f">${t.goals_scored}</td>
        <td class="ds-78e1bc9f">${t.goals_conceded}</td>
        <td class="ds-6cb6bc19-${sgCor.slice(1)}">${sg > 0 ? "+" + sg : sg}</td>
        <td class="ds-6933334d"><span class="ds-65ec726f">${t.points}</span></td>
      </tr>`;
  }).join("");

  return `
    <table class="ds-b468078e">
      <thead><tr>
        ${cabeca("Equipe", "ds-26cef2c5")}${cabeca("J")}${cabeca("V")}${cabeca("E")}${cabeca("D")}${cabeca("GP")}${cabeca("GC")}${cabeca("SG")}${cabeca("PTS", "ds-13b8ff02")}
      </tr></thead>
      <tbody>${linhas || `<tr><td class="ds-87e7c578" colspan="9">Nenhuma partida finalizada até o momento.</td></tr>`}</tbody>
    </table>`;
}

function pdfColunaRanking(titulo, emoji, cor, linhas, vazio) {
  const ALTURA = 18;
  const ESPACO = 8;
  const LARGURA_PILULA = 96;
  const nomes = linhas.map((l) => `
    <tr><td class="ds-3daef0d9"><span class="ds-111aa6b4">${l.pos}.</span><span class="ds-5c2dd240"> ${escapeHtml(pdfTruncar(l.nome, 18))}</span></td></tr>
    <tr><td class="ds-9ec85790">&nbsp;</td></tr>`).join("");
  // Pílula em SVG: retângulo arredondado e texto centralizado por atributo (sem depender de caixa CSS)
  const pilulas = linhas.map((l) => `
    <tr><td class="ds-c70eeb2e">
      <div class="ds-552290b1">
        <svg class="ds-dd0c3c24" width="${LARGURA_PILULA}" height="${ALTURA}" viewBox="0 0 ${LARGURA_PILULA} ${ALTURA}">
          <rect x="0" y="0" width="${LARGURA_PILULA}" height="${ALTURA}" rx="${ALTURA / 2}" ry="${ALTURA / 2}" fill="${l.fundo}"/>
        </svg>
        <div class="ds-9a1591bb-${l.cor.slice(1)}">${escapeHtml(l.texto)}</div>
      </div>
    </td></tr>
    <tr><td class="ds-9ec85790">&nbsp;</td></tr>`).join("");

  const corpo = linhas.length
    ? `<table class="ds-b468078e"><tr>
         <td class="ds-d31a2949"><table class="ds-b468078e">${nomes}</table></td>
         <td class="ds-896ff6fc"><table class="ds-3a20740c">${pilulas}</table></td>
       </tr></table>`
    : `<div class="ds-49f0db53">${vazio}</div>`;

  return `
    <table class="ds-3cfad0aa"><tr>
      <td class="ds-c59526ae-${cor.slice(1)}"></td>
      <td class="ds-8b814190-${cor.slice(1)}"><span class="ds-emoji-ranking">${emoji}</span></td>
      <td class="ds-f7f24ccb"><span class="ds-5c2dd240">${titulo}</span></td>
    </tr></table>
    ${corpo}`;
}

function pdfRodape(textoPagina) {
  return `
    <table class="ds-a2655d7b"><tr>
      <td class="ds-5c638ac5">FutMatch — Gestão Inteligente e Estatísticas de Peladas</td>
      <td class="ds-e8994c9f">Folha oficial de resumo • ${textoPagina}</td>
    </tr></table>`;
}

/* ---------- Histórico: autores dos gols por partida ---------- */
function pdfResumoGols(partida) {
  const idsCasa = new Map((partida.home_players || []).map((p) => [p.id, p.name]));
  const idsFora = new Map((partida.away_players || []).map((p) => [p.id, p.name]));
  const gols = { casa: new Map(), fora: new Map() };
  const contra = { casa: new Map(), fora: new Map() };

  for (const ev of partida.events || []) {
    let lado = null;
    let nome = null;
    if (idsCasa.has(ev.player_id)) { lado = "casa"; nome = idsCasa.get(ev.player_id); }
    else if (idsFora.has(ev.player_id)) { lado = "fora"; nome = idsFora.get(ev.player_id); }
    if (!lado) continue;
    const mapa = ev.event_type === "goal" ? gols[lado] : (ev.event_type === "own_goal" ? contra[lado] : null);
    if (mapa) mapa.set(nome, (mapa.get(nome) || 0) + 1);
  }

  const soma = (mapa) => [...mapa.values()].reduce((a, b) => a + b, 0);
  const feitos = (lado) => soma(gols[lado]) + soma(contra[lado === "casa" ? "fora" : "casa"]);

  const montar = (lado) => {
    const itens = [
      ...[...gols[lado]].map(([nome, n]) => ({ nome, n, contra: false })),
      ...[...contra[lado]].map(([nome, n]) => ({ nome, n, contra: true })),
    ].sort((a, b) => (b.n - a.n) || a.nome.localeCompare("pt-BR"));
    const placar = lado === "casa" ? partida.home_score : partida.away_score;
    return { itens, semAutor: Math.max(0, (placar || 0) - feitos(lado)) };
  };

  return { casa: montar("casa"), fora: montar("fora") };
}

function pdfListaGols(resumo) {
  const MAX = 6;
  const linhas = resumo.itens.slice(0, MAX).map((i) => `
    <tr>
      <td class="${(i.contra) ? 'ds-478c010b-f87171' : 'ds-478c010b-f1f5f9'}">${escapeHtml(pdfTruncar(i.nome, 13))}${i.contra ? ` <span class="ds-98d959ab">(contra)</span>` : ""}</td>
      <td class="ds-baa59f8c">${i.n > 1 ? "×" + i.n : ""}</td>
    </tr>`).join("");
  const resto = resumo.itens.length > MAX
    ? `<tr><td class="ds-efc1fd63" colspan="2">+${resumo.itens.length - MAX} jogador(es)</td></tr>` : "";
  const semAutor = resumo.semAutor > 0
    ? `<tr><td class="ds-efc1fd63" colspan="2">+${resumo.semAutor} gol(s) sem autor</td></tr>` : "";
  const vazio = !resumo.itens.length && !resumo.semAutor
    ? `<tr><td class="ds-caa640fd" colspan="2">Sem gols</td></tr>` : "";

  return `<table class="ds-b468078e">${linhas}${resto}${semAutor}${vazio}</table>`;
}

function pdfCelulaPartida(partida, corPorNome) {
  const cCasa = getTeamColor(partida.home_team_id || partida.home_team_name, corPorNome[partida.home_team_name] || PDF_CORES.textoClaro);
  const cFora = getTeamColor(partida.away_team_id || partida.away_team_name, corPorNome[partida.away_team_name] || PDF_CORES.textoClaro);
  const resumo = pdfResumoGols(partida);
  const dataHora = typeof partida.played_at === "string" ? partida.played_at.slice(0, 16) : "";

  return `
    <td class="ds-54f98b95">
      <table class="ds-b468078e"><tr>
        <td class="ds-eeccd5b4">Rodada ${partida.round_number}</td>
        <td class="ds-6844abe7">${escapeHtml(dataHora)}</td>
      </tr></table>

      <table class="ds-8a9450c9"><tr>
        <td class="ds-9902f634-${cCasa.slice(1)}">${escapeHtml(pdfTruncar(partida.home_team_name, 14))}</td>
        <td class="ds-9efea815-${cFora.slice(1)}">${escapeHtml(pdfTruncar(partida.away_team_name, 14))}</td>
      </tr></table>
      <div class="ds-55b414aa">${partida.home_score}<span class="ds-dd5da918"> - </span>${partida.away_score}</div>

      <div class="ds-ee329cbd"></div>

      <table class="ds-4523e30d"><tr>
        <td class="ds-298cc1dd">${pdfListaGols(resumo.casa)}</td>
        <td class="ds-1db2f04e">${pdfListaGols(resumo.fora)}</td>
      </tr></table>
    </td>`;
}

function pdfTituloRodada(rodada, continuacao) {
  const sufixo = continuacao
    ? ` <span class="ds-d4eaba19">(continuação)</span>`
    : "";
  return `
    <div class="ds-48d56994">
      <table class="ds-3a20740c"><tr>
        <td class="ds-9ffc0c7d">Rodada ${rodada}${sufixo}</td>
      </tr></table>
    </div>`;
}

function pdfLinhaCards(celulas) {
  const cartoes = [...celulas];
  while (cartoes.length < 3) cartoes.push("<td></td>");
  return `
    <div class="ds-0e8026b3">
      <table class="ds-9fcde97d"><tr>${cartoes.join("")}</tr></table>
    </div>`;
}

function pdfMedirAlturas(htmls, larguraPx) {
  const medidor = document.createElement("div");
  medidor.style.position = "fixed";
  medidor.style.left = "-10000px";
  medidor.style.top = "0px";
  medidor.style.width = `${larguraPx}px`;
  medidor.style.visibility = "hidden";
  medidor.style.fontFamily = "'Outfit', sans-serif";
  document.body.appendChild(medidor);
  try {
    return htmls.map((html) => {
      const el = document.createElement("div");
      el.innerHTML = html;
      medidor.appendChild(el);
      return el.offsetHeight;
    });
  } finally {
    medidor.remove();
  }
}

/* Pagina as unidades (linhas de cards e títulos) sem nunca cortar uma partida.
   Uma rodada que continua na página seguinte repete o título com "(continuação)". */
function pdfPaginar(unidades, continuacoes, alturaDisponivel) {
  const paginas = [];
  let atual = [];
  let alturaAtual = 0;
  for (const u of unidades) {
    if (alturaAtual + u.altura > alturaDisponivel && atual.length > 0) {
      paginas.push(atual);
      atual = [];
      alturaAtual = 0;
    }
    if (atual.length === 0 && u.tipo === "linha") {
      const cont = continuacoes[u.rodada];
      atual.push(cont);
      alturaAtual += cont.altura;
    }
    atual.push(u);
    alturaAtual += u.altura;
  }
  if (atual.length > 0) paginas.push(atual);
  return paginas;
}

/* Marcador do jogador em PNG pequeno (10px) para a legenda HTML do PDF. */
function pdfMarcadorPng(img) {
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = 20;
  c.height = 20;
  c.getContext("2d").drawImage(img, 0, 0, 20, 20);
  return c.toDataURL("image/png");
}

/* Gráfico de evolução para o PDF: mesma série do dashboard, sem marcadores nem interação.
   A legenda não é desenhada no canvas (com muitos jogadores ela invadia o gráfico); é
   montada em HTML pelo bloco do resumo. Retorna { imagem (PNG), legenda } ou null quando
   não há dados ou Chart.js não carregou. */
async function pdfGraficoEvolucao(metrica) {
  if (typeof window.Chart !== "function") return null;
  const serie = calcularSerieEvolucao(cachedEvolutionMatches, chartAvailablePlayers, selectedChartPlayerIds, metrica);
  if (serie.labels.length === 0 || serie.datasets.length === 0) return null;

  const LARGURA = 670;
  const ALTURA = 200;
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0px";
  container.style.width = `${LARGURA}px`;
  container.style.height = `${ALTURA}px`;
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  document.body.appendChild(container);

  // Marcadores (forma e cor por jogador) precisam estar carregados antes de desenhar
  await Promise.all(serie.datasets.map((ds) => ds.markerImage && !ds.markerImage.complete
    ? new Promise((res) => { ds.markerImage.onload = res; ds.markerImage.onerror = res; })
    : null));

  const porcentagem = metrica === "consistency";
  let grafico = null;
  try {
    grafico = new window.Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: serie.labels,
        datasets: serie.datasets,
      },
      plugins: [playerMarkerPlugin],
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: 2,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: {
            grid: { color: "#1e293b" },
            ticks: { color: PDF_CORES.textoApagado, font: { family: "Outfit", size: 8 }, maxRotation: 0, autoSkipPadding: 12 },
          },
          y: {
            beginAtZero: true,
            max: porcentagem ? 100 : undefined,
            grid: { color: "#1e293b" },
            ticks: {
              color: PDF_CORES.textoApagado,
              font: { family: "Outfit", size: 8 },
              stepSize: porcentagem ? 20 : 0.5,
              callback: (val) => (porcentagem ? `${val}%` : Number(val).toFixed(1)),
            },
            title: {
              display: true,
              text: porcentagem ? "Aproveitamento (%)" : "Média de gols",
              color: PDF_CORES.textoSuave,
              font: { family: "Outfit", size: 10, weight: "600" },
            },
          },
        },
      },
    });
    return {
      imagem: grafico.toBase64Image("image/png", 1),
      legenda: serie.datasets.map((ds) => ({ nome: ds.label, marcador: pdfMarcadorPng(ds.markerImage) })),
    };
  } finally {
    if (grafico) grafico.destroy();
    container.remove();
  }
}

/* ---------- Resumo (folha 1 e folhas extras, se o resumo não couber) ---------- */
/* Topo (cabeçalho + KPIs) só na folha 1; cada bloco do resumo é uma unidade medida,
   que vai para uma folha extra quando não cabe, igual ao histórico. */
function pdfTopoResumo(d) {
  const kpis = `
    <div class="ds-c40d127c">
      ${pdfKpi("Partidas Jogadas", "flag", PDF_CORES.destaque, d.totalPartidas, "&nbsp;", 0, false)}
      ${pdfKpi("Total de Gols", "goal", PDF_CORES.destaque, d.totalGols, `Média: <strong class="ds-c6aa0a14">${d.media}</strong> por partida`, 12, false)}
      ${pdfKpi("Artilheiro Máximo", "award", PDF_CORES.ouro, pdfTruncar(d.artilheiro, 15), `<span class="ds-kpi-ouro">${d.artilheiroGols} gols marcados</span>`, 12, true)}
      ${pdfKpi("Maior Vencedor", "crown", PDF_CORES.amarelo, pdfTruncar(d.vencedor, 15), `<span class="ds-kpi-amarelo">${d.vencedorVitorias} vitórias (${d.vencedorTaxa}%)</span>`, 12, true)}
    </div>`;
  return `${pdfCabecalho(d.nomePelada, d.codigo, d.geradoEm)}<div class="ds-1dd9a5e2">${kpis}</div>`;
}

/* Legenda em grade (6 colunas) acima do gráfico: cresce com os jogadores sem invadir o plot. */
function pdfLegendaGrafico(itens) {
  const COLUNAS = 6;
  const linhas = [];
  for (let i = 0; i < itens.length; i += COLUNAS) linhas.push(itens.slice(i, i + COLUNAS));
  const celula = (item) => item
    ? `<td class="ds-7d44fd3a">${item.marcador ? `<img class="ds-cee4420b" src="${item.marcador}" alt="" width="10" height="10" />` : ""}${escapeHtml(pdfTruncar(item.nome, 14))}</td>`
    : `<td></td>`;
  return `<table class="ds-4523e30d">${linhas.map((linha) => {
    const preenchida = [...linha];
    while (preenchida.length < COLUNAS) preenchida.push(null);
    return `<tr>${preenchida.map(celula).join("")}</tr>`;
  }).join("")}</table>`;
}

function pdfCardGrafico(titulo, icone, cor, grafico) {
  const corpo = grafico
    ? `${pdfLegendaGrafico(grafico.legenda)}<div class="ds-4d5aeaa1"><img class="ds-942ecd31" src="${grafico.imagem}" alt="" /></div>`
    : `<div class="ds-7c123538">Sem dados para exibir.</div>`;
  return pdfCard(pdfSecao(icone, cor, titulo, "", -8) + corpo);
}

// Linha corrida das peladas da corrente: "Nome #CODIGO • Nome #CODIGO", a atual primeiro
function pdfLinhaPool(peladas) {
  if (!peladas || peladas.length <= 1) {
    return `<div class="ds-pool-linha">Esta pelada ainda não está vinculada a outras peladas.</div>`;
  }
  const itens = peladas.map((p, idx) => `${escapeHtml(pdfTruncar(p.name, 28))} <span class="ds-pool-codigo">#${escapeHtml(p.code)}</span>${idx === 0 ? ' <span class="ds-pool-atual">(atual)</span>' : ''}`);
  return `<div class="ds-pool-linha">${itens.join('<span class="ds-pool-bolinha">•</span>')}</div>`;
}

function pdfBlocosResumo(d) {
  const classificacao = pdfCard(
    pdfSecao("list-ordered", PDF_CORES.destaque, "Tabela Geral de Classificação", "") +
    pdfTabelaClassificacao(d.leaderboard, d.corPorNome)
  );

  const destaques = pdfCard(
    pdfSecao("flame", PDF_CORES.ouro, "Destaques Individuais", "Quem mais balançou as redes e quem mais venceu") +
    `<table class="ds-b468078e"><tr>
       <td class="ds-a1be0881">${pdfColunaRanking("Top goleadores", "⚽", PDF_CORES.destaque, d.artilheiros, "Nenhum gol atribuído ainda.")}</td>
       <td class="ds-28dd0841">${pdfColunaRanking("Mais vitoriosos", "🏆", PDF_CORES.amarelo, d.vitoriosos, "Sem jogos concluídos.")}</td>
     </tr></table>`
  );

  const aproveitamento = pdfCardGrafico("Aproveitamento", "target", PDF_CORES.destaque, d.graficos.aproveitamento);
  const media = pdfCardGrafico("Média de gols", "goal", PDF_CORES.destaque, d.graficos.media);
  const pool = pdfCard(pdfSecao("link", PDF_CORES.roxo, "Pool de Peladas", "") + pdfLinhaPool(d.pool), "ds-card-roxo");

  // padding-top (e não margin-top) para que a medição do bloco inclua o espaçamento
  return [classificacao, destaques, aproveitamento, media, pool].map((html) => `<div class="ds-1dd9a5e2">${html}</div>`);
}

/* Agrupa blocos (já medidos) em folhas: a primeira respeita a altura do topo e as demais, a do cabeçalho. */
function pdfAgruparBlocos(blocos, disponivelPrimeira, disponivelDemais) {
  const grupos = [];
  let atual = [];
  let soma = 0;
  let limite = disponivelPrimeira;
  for (const b of blocos) {
    if (soma + b.altura > limite && atual.length > 0) {
      grupos.push(atual);
      atual = [];
      soma = 0;
      limite = disponivelDemais;
    }
    atual.push(b);
    soma += b.altura;
  }
  if (atual.length > 0) grupos.push(atual);
  return grupos;
}

function pdfPaginaHistorico(conteudo, numero, total, subtitulo) {
  return `
    ${pdfSecao("history", PDF_CORES.destaque, "Histórico Completo de Partidas", subtitulo, -9)}
    <div class="ds-6b1f0d97">${conteudo}</div>
    <div class="ds-b41ae4d5">${pdfRodape(`Página ${numero} de ${total}`)}</div>`;
}

async function pdfCapturarPagina(conteudo) {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.top = "0px";
  el.style.left = "0px";
  el.style.width = "794px";
  el.style.height = "1123px";
  el.style.zIndex = "-9999";
  el.style.overflow = "hidden";
  el.style.fontFamily = "'Outfit', sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI'";
  el.style.color = PDF_CORES.texto;
  el.style.backgroundColor = "#080c14";
  el.innerHTML = `
    <div class="ds-564caf2c">
      ${pdfFundo()}
      <div class="ds-5898c22e">${conteudo}</div>
    </div>`;
  document.body.appendChild(el);

  try {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.refreshIcons();
    }
    const imagens = Array.from(el.querySelectorAll("img"));
    await Promise.all(imagens.map((img) => img.complete ? null : new Promise((res) => { img.onload = res; img.onerror = res; })));

    const canvas = await window.html2canvas(el, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      backgroundColor: "#080c14",
      width: 794,
      height: 1123,
      windowWidth: 794,
      windowHeight: 1123,
      logging: false,
    });
    return canvas.toDataURL("image/jpeg", 0.95);
  } finally {
    el.remove();
  }
}

async function exportarRelatorioPDF() {
  if (state.role !== 'admin') return;
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const btn = document.getElementById("btn-export-pdf");
  const btnText = document.getElementById("btn-export-pdf-text");
  const originalText = btnText ? btnText.textContent : "Gerar PDF";

  const hasH2C = typeof window.html2canvas === "function";
  const hasJsPdf = typeof window.jspdf !== "undefined" && typeof window.jspdf.jsPDF === "function";

  if (!hasH2C || !hasJsPdf) {
    await showCustomAlert("Bibliotecas geradoras de PDF ainda estão carregando. Tente novamente em alguns segundos.", "Aviso");
    return;
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Entre em uma pelada para gerar o relatório em PDF.", "Aviso");
    return;
  }

  try {
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = "Gerando...";

    // 1. Dados: dashboard (KPIs e destaques), partidas (histórico) e pelada (cores dos times)
    const pCode = state.currentPelada.code;
    const dashUrl = `/api/dashboard?pelada_code=${pCode}`;
    const matchesUrl = `/api/matches?pelada_code=${pCode}`;
    const [dash, partidasBrutas, info] = await Promise.all([
      fetch(dashUrl).then((r) => r.json()),
      fetch(matchesUrl).then((r) => r.json()),
      fetch(`/api/peladas/${pCode}`).then((r) => r.json()),
    ]);
    const pName = (info && info.name) || (state.currentPelada && state.currentPelada.name) || "";

    const summary = dash.summary || { total_matches: 0, total_goals: 0, avg_goals_per_match: 0 };
    const leaderboard = dash.leaderboard || [];
    const topScorers = dash.top_scorers || [];
    const topWinners = dash.top_winners || [];

    const corPorNome = {};
    (info.teams || []).forEach((t) => { if (t.name) corPorNome[t.name] = getTeamColor(t.id || t.name, t.color || PDF_CORES.textoClaro); });

    const partidas = (Array.isArray(partidasBrutas) ? partidasBrutas : [])
      .filter((p) => p.finished !== false)
      .sort((a, b) => (a.round_number || 0) - (b.round_number || 0));

    if (partidas.length === 0) {
      updatePdfExportButtonState(0);
      await showCustomAlert("Não há nenhuma partida gravada para gerar o relatório em PDF.", "Aviso");
      return;
    }

    const agora = new Date();
    const geradoEm = `${agora.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })} às ${agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

    // 2. Resumo: gráficos e blocos prontos antes de medir (a fonte precisa estar carregada para as medidas valerem)
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const base = { nomePelada: pName, codigo: pCode, geradoEm, corPorNome };
    const graficos = {
      aproveitamento: await pdfGraficoEvolucao("consistency"),
      media: await pdfGraficoEvolucao("avg_goals"),
    };
    // Corrente da pool: nome de cada pelada (a atual já veio no info)
    const poolPeladas = await Promise.all((info.chain_codes || [pCode]).map(async (c) => {
      if (c === pCode) return { code: c, name: pName };
      const outra = await fetch(`/api/peladas/${c}`).then((r) => r.json()).catch(() => ({}));
      return { code: c, name: outra.name || c };
    }));
    const dadosResumo = {
      ...base,
      graficos,
      pool: poolPeladas,
      totalPartidas: summary.total_matches,
      totalGols: summary.total_goals,
      media: (summary.avg_goals_per_match || 0).toFixed(1),
      artilheiro: topScorers.length ? topScorers[0].name : "Nenhum",
      artilheiroGols: topScorers.length ? topScorers[0].goals : 0,
      vencedor: topWinners.length ? topWinners[0].name : "Nenhum",
      vencedorVitorias: topWinners.length ? topWinners[0].wins : 0,
      vencedorTaxa: topWinners.length ? topWinners[0].win_rate : 0,
      leaderboard,
      artilheiros: topScorers.filter((s) => s.goals > 0).slice(0, 5)
        .map((s, i) => ({ pos: i + 1, nome: s.name, texto: `${s.goals} ${s.goals === 1 ? "gol" : "gols"}`, cor: PDF_CORES.ouro, fundo: "rgba(251, 191, 36, 0.18)" })),
      vitoriosos: topWinners.filter((w) => w.wins > 0).slice(0, 5)
        .map((w, i) => ({ pos: i + 1, nome: w.name, texto: `${w.wins}V (${w.win_rate}%)`, cor: PDF_CORES.azul, fundo: "rgba(56, 189, 248, 0.18)" })),
    };
    const topoResumo = pdfTopoResumo(dadosResumo);
    const blocosResumo = pdfBlocosResumo(dadosResumo);
    const cabecalhoSo = pdfCabecalho(pName, pCode, geradoEm);

    // 3. Unidades do histórico (cada linha de cards e título de rodada), medidas no DOM
    const rodadas = [...new Set(partidas.map((p) => p.round_number))].sort((a, b) => a - b);
    const unidadesBrutas = [];
    const continuacoesBrutas = {};
    rodadas.forEach((r) => {
      const jogos = partidas.filter((p) => p.round_number === r);
      for (let i = 0; i < jogos.length; i += 3) {
        const celulas = jogos.slice(i, i + 3).map((j) => pdfCelulaPartida(j, corPorNome));
        unidadesBrutas.push(i === 0
          ? { tipo: "rodada", rodada: r, html: pdfTituloRodada(r, false) + pdfLinhaCards(celulas) }
          : { tipo: "linha", rodada: r, html: pdfLinhaCards(celulas) });
      }
      continuacoesBrutas[r] = { tipo: "continuacao", rodada: r, html: pdfTituloRodada(r, true) };
    });

    const subtitulo = `${partidas.length} partidas · ordenadas por rodada`;
    const htmlCabecalhoHistorico = pdfSecao("history", PDF_CORES.destaque, "Histórico Completo de Partidas", subtitulo);
    const todosHtml = [htmlCabecalhoHistorico, ...unidadesBrutas.map((u) => u.html), ...Object.values(continuacoesBrutas).map((c) => c.html)];
    const alturas = pdfMedirAlturas(todosHtml, 714);
    const alturaCabecalho = alturas[0];
    const unidades = unidadesBrutas.map((u, i) => ({ ...u, altura: alturas[i + 1] }));
    const continuacoes = {};
    Object.keys(continuacoesBrutas).forEach((r, i) => {
      const alturaCont = alturas[1 + unidadesBrutas.length + i];
      continuacoes[r] = { ...continuacoesBrutas[r], altura: alturaCont };
    });

    // Área útil das folhas: 1051px menos o rodapé (~40px) e uma folga de 4px
    const ALTURA_RODAPE = 40;
    const ALTURA_CONTEUDO = 1051;
    const DISPONIVEL = ALTURA_CONTEUDO - ALTURA_RODAPE - 4;

    // 4. Paginação: resumo (folha 1 com topo; folhas extras só com cabeçalho) e depois o histórico
    const [alturaTopo, alturaCabecalhoSo, ...alturasBlocos] = pdfMedirAlturas([topoResumo, cabecalhoSo, ...blocosResumo], 714);
    const blocos = blocosResumo.map((html, i) => ({ html, altura: alturasBlocos[i] }));
    const gruposResumo = pdfAgruparBlocos(blocos, DISPONIVEL - alturaTopo, DISPONIVEL - alturaCabecalhoSo);
    const paginasResumo = gruposResumo.length ? gruposResumo : [[]];

    // Área útil de cada página de histórico: o cabeçalho da seção também ocupa espaço
    const alturaDisponivel = DISPONIVEL - alturaCabecalho;
    const paginasHistorico = unidades.length > 0 ? pdfPaginar(unidades, continuacoes, alturaDisponivel) : [[]];
    const totalPaginas = paginasResumo.length + paginasHistorico.length;

    // 5. Montar as páginas
    const paginas = [];
    paginasResumo.forEach((grupo, i) => {
      const topo = i === 0 ? topoResumo : cabecalhoSo;
      const corpo = grupo.map((b) => b.html).join("");
      paginas.push(`${topo}${corpo}<div class="ds-b41ae4d5">${pdfRodape(`Página ${i + 1} de ${totalPaginas}`)}</div>`);
    });
    paginasHistorico.forEach((pagina, i) => {
      const conteudo = pagina.length
        ? pagina.map((u) => u.html).join("")
        : pdfCard(`<div class="ds-7fef9661">Nenhuma partida finalizada até o momento.</div>`);
      paginas.push(pdfPaginaHistorico(conteudo, paginasResumo.length + i + 1, totalPaginas, subtitulo));
    });

    // 6. Renderizar cada página e montar o PDF
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "px", format: [794, 1123] });
    for (let i = 0; i < paginas.length; i++) {
      const imagem = await pdfCapturarPagina(paginas[i]);
      if (i > 0) doc.addPage([794, 1123], "portrait");
      doc.addImage(imagem, "JPEG", 0, 0, 794, 1123);
    }

    const filename = `relatorio-pelada-${(pCode || 'futmatch')}-${agora.toISOString().slice(0, 10)}.pdf`;
    doc.save(filename);

    showToast("PDF gerado e baixado com sucesso!");
  } catch (err) {
    console.error("Erro ao gerar PDF:", err);
    await showCustomAlert("Houve uma falha ao gerar o arquivo PDF. Verifique o console.", "Erro ao Gerar PDF", false, { icone: 'circle-x' });
  } finally {
    updatePdfExportButtonState();
    if (btnText) btnText.textContent = originalText;
  }
}
