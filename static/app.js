// FutMatch Client Logic

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
    alarm_sound: "standard-emergency-warning-signal.mp3"
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

function getAdminToken(code) {
  const peladaCode = code || (state.currentPelada ? state.currentPelada.code : null);
  if (!peladaCode) return "";
  return localStorage.getItem(`futmatch_token_${peladaCode}`) || "";
}

function getAuthHeaders(extraHeaders = {}) {
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  const token = getAdminToken();
  if (token) {
    headers["X-Admin-Token"] = token;
  }
  return headers;
}

function setActivePelada(code, role = 'spectator', adminToken = null) {
  state.currentPelada = { code };
  state.role = role;
  localStorage.setItem('futmatch_active_pelada', code);
  localStorage.setItem(`futmatch_role_${code}`, role);
  if (adminToken) {
    localStorage.setItem(`futmatch_token_${code}`, adminToken);
  }

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
        if (el.id !== 'btn-clear-history') {
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
    document.getElementById("cfg-rounds")
  ];
  cfgFields.forEach(f => {
    if (f) f.disabled = !isLeader;
  });

  atualizarVisibilidadeControlesFormato();

  lucide.createIcons();
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
      await showCustomAlert("A pelada com o código informado não foi encontrada.", "Código Inválido");
      return;
    }

    const data = await res.json();
    const savedRole = localStorage.getItem(`futmatch_role_${code}`) || 'spectator';
    state.currentPelada = data;
    state.role = savedRole;

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
      await showCustomAlert(msg, "Erro");
      if (btn) btn.disabled = false;
      return;
    }

    const data = await res.json();
    // Quem cria é o Líder da pelada
    setActivePelada(data.code, 'admin', data.admin_token);
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
    await showCustomAlert("Erro de conexão ao criar pelada.", "Erro");
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
    const previousRole = localStorage.getItem(`futmatch_role_${code}`) || 'spectator';
    setActivePelada(data.code, previousRole);
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
    await showCustomAlert("Erro de conexão ao acessar a pelada.", "Erro");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function abrirModalDefinirSenha() {
  const modal = document.getElementById('modal-set-password');
  const input = document.getElementById('input-new-pelada-password');
  if (modal) {
    modal.classList.remove('hidden');
    if (input) {
      input.value = "";
      setTimeout(() => input.focus(), 100);
    }
    lucide.createIcons();
  }
}

async function salvarSenhaMestraObrigatoria(event) {
  event.preventDefault();
  const input = document.getElementById('input-new-pelada-password');
  if (!input) return;
  const password = input.value.trim();

  if (password.length < 3) {
    await showCustomAlert("A senha precisa ter no mínimo 3 caracteres.", "Senha Curta");
    return;
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada ativa no momento.", "Erro");
    return;
  }

  const btn = document.getElementById('btn-save-master-password');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/set-password`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ password })
    });

    if (!res.ok) {
      const err = await res.json();
      await showCustomAlert(err.detail || "Erro ao salvar senha.", "Erro");
      if (btn) btn.disabled = false;
      return;
    }

    const data = await res.json();
    if (data.admin_token) {
      localStorage.setItem(`futmatch_token_${state.currentPelada.code}`, data.admin_token);
    }

    const modal = document.getElementById('modal-set-password');
    if (modal) modal.classList.add('hidden');

    if (window.auditTracker) {
      window.auditTracker.track('set_pelada_password', 'modal-set-password', 'security', {
        code: state.currentPelada.code
      });
    }

    showToast("Senha mestra da pelada definida com sucesso!");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao cadastrar senha.", "Erro");
  } finally {
    if (btn) btn.disabled = false;
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
    await showCustomAlert("Nenhuma pelada selecionada.", "Erro");
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
    setActivePelada(state.currentPelada.code, 'admin', data.admin_token);
    input.value = "";
    showToast("Você assumiu a liderança da pelada com sucesso!");
    await showCustomAlert("Privilégios de Líder ativados com sucesso! Agora você pode gerenciar jogadores, confrontos e placares.", "Administrador Confirmado");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao validar senha.", "Erro");
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
    "Continuar Aqui"
  );
  if (!confirmed) return;

  if (claimAdminCooldownTimer) {
    clearInterval(claimAdminCooldownTimer);
    claimAdminCooldownTimer = null;
  }
  encerrarLiveEvents();

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
          state.currentPelada.parent_code = data.parent_code;
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
async function salvarPoolPeladas(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const input = document.getElementById('input-parent-pelada-code');
  if (!input) return;
  const parentCode = input.value.trim().toUpperCase();

  if (!parentCode || parentCode.length < 5) {
    await showCustomAlert("Digite o código de 5 caracteres da pelada anterior a ser vinculada.", "Código Inválido");
    return;
  }

  if (!state.currentPelada || !state.currentPelada.code) {
    await showCustomAlert("Nenhuma pelada ativa.", "Erro");
    return;
  }

  if (parentCode === state.currentPelada.code) {
    await showCustomAlert("Você não pode vincular uma pelada a ela mesma!", "Aviso");
    return;
  }

  const btn = document.getElementById('btn-save-pool');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ parent_code: parentCode })
    });

    const data = await res.json();

    if (!res.ok) {
      await showCustomAlert(data.detail || "Erro ao vincular pelada à pool.", "Erro no Vínculo");
      if (btn) btn.disabled = false;
      return;
    }

    state.currentPelada.parent_code = data.parent_code;
    state.currentPelada.chain_codes = data.chain_codes;
    state.currentPelada.pool_started_at = data.pool_started_at;
    input.value = "";

    renderPoolUI(data.chain_codes);
    await atualizarDashboard();
    showToast("Pelada vinculada com sucesso à corrente da Pool!");
  } catch (e) {
    console.error(e);
    await showCustomAlert("Erro de conexão ao vincular peladas.", "Erro");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function desvincularPool() {
  const confirmed = await showCustomConfirm(
    "Deseja desvincular esta pelada da corrente anterior? O histórico voltará a considerar apenas esta pelada individual.",
    "Desvincular Pool",
    "Desvincular",
    "Cancelar"
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/peladas/${state.currentPelada.code}/pool`, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ parent_code: null })
    });

    const data = await res.json();
    if (res.ok) {
      state.currentPelada.parent_code = null;
      state.currentPelada.chain_codes = data.chain_codes || [state.currentPelada.code];
      state.currentPelada.pool_started_at = data.pool_started_at;
      renderPoolUI(state.currentPelada.chain_codes);
      await atualizarDashboard();
      showToast("Pelada desvinculada da pool!");
    }
  } catch (e) {
    console.error(e);
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
      chainBadges.innerHTML = codes.map((c, idx) => `
        <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg ${idx === 0 ? 'bg-purple-600 text-white shadow' : 'bg-card border border-borderLight text-slate-300'}">
          ${idx === 0 ? '⭐ Atual:' : `🔗 #${idx}:`} #${escapeHtml(c)}
        </span>
        ${idx < codes.length - 1 ? '<i data-lucide="arrow-right" class="w-3.5 h-3.5 text-slate-500"></i>' : ''}
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

  lucide.createIcons();
}

// Sincroniza o estado atual (jogadores, times, confrontos) com o servidor SQLite
function sincronizarEstadoServidor(immediate = false) {
  if (!state.currentPelada || !state.currentPelada.code) return;
  if (state.role !== 'admin') return;

  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);

  const executarSync = async () => {
    try {
      await fetch(`/api/peladas/${state.currentPelada.code}/sync-state`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          players: state.players,
          teams: state.teams,
          fixtures: state.fixtures,
          config: state.config
        })
      });
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
  lucide.createIcons();
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
  atualizarBotaoSomUI();
  await inicializarPelada();
  lucide.createIcons();

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
  lucide.createIcons();
}

// Posiciona o retângulo verde atrás da aba ativa da navegação desktop
function atualizarIndicadorNav() {
  const pill = document.getElementById('nav-tab-pill');
  if (!pill) return;
  const btn = document.querySelector('nav .nav-tab.active');
  if (!btn || btn.offsetWidth === 0) {
    pill.style.opacity = '0';
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
  if (typeof msg === "string" && msg.includes("<")) {
    toastMsg.innerHTML = msg;
  } else {
    toastMsg.textContent = msg;
  }
  toast.classList.remove("translate-y-24", "opacity-0");
  setTimeout(() => {
    toast.classList.add("translate-y-24", "opacity-0");
  }, 2500);
}

// Sistema de Janela de Diálogo Personalizada (Substitui window.alert e window.confirm)
function showCustomAlert(message, title = "Aviso") {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-dialog-modal");
    const titleEl = document.getElementById("custom-dialog-title");
    const msgEl = document.getElementById("custom-dialog-msg");
    const okBtn = document.getElementById("custom-dialog-ok-btn");
    const cancelBtn = document.getElementById("custom-dialog-cancel-btn");
    const iconContainer = document.getElementById("custom-dialog-icon-container");

    if (!modal) {
      resolve();
      return;
    }

    titleEl.textContent = title;
    if (typeof message === "string" && message.includes("<")) {
      msgEl.innerHTML = message;
    } else {
      msgEl.textContent = message;
    }
    cancelBtn.classList.add("hidden");
    okBtn.textContent = "Entendido";
    okBtn.className = "px-5 py-2 bg-neon-accent hover:bg-emerald-400 text-black text-xs font-bold rounded-xl transition shadow";
    iconContainer.className = "w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 text-xl text-neon-accent";

    const handleKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleOk();
      }
    };

    const handleOk = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      window.removeEventListener("keydown", handleKeydown, true);
    };

    okBtn.addEventListener("click", handleOk, { once: true });
    window.addEventListener("keydown", handleKeydown, true);
    modal.classList.remove("hidden");
    okBtn.focus();
    lucide.createIcons();
  });
}

function showCustomConfirm(message, title = "Confirmação", confirmText = "Confirmar", cancelText = "Cancelar") {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-dialog-modal");
    const titleEl = document.getElementById("custom-dialog-title");
    const msgEl = document.getElementById("custom-dialog-msg");
    const okBtn = document.getElementById("custom-dialog-ok-btn");
    const cancelBtn = document.getElementById("custom-dialog-cancel-btn");
    const iconContainer = document.getElementById("custom-dialog-icon-container");

    if (!modal) {
      resolve(false);
      return;
    }

    titleEl.textContent = title;
    if (typeof message === "string" && message.includes("<")) {
      msgEl.innerHTML = message;
    } else {
      msgEl.textContent = message;
    }
    cancelBtn.textContent = cancelText;
    cancelBtn.classList.remove("hidden");
    okBtn.textContent = confirmText;
    okBtn.className = "px-5 py-2 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-xl transition shadow";
    iconContainer.className = "w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-xl text-amber-400";

    const handleKeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        handleOk();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      }
    };

    const handleOk = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
      cancelBtn.removeEventListener("click", handleCancel);
      window.removeEventListener("keydown", handleKeydown, true);
    };

    okBtn.addEventListener("click", handleOk, { once: true });
    cancelBtn.addEventListener("click", handleCancel, { once: true });
    window.addEventListener("keydown", handleKeydown, true);
    modal.classList.remove("hidden");
    okBtn.focus();
    lucide.createIcons();
  });
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
    showCustomAlert(`Já existe um jogador cadastrado com o nome "${name}".`, "Jogador Duplicado");
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
    "Limpar Lista"
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
    <div ${isLeader ? `draggable="true" data-drag-kind="player" data-player-id="${p.id}" ondragstart="onPlayerDragStart(event, '${p.id}')" ondragend="onDragEnd()" title="Arraste para um time"` : ''} class="flex items-center justify-between p-2.5 bg-card/60 hover:bg-card border border-borderLight/40 rounded-xl transition ${isLeader ? 'cursor-grab active:cursor-grabbing select-none' : ''}">
      <div class="flex items-center space-x-2.5 min-w-0">
        ${isLeader ? '<i data-lucide="grip-vertical" class="w-3.5 h-3.5 text-slate-600 shrink-0"></i>' : ''}
        <span class="text-xs font-bold text-slate-500 w-5 text-center">${idx + 1}</span>
        ${isLeader ? `
          <button type="button" onclick="togglePlayerRole('${p.id}')" title="Clique para alternar entre LIN e GK" class="focus:outline-none transition-transform active:scale-90 cursor-pointer">
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
        <span class="text-sm font-semibold text-white truncate">${escapeHtml(p.name)}</span>
        ${isLeader ? `
          <button type="button" onclick="cyclePlayerLevel('${p.id}')" title="Clique para alterar nível (1 a 5 estrelas)" class="focus:outline-none hover:scale-105 active:scale-95 transition-transform cursor-pointer flex items-center px-1 py-0.5 rounded hover:bg-slate-800/60">
            <span class="text-amber-400 text-xs tracking-tighter select-none">${"★".repeat(p.level)}${"☆".repeat(5 - p.level)}</span>
          </button>
        ` : `
          <span class="text-amber-400 text-xs tracking-tighter select-none px-1">${"★".repeat(p.level)}${"☆".repeat(5 - p.level)}</span>
        `}
      </div>
      ${isLeader ? `
        <button onclick="removePlayer('${p.id}')" class="text-slate-500 hover:text-rose-400 p-1 transition" title="Remover jogador">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      ` : ''}
    </div>
  `).join("");

  sincronizarEstadoServidor();
  lucide.createIcons();
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
    await showCustomAlert("Ocorreu um erro ao realizar o sorteio dos times.", "Erro no Sorteio");
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
    await showCustomAlert(`Os jogadores abaixo ainda não estão em nenhum time:<br>${lista}`, "Jogadores sem Time");
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
      <button type="button" onclick="adicionarTimeManual()" class="md:col-span-2 w-full text-center py-16 border-2 border-dashed border-borderLight rounded-2xl text-slate-500 space-y-3 hover:border-neon-accent/60 hover:text-slate-300 transition cursor-pointer">
        <i data-lucide="users-2" class="w-12 h-12 mx-auto stroke-1 text-slate-600"></i>
        <p class="text-sm">Clique <strong class="text-neon-accent">aqui</strong> para criar os times</p>
      </button>
    ` : `
      <div class="md:col-span-2 text-center py-16 border-2 border-dashed border-borderLight rounded-2xl text-slate-500 space-y-3">
        <i data-lucide="users-2" class="w-12 h-12 mx-auto stroke-1 text-slate-600"></i>
        <p class="text-sm">Nenhum time montado ainda.</p>
      </div>
    `;
    lucide.createIcons();
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
      data-drag-kind="team" data-team-id="${t.id}"
      ondragstart="onTeamDragStart(event, '${t.id}')"
      ondragend="onDragEnd()"
      ondragover="onCardDragOver(event, '${t.id}')"
      ondragleave="onCardDragLeave(event)"
      ondrop="onCardDrop(event, '${t.id}')"
      title="Arraste para trocar de posição com outro time"` : '';

    return `
      <div id="team-card-${t.id}" data-team-card ${dragAttrs} class="bg-card border border-borderLight rounded-2xl p-5 space-y-3.5 relative overflow-hidden transition hover:border-slate-500 ${isLeader ? 'cursor-grab active:cursor-grabbing select-none' : ''}">
        <!-- Barra de Cor no Topo -->
        <div class="absolute top-0 left-0 right-0 h-1.5" style="background-color: ${cor}"></div>

        <div class="flex items-center justify-between pt-1">
          <div class="flex items-center space-x-2.5 min-w-0">
            ${isLeader ? `
              <button type="button" onclick="abrirSeletorCor(event, '${t.id}')" title="Clique para escolher a cor do time" class="w-3.5 h-3.5 rounded-full shadow shrink-0 hover:scale-125 transition cursor-pointer" style="background-color: ${cor}"></button>
            ` : `
              <span class="w-3.5 h-3.5 rounded-full shadow shrink-0" style="background-color: ${cor}"></span>
            `}
            <h4 id="nome-time-${t.id}" ${isLeader ? `ondblclick="editarNomeTime('${t.id}')" title="Clique duas vezes para renomear" class="font-extrabold text-base truncate cursor-text"` : `class="font-extrabold text-base truncate"`} style="color: ${cor};">${escapeHtml(t.name)}</h4>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <div class="text-[11px] font-bold text-slate-400 bg-pitch px-2 py-0.5 rounded-lg border border-borderLight" title="Força média do time">
              ★ ${avgStars} / 5.0
            </div>
            ${isLeader ? `
              <button type="button" onclick="removerTime('${t.id}')" title="Excluir time" aria-label="Excluir time" class="w-8 h-8 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
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
                  <button type="button" onclick="removerJogadorDoTime('${p.id}', '${t.id}')" title="Tirar do time" class="text-slate-500 hover:text-rose-400 transition">
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

  lucide.createIcons();
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
  event.currentTarget.classList.add('ring-2', 'ring-neon-accent');
}

function onCardDragLeave(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return;
  event.currentTarget.classList.remove('ring-2', 'ring-neon-accent');
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
// ARRASTAR POR TOQUE (CELULAR)
// ==============================
// O toque só arrasta após ~250 ms pressionado; se o dedo se mover antes, vira rolagem normal.
let arrasteToque = null;

// No toque, desliga o arrasto nativo do navegador (o mouse continua com HTML5 DnD)
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-drag-kind]');
  if (el) el.draggable = e.pointerType === 'mouse';
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
    id: kind === 'player' ? el.dataset.playerId : el.dataset.teamId,
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

  // Time sob o dedo (o fantasma não recebe eventos)
  const card = document.elementFromPoint(t.clientX, t.clientY)?.closest('[data-team-card]') || null;
  const valido = card && !(a.kind === 'team' && card.dataset.teamId === a.id) ? card : null;
  if (a.alvo !== valido) {
    a.alvo?.classList.remove('ring-2', 'ring-neon-accent');
    valido?.classList.add('ring-2', 'ring-neon-accent');
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
  if (kind === 'team') trocarPosicaoTimes(id, alvo.dataset.teamId);
  else adicionarJogadorAoTime(id, alvo.dataset.teamId);
}

function cancelarArrasteToque() {
  const a = arrasteToque;
  if (!a) return;
  clearTimeout(a.timer);
  a.ghost?.remove();
  a.el.classList.remove('opacity-40');
  a.alvo?.classList.remove('ring-2', 'ring-neon-accent');
  if (a.ativo) dragState = null;
  arrasteToque = null;
}

document.addEventListener('touchend', finalizarArrasteToque, { passive: false });
document.addEventListener('touchcancel', cancelarArrasteToque);

function adicionarTimeManual() {
  if (state.role !== 'admin') return;

  // Usa a primeira cor da paleta que ainda não está em uso
  const coresUsadas = new Set(state.teams.map(t => (t.color || '').toLowerCase()));
  const paleta = DEFAULT_TEAM_PALETTE.find(p => !coresUsadas.has(p.color.toLowerCase()))
    || DEFAULT_TEAM_PALETTE[state.teams.length % DEFAULT_TEAM_PALETTE.length];

  const base = `Time ${paleta.name.replace('Colete ', '')}`;
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
  const confirmed = await showCustomConfirm(
    `Remover o time "${time.name}"? Os jogadores continuam na lista.`,
    "Remover Time",
    "Remover",
    "Cancelar"
  );
  if (!confirmed) return;
  state.teams = state.teams.filter(t => t.id !== teamId);
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

function trocarCorTime(teamId, cor) {
  const time = state.teams.find(t => t.id === teamId);
  if (!time || !cor) return;
  time.color = cor;
  renderTeamsGrid();
  sincronizarEstadoServidor();
}

// Seletor de cor: só as cores da DEFAULT_TEAM_PALETTE
let seletorCorTeamId = null;

function abrirSeletorCor(event, teamId) {
  event.stopPropagation();
  const botao = event.currentTarget;
  const time = state.teams.find(t => t.id === teamId);
  if (!time) return;
  fecharSeletorCor();
  seletorCorTeamId = teamId;

  const pop = document.createElement('div');
  pop.id = 'seletor-cor-time';
  pop.className = 'fixed z-[60] flex items-center gap-2 p-2 bg-slate-900/95 backdrop-blur border border-borderLight rounded-xl shadow-2xl';
  pop.innerHTML = DEFAULT_TEAM_PALETTE.map(p => {
    const selecionada = (time.color || '').toLowerCase() === p.color.toLowerCase();
    return `<button type="button" title="${p.name.replace('Colete ', '')}" onclick="escolherCorTime('${p.color}')" class="w-6 h-6 rounded-full transition hover:scale-110 ${selecionada ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900' : ''}" style="background-color: ${p.color}"></button>`;
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
  if (state.teams.length < 2) {
    await showCustomAlert("Você precisa sortear pelo menos 2 times primeiro!", "Times Insuficientes");
    return;
  }

  // Se já houver partidas geradas na tabela, exige confirmação para recriar
  if (state.fixtures && state.fixtures.length > 0) {
    const confirmed = await showCustomConfirm(
      "Deseja realmente recriar a tabela de confrontos? Todos os placares e eventos atuais serão substituídos.",
      "Recriar Tabela",
      "Recriar Tabela",
      "Cancelar"
    );
    if (!confirmed) return;
  }

  // Se o formato configurado for "Livre" e ainda não houver partidas
  if (state.config.championship_type === "custom") {
    switchTab("fixtures");
    if (state.fixtures.length === 0) {
      abrirModalNovaPartida();
      showToast("Modo Livre: adicione as rodadas e partidas desejadas!");
    } else {
      renderFixtures();
    }
    return;
  }

  try {
    const res = await fetch("/api/generate-schedule", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        teams: state.teams,
        rounds: state.config.total_rounds || 1
      })
    });
    const fixtures = await res.json();
    state.fixtures = fixtures;

    renderFixtures();
    sincronizarEstadoServidor();
    switchTab("fixtures");
    showToast(`${fixtures.length} confrontos agendados!`);
  } catch (err) {
    console.error(err);
    await showCustomAlert("Erro ao gerar tabela de confrontos.", "Erro no Agendamento");
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
    return `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''} style="color: ${teamColor}; background-color: #111827; font-weight: 700;">● ${escapeHtml(t.name)}</option>`;
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

  const modal = document.getElementById("modal-custom-match");
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  const roundInput = document.getElementById("custom-match-round");

  if (!modal || !homeSelect || !awaySelect || !roundInput) return;

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

  modal.classList.remove("hidden");
  lucide.createIcons();
}

function fecharModalNovaPartida() {
  document.getElementById("modal-custom-match")?.classList.add("hidden");
}

function salvarNovaPartidaLivre(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const roundNum = Math.max(1, parseInt(document.getElementById("custom-match-round").value) || 1);
  const homeId = document.getElementById("custom-match-home").value;
  const awayId = document.getElementById("custom-match-away").value;

  if (homeId === awayId) {
    showCustomAlert("O time mandante e o visitante não podem ser o mesmo!", "Times Iguais");
    return;
  }

  const homeTeam = state.teams.find(t => t.id === homeId);
  const awayTeam = state.teams.find(t => t.id === awayId);

  if (!homeTeam || !awayTeam) {
    showCustomAlert("Times selecionados não foram encontrados.", "Erro");
    return;
  }

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

  fecharModalNovaPartida();
  renderFixtures();
  sincronizarEstadoServidor();
  showToast(`Partida adicionada à Rodada ${roundNum}!`);
}

async function removerPartidaCustomizada(matchId) {
  const match = state.fixtures.find(m => m.id === matchId);
  if (!match) return;

  const homeBadge = renderTeamBadge(match.home_team_name, match.home_team_id);
  const awayBadge = renderTeamBadge(match.away_team_name, match.away_team_id);
  const confirmed = await showCustomConfirm(
    `Deseja realmente remover a partida "${homeBadge} x ${awayBadge}" da tabela?`,
    "Remover Partida",
    "Sim, Remover"
  );
  if (!confirmed) return;

  // Se a partida estava salva no banco, remove também da persistência
  if (match.finished) {
    try {
      const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
      const deleteUrl = pCode ? `/api/matches/${matchId}?pelada_code=${pCode}` : `/api/matches/${matchId}`;
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
    `Deseja realmente remover todas as rodadas e confrontos (${totalJogos} ${totalJogos === 1 ? 'partida' : 'partidas'})? Os confrontos ativos serão excluídos da tabela.`,
    "Remover Todas as Rodadas",
    "Sim, Remover Tudo",
    "Cancelar"
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

function renderFixtures() {
  const container = document.getElementById("fixtures-container");
  const badge = document.getElementById("badge-pending-matches");
  const badgeMobile = document.getElementById("badge-pending-matches-mobile");
  if (!container) return;

  const pending = state.fixtures.filter(m => !m.finished).length;
  if (badge) {
    badge.textContent = pending;
    badge.classList.toggle("hidden", pending === 0);
  }
  if (badgeMobile) {
    badgeMobile.textContent = pending;
    badgeMobile.classList.toggle("hidden", pending === 0);
  }

  if (state.fixtures.length === 0) {
    const isCustom = state.config.championship_type === "custom";
    const isLeader = state.role === 'admin';
    if (isLeader) {
      // Área clicável: cria a primeira partida (livre) ou gera os confrontos (preset)
      const acao = isCustom ? 'abrirModalNovaPartida()' : 'gerarTabelaConfrontos()';
      const texto = isCustom
        ? 'Clique <strong class="text-neon-accent">aqui</strong> para criar a primeira partida'
        : 'Sorteie os times e clique <strong class="text-neon-accent">aqui</strong> para gerar os confrontos';
      container.innerHTML = `
        <button type="button" onclick="${acao}" class="w-full bg-surface border-2 border-dashed border-borderLight hover:border-neon-accent/60 rounded-3xl p-12 text-center text-slate-500 hover:text-slate-300 space-y-3 transition cursor-pointer">
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
    lucide.createIcons();
    return;
  }

  // Agrupa por Rodada
  const roundsMap = {};
  state.fixtures.forEach(m => {
    if (!roundsMap[m.round_number]) roundsMap[m.round_number] = [];
    roundsMap[m.round_number].push(m);
  });

  const isCustomMode = state.config.championship_type === "custom";
  const isLeader = state.role === 'admin';

  let html = "";
  for (const [roundNum, matches] of Object.entries(roundsMap)) {
    html += `
      <div class="space-y-3">
        <div class="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
          <div class="flex items-center space-x-2">
            <i data-lucide="layers" class="w-4 h-4 text-emerald-400"></i>
            <span>Rodada ${roundNum}</span>
          </div>
          ${isCustomMode && isLeader ? `
            <button onclick="abrirModalNovaPartida(${roundNum})" class="text-[11px] text-neon-accent hover:underline flex items-center gap-1 font-semibold normal-case">
              <i data-lucide="plus" class="w-3 h-3"></i>
              <span>Jogo na Rodada ${roundNum}</span>
            </button>
          ` : ''}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${matches.map(m => renderSingleMatchCard(m)).join("")}
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  lucide.createIcons();

  // Inicia o tick se houver partidas com cronômetro em execução
  const hasRunningTimer = (state.fixtures || []).some(m => !m.finished && m.timer_status === 'running');
  if (hasRunningTimer) {
    startGlobalMatchTimerTick();
  }
}

function renderSingleMatchCard(m) {
  const isFinished = m.finished;
  const isCustomMode = state.config.championship_type === "custom";
  const isLeader = state.role === 'admin';
  const homeColor = getTeamColor(m.home_team_id || m.home_team_name);
  const awayColor = getTeamColor(m.away_team_id || m.away_team_name);
  
  return `
    <div id="match-card-${m.id}" class="bg-surface border ${isFinished ? 'border-borderLight/40 opacity-90' : 'border-borderLight hover:border-emerald-500/50'} rounded-3xl p-5 space-y-4 transition shadow-lg relative overflow-hidden">
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
        <div class="flex-1 text-center space-y-2">
          <h4 class="font-extrabold text-sm sm:text-base truncate" style="color: ${homeColor};">${escapeHtml(m.home_team_name)}</h4>
          ${(!isFinished && isLeader) ? `
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="adjustScore('${m.id}', 'home', -1)" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-slate-700 text-slate-300 font-bold text-xs transition">-</button>
              <span id="score-home-${m.id}" class="text-2xl font-black text-white w-8">${m.home_score}</span>
              <button onclick="adjustScore('${m.id}', 'home', 1)" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-neon-accent hover:text-black font-bold text-xs transition">+</button>
            </div>
          ` : `
            <div class="text-3xl font-black text-white">${m.home_score}</div>
          `}
        </div>

        <!-- Divisor VS Interativo com Cronômetro -->
        <div class="text-center px-1 sm:px-2 flex flex-col items-center justify-center select-none shrink-0 overflow-visible translate-y-1">
          <button 
            type="button"
            ${(!isFinished && isLeader) ? `onclick="toggleMatchTimer('${m.id}')"` : ''}
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
        <div class="flex-1 text-center space-y-2">
          <h4 class="font-extrabold text-sm sm:text-base truncate" style="color: ${awayColor};">${escapeHtml(m.away_team_name)}</h4>
          ${(!isFinished && isLeader) ? `
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="adjustScore('${m.id}', 'away', -1)" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-slate-700 text-slate-300 font-bold text-xs transition">-</button>
              <span id="score-away-${m.id}" class="text-2xl font-black text-white w-8">${m.away_score}</span>
              <button onclick="adjustScore('${m.id}', 'away', 1)" class="w-7 h-7 rounded-lg bg-cardLight hover:bg-neon-accent hover:text-black font-bold text-xs transition">+</button>
            </div>
          ` : `
            <div class="text-3xl font-black text-white">${m.away_score}</div>
          `}
        </div>

      </div>
      
      <!-- Linha do Cronômetro Regressivo e Início de Partida -->
      ${m.started_at ? `
        <div class="flex items-center justify-center gap-2 pt-1 pb-0.5 text-xs">
          <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-pitch/80 border border-borderLight shadow-inner text-slate-300">
            <span class="text-[11px] text-slate-400">Partida iniciada em <strong class="text-white font-mono">${escapeHtml(m.started_at)}</strong></span>
            ${!isFinished ? `
              <span class="w-1.5 h-1.5 rounded-full ${m.timer_status === 'running' ? 'bg-emerald-400 animate-pulse' : (m.timer_status === 'paused' ? 'bg-amber-400' : 'bg-slate-500')}"></span>
              <span id="match-timer-${m.id}" class="font-mono font-black text-xs ${m.timer_status === 'running' ? 'text-emerald-400' : (m.timer_status === 'paused' ? 'text-amber-400' : 'text-slate-300')}">
                ${formatMatchRemainingTime(m)}
              </span>
              ${m.timer_status === 'paused' ? `
                <span class="text-[10px] uppercase tracking-wider font-bold text-amber-400/80 bg-amber-500/10 px-1.5 py-0.2 rounded">Pausado</span>
                ${isLeader ? `
                  <button 
                    type="button" 
                    onclick="removerInicioPartida('${m.id}')" 
                    title="Descartar início da partida" 
                    aria-label="Descartar início da partida" 
                    class="w-4 h-4 rounded-full bg-rose-500/20 hover:bg-rose-500 text-rose-400 hover:text-white flex items-center justify-center transition active:scale-95 ml-0.5">
                    <i data-lucide="x" class="w-3 h-3 stroke-[2.5]"></i>
                  </button>
                ` : ''}
              ` : ''}
            ` : ''}
          </span>
        </div>
      ` : ''}

      <!-- Atribuição rápida de gols aos atletas -->
      ${!isFinished ? `
        <div class="pt-2 border-t border-borderLight/40 flex items-center justify-between text-xs">
          ${isLeader ? `
            <button onclick="abrirAtribuicaoGols('${m.id}')" class="text-slate-400 hover:text-neon-accent flex items-center gap-1 transition">
              <i data-lucide="user-check" class="w-3.5 h-3.5"></i>
              <span>Quem fez os gols? (${m.events ? m.events.length : 0})</span>
            </button>
            <div class="flex items-center gap-2">
              <button onclick="removerPartidaCustomizada('${m.id}')" title="Excluir Partida" aria-label="Excluir Partida" class="w-8 h-8 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 font-semibold rounded-xl transition flex items-center justify-center active:scale-95">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
              <button onclick="salvarPartidaFinalizada('${m.id}')" title="Salvar Resultado" aria-label="Salvar Resultado" class="w-8 h-8 bg-neon-accent hover:bg-emerald-400 text-black font-extrabold rounded-xl transition shadow flex items-center justify-center active:scale-95">
                <i data-lucide="save" class="w-4 h-4"></i>
              </button>
            </div>
          ` : `
            <span class="text-[11px] text-slate-500 flex items-center gap-1">
              <i data-lucide="clock" class="w-3.5 h-3.5 text-amber-400"></i> Partida em andamento
            </span>
            <span class="text-[11px] text-slate-400">${m.events ? m.events.length : 0} gols registrados</span>
          `}
        </div>
      ` : `
        <div class="pt-2 border-t border-borderLight/30 flex items-center justify-between text-xs text-slate-400">
          <button onclick="verDetalhesPartida('${m.id}')" class="text-neon-accent hover:underline flex items-center gap-1">
            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
            <span>Ver detalhes</span>
          </button>
          ${isLeader ? `
            <button onclick="reabrirPartida('${m.id}')" class="px-3 py-1.5 bg-cardLight hover:bg-amber-400 hover:text-black text-amber-400 font-bold rounded-xl transition flex items-center gap-1 text-xs active:scale-95">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
              <span>Editar Partida</span>
            </button>
          ` : ''}
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
        const alarmFile = (state.config && state.config.alarm_sound) ? state.config.alarm_sound : 'standard-emergency-warning-signal.mp3';
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
    window.lucide.createIcons();
  }
}

function pararPreviewAlarme() {
  if (window.SoundManager && typeof window.SoundManager.stopPreview === 'function') {
    window.SoundManager.stopPreview();
  }
  atualizarBotaoPreviewAlarme(false);
}

function aoMudarSomAlarme() {
  pararPreviewAlarme();
  autoSalvarConfiguracoes();
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

function adjustScore(matchId, side, delta) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m || m.finished) return;

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

  const modal = document.getElementById("modal-match-details");
  const content = document.getElementById("modal-content");
  if (!modal || !content) return;

  renderConteudoAtribuicaoGols(matchId);
  modal.classList.remove("hidden");
  lucide.createIcons();
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
          <span style="color: ${homeColor};">${escapeHtml(m.home_team_name)}</span>
          <span class="text-white">${m.home_score} x ${m.away_score}</span>
          <span style="color: ${awayColor};">${escapeHtml(m.away_team_name)}</span>
        </span>
      </div>
      <p class="text-xs text-slate-400 mt-1">Distribua os gols marcados no placar entre os atletas de cada equipe:</p>
      
      <!-- Status de Gols por Time -->
      <div class="grid grid-cols-2 gap-2 mt-3">
        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="font-bold truncate" style="color: ${homeColor};">${escapeHtml(m.home_team_name)}</div>
          <div class="flex items-center justify-between mt-1 text-[11px]">
            <span class="text-slate-400">Atribuídos: <strong class="text-white">${homeGoalsAssigned}/${m.home_score}</strong></span>
            ${homeRemaining === 0 ? '<span class="text-emerald-400 font-bold">✓ Completo</span>' : `<span class="text-amber-400 font-bold">Faltam ${homeRemaining}</span>`}
          </div>
        </div>

        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="font-bold truncate" style="color: ${awayColor};">${escapeHtml(m.away_team_name)}</div>
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
        <div class="text-[11px] font-bold uppercase tracking-wider flex items-center justify-between" style="color: ${homeColor};">
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
                  <button onclick="removerGolJogador('${m.id}', '${p.id}')" class="w-6 h-6 rounded-lg bg-cardLight hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 font-bold transition flex items-center justify-center text-xs">-</button>
                ` : ''}
                <button onclick="adicionarGolJogador('${m.id}', '${p.id}', '${escapeHtml(p.name)}')" ${!canAdd ? 'disabled' : ''} class="px-2.5 py-1 ${canAdd ? 'bg-cardLight hover:bg-neon-accent hover:text-black text-white' : 'bg-cardLight/40 text-slate-600 cursor-not-allowed'} font-bold rounded-lg transition text-xs">+ Gol</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <!-- Time Visitante -->
      <div class="space-y-1.5 pt-2 border-t border-borderLight/40">
        <div class="text-[11px] font-bold uppercase tracking-wider flex items-center justify-between" style="color: ${awayColor};">
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
                  <button onclick="removerGolJogador('${m.id}', '${p.id}')" class="w-6 h-6 rounded-lg bg-cardLight hover:bg-rose-500/20 hover:text-rose-400 text-slate-400 font-bold transition flex items-center justify-center text-xs">-</button>
                ` : ''}
                <button onclick="adicionarGolJogador('${m.id}', '${p.id}', '${escapeHtml(p.name)}')" ${!canAdd ? 'disabled' : ''} class="px-2.5 py-1 ${canAdd ? 'bg-cardLight hover:bg-neon-accent hover:text-black text-white' : 'bg-cardLight/40 text-slate-600 cursor-not-allowed'} font-bold rounded-lg transition text-xs">+ Gol</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>

    <div class="pt-3 border-t border-borderLight flex items-center justify-between">
      <span class="text-[11px] text-slate-400">Total: ${m.events.length} de ${totalGoalsInScore} gols atribuídos</span>
      <button onclick="concluirAtribuicaoGols('${m.id}')" class="px-5 py-2 bg-neon-accent text-black font-extrabold text-xs rounded-xl shadow">Concluir</button>
    </div>
  `;
}

function adicionarGolJogador(matchId, playerId, playerName) {
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;
  if (!m.events) m.events = [];

  const homePlayerIds = new Set((m.home_players || []).map(p => p.id));
  const awayPlayerIds = new Set((m.away_players || []).map(p => p.id));

  const isHome = homePlayerIds.has(playerId);
  const isAway = awayPlayerIds.has(playerId);

  const homeGoalsAssigned = m.events.filter(e => homePlayerIds.has(e.player_id) && e.event_type === "goal").length;
  const awayGoalsAssigned = m.events.filter(e => awayPlayerIds.has(e.player_id) && e.event_type === "goal").length;

  if (isHome) {
    const homeBadge = renderTeamBadge(m.home_team_name, m.home_team_id);
    if (m.home_score === 0) {
      showToast(`${homeBadge} está com 0 gols no placar!`);
      return;
    }
    if (homeGoalsAssigned >= m.home_score) {
      showToast(`Limite de gols atingido para ${homeBadge} (${m.home_score} gols)`);
      return;
    }
  } else if (isAway) {
    const awayBadge = renderTeamBadge(m.away_team_name, m.away_team_id);
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
  lucide.createIcons();

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
  lucide.createIcons();

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

  const homeBadge = renderTeamBadge(m.home_team_name, m.home_team_id);
  const awayBadge = renderTeamBadge(m.away_team_name, m.away_team_id);
  const confirmed = await showCustomConfirm(
    `Deseja reabrir a partida "${homeBadge} x ${awayBadge}" para edição? O resultado será recalculado quando você salvar novamente.`,
    "Editar Partida",
    "Reabrir para Edição",
    "Cancelar"
  );
  if (!confirmed) return;

  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const deleteUrl = pCode ? `/api/matches/${matchId}?pelada_code=${pCode}` : `/api/matches/${matchId}`;
    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: getAuthHeaders()
    });

    if (res.ok) {
      m.finished = false;
      renderFixtures();
      sincronizarEstadoServidor();
      await atualizarDashboard();
      showToast("Partida reaberta para edição!");
    } else {
      throw new Error("Erro ao reabrir partida");
    }
  } catch (err) {
    console.error(err);
    await showCustomAlert("Não foi possível reabrir a partida para edição.", "Erro");
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

  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const saveUrl = pCode ? `/api/matches/save?pelada_code=${pCode}` : "/api/matches/save";
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
    m.played_at = data.match.played_at;
    m.timer_status = 'stopped';

    renderFixtures();
    sincronizarEstadoServidor();
    await atualizarDashboard();
    const homeBadge = renderTeamBadge(m.home_team_name, m.home_team_id);
    const awayBadge = renderTeamBadge(m.away_team_name, m.away_team_id);
    showToast(`Resultado salvo! ${homeBadge} ${m.home_score} x ${m.away_score} ${awayBadge}`);
  } catch (err) {
    console.error(err);
    await showCustomAlert(err.message || "Falha ao salvar a partida.", "Erro na Gravação");
  }
}

// ==============================
// DASHBOARD & HISTÓRICO SQLITE
// ==============================
async function atualizarDashboard() {
  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const url = pCode ? `/api/dashboard?pelada_code=${pCode}` : "/api/dashboard";
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
          <span style="color: ${teamColor};">${escapeHtml(t.name)}</span>
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
  lucide.createIcons();
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
  if (window.lucide) lucide.createIcons();
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
        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="onToggleChartPlayerCheckbox('${pid}', this.checked)" class="rounded border-borderLight text-neon-accent focus:ring-0 cursor-pointer accent-[#00f59b]">
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
  if (window.lucide) lucide.createIcons();
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
            <span class="flex items-center gap-1.5" style="color: ${homeColor};">
              ${m.winner_team_id === m.home_team_id ? '<span class="text-xs" title="Vencedor">🏆</span>' : ''}
              ${escapeHtml(m.home_team_name)}
            </span>
            <span class="px-2.5 py-0.5 rounded-lg bg-pitch border border-borderLight text-white font-black text-sm">${m.home_score} - ${m.away_score}</span>
            <span class="flex items-center gap-1.5" style="color: ${awayColor};">
              ${m.winner_team_id === m.away_team_id ? '<span class="text-xs" title="Vencedor">🏆</span>' : ''}
              ${escapeHtml(m.away_team_name)}
            </span>
          </div>
        </div>

        <button onclick="verDetalhesPartida('${m.id}')" class="text-xs px-3 py-2 bg-surface hover:bg-card border border-borderLight rounded-xl text-slate-300 hover:text-white transition flex items-center justify-center gap-1.5 self-start md:self-auto">
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
  lucide.createIcons();
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
    lucide.createIcons();
    isHistorySliding = false;
    updateHistoryPaginationUI();
  }, 460);
}

async function verDetalhesPartida(matchId) {
  // Procura no estado local ou busca do backend
  let match = state.fixtures.find(m => m.id === matchId);

  if (!match) {
    try {
      const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
      const url = pCode ? `/api/matches?pelada_code=${pCode}` : "/api/matches";
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

  const modal = document.getElementById("modal-match-details");
  const content = document.getElementById("modal-content");
  if (!modal || !content) return;

  const isHomeWinner = !match.is_draw && match.winner_team_id === match.home_team_id;
  const isAwayWinner = !match.is_draw && match.winner_team_id === match.away_team_id;
  const isHomeLoser = !match.is_draw && match.finished && match.winner_team_id && match.winner_team_id === match.away_team_id;
  const isAwayLoser = !match.is_draw && match.finished && match.winner_team_id && match.winner_team_id === match.home_team_id;
  const homeColor = getTeamColor(match.home_team_id || match.home_team_name);
  const awayColor = getTeamColor(match.away_team_id || match.away_team_name);
  const winnerColor = isHomeWinner ? homeColor : (isAwayWinner ? awayColor : '#38bdf8');

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

  const renderPlayerItem = (p) => {
    const pName = typeof p === 'string' ? p : p.name;
    const pId = typeof p === 'object' && p.id ? p.id : null;
    const countById = pId && playerGoalsCount[pId] !== undefined ? playerGoalsCount[pId] : 0;
    const countByName = pName && playerGoalsCount[pName.toLowerCase().trim()] !== undefined ? playerGoalsCount[pName.toLowerCase().trim()] : 0;
    const count = Math.max(countById, countByName);
    const balls = count > 0 ? ` <span class="inline-flex items-center gap-0.5 ml-1 text-base select-none">${'⚽'.repeat(count)}</span>` : '';

    return `
      <li class="flex items-center justify-between py-1 px-1.5 rounded-lg hover:bg-surface/50 transition">
        <span class="font-medium text-slate-200 text-sm md:text-base">• ${escapeHtml(pName)}</span>
        ${balls}
      </li>
    `;
  };

  content.innerHTML = `
    <div>
      <div class="flex items-center gap-2 text-sm text-slate-400">
        <span class="font-semibold text-slate-300">Partida Rodada ${match.round_number}</span>
        <span>•</span>
        <span class="text-emerald-400 font-bold">${match.played_at || ''} (Horário de Brasília)</span>
      </div>
      <h3 class="text-2xl md:text-3xl font-black mt-2 flex items-center gap-2.5 flex-wrap">
        <span style="color: ${homeColor};">${escapeHtml(match.home_team_name)}</span>
        <span class="text-white bg-pitch px-3 py-1 rounded-xl border border-borderLight text-lg md:text-xl font-black">${match.home_score} x ${match.away_score}</span>
        <span style="color: ${awayColor};">${escapeHtml(match.away_team_name)}</span>
      </h3>
      <p class="text-sm md:text-base text-slate-300 mt-2 font-medium">
        ${match.is_draw ? 'Empate registrado' : `Vencedor: 🏆 <span class="font-black text-base md:text-lg" style="color: ${winnerColor};">${escapeHtml(isHomeWinner ? match.home_team_name : match.away_team_name)}</span>`}
      </p>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm pt-2">
      <!-- Elenco Mandante -->
      <div class="space-y-2 bg-card p-4 rounded-2xl border ${
        isHomeWinner
          ? 'border-emerald-500/40 bg-emerald-950/20'
          : isHomeLoser
          ? 'border-rose-500/40 bg-rose-950/20'
          : 'border-borderLight'
      }">
        <h4 class="font-bold text-base md:text-lg flex items-center justify-between pb-1 border-b border-borderLight/40">
          <span style="color: ${homeColor};">${escapeHtml(match.home_team_name)}</span>
          ${isHomeWinner ? '<span class="text-xs text-emerald-400 font-extrabold uppercase bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">Venceu</span>' : ''}
          ${isHomeLoser ? '<span class="text-xs text-rose-400 font-extrabold uppercase bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">Perdeu</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-200">
          ${(match.home_players || []).map(renderPlayerItem).join("")}
        </ul>
      </div>

      <!-- Elenco Visitante -->
      <div class="space-y-2 bg-card p-4 rounded-2xl border ${
        isAwayWinner
          ? 'border-emerald-500/40 bg-emerald-950/20'
          : isAwayLoser
          ? 'border-rose-500/40 bg-rose-950/20'
          : 'border-borderLight'
      }">
        <h4 class="font-bold text-base md:text-lg flex items-center justify-between pb-1 border-b border-borderLight/40">
          <span style="color: ${awayColor};">${escapeHtml(match.away_team_name)}</span>
          ${isAwayWinner ? '<span class="text-xs text-emerald-400 font-extrabold uppercase bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">Venceu</span>' : ''}
          ${isAwayLoser ? '<span class="text-xs text-rose-400 font-extrabold uppercase bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">Perdeu</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-200">
          ${(match.away_players || []).map(renderPlayerItem).join("")}
        </ul>
      </div>
    </div>

    <div class="pt-3 border-t border-borderLight flex justify-end">
      <button onclick="closeModal()" class="px-5 py-2.5 bg-cardLight hover:bg-slate-700 text-white font-bold text-sm md:text-base rounded-xl transition">Fechar</button>
    </div>
  `;

  modal.classList.remove("hidden");
  lucide.createIcons();
}

function closeModal() {
  document.getElementById("modal-match-details")?.classList.add("hidden");
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
    "Limpar Histórico"
  );
  if (!confirmed) return;

  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const url = pCode ? `/api/matches?pelada_code=${pCode}` : "/api/matches";
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
    const elAlarmSound = document.getElementById("cfg-alarm-sound");

    if (elPerTeam) elPerTeam.value = cfg.players_per_team;
    if (elDuration) elDuration.value = cfg.match_duration_minutes;
    if (elAlarmSound && cfg.alarm_sound) elAlarmSound.value = cfg.alarm_sound;
    if (elRounds) {
      if (cfg.championship_type) {
        elRounds.value = cfg.championship_type;
      } else {
        elRounds.value = cfg.total_rounds === 2 ? "double" : "single";
      }
    }
    atualizarVisibilidadeControlesFormato();
  } catch (e) {
    console.warn("Usando configurações padrão.");
  }
}

function atualizarVisibilidadeControlesFormato() {
  const isCustom = state.config.championship_type === "custom";
  const isLeader = state.role === "admin";
  const btnAdd = document.getElementById("btn-add-custom-match");
  const btnRecreate = document.getElementById("btn-recreate-fixtures");
  const actionLabel = document.getElementById("btn-fixtures-action-label");

  if (btnAdd) {
    btnAdd.classList.toggle("hidden", !isCustom || !isLeader);
  }
  const actionTitle = isCustom ? "Recriar Auto" : "Recriar Tabela";
  if (btnRecreate) {
    btnRecreate.title = actionTitle;
    btnRecreate.setAttribute("aria-label", actionTitle);
  }
  if (actionLabel) {
    actionLabel.textContent = actionTitle;
  }
}

let autoSaveConfigTimeout = null;

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
  const alarmSoundInput = document.getElementById("cfg-alarm-sound");

  if (!perTeamInput || !durationInput || !roundsInput) return;

  let perTeam = parseInt(perTeamInput.value, 10);
  let duration = parseInt(durationInput.value, 10);
  const selectedFormat = roundsInput.value;
  const selectedAlarm = alarmSoundInput ? alarmSoundInput.value : (state.config.alarm_sound || "standard-emergency-warning-signal.mp3");

  if (isNaN(perTeam) || perTeam < 2) perTeam = 5;
  if (perTeam > 11) perTeam = 11;

  if (isNaN(duration) || duration < 1) duration = 10;
  if (duration > 90) duration = 90;

  let rounds = 1;
  let champType = selectedFormat;
  if (selectedFormat === "double") {
    rounds = 2;
  } else if (selectedFormat === "custom") {
    rounds = 0; // Indicador de custom
  } else {
    rounds = 1;
    champType = "single";
  }

  state.config.players_per_team = perTeam;
  state.config.match_duration_minutes = duration;
  state.config.total_rounds = rounds;
  state.config.championship_type = champType;
  state.config.alarm_sound = selectedAlarm;

  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const url = pCode ? `/api/config?pelada_code=${pCode}` : "/api/config";
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
          rounds: rounds,
          alarm_sound: selectedAlarm
        });
      }
      atualizarVisibilidadeControlesFormato();
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

const DEFAULT_TEAM_PALETTE = [
  { name: "Colete Verde", color: "#84cc16", badge: "🟢" },
  { name: "Colete Laranja", color: "#f97316", badge: "🟠" },
  { name: "Colete Azul", color: "#3b82f6", badge: "🔵" },
  { name: "Colete Vermelho", color: "#ef4444", badge: "🔴" },
  { name: "Colete Amarelo", color: "#eab308", badge: "🟡" },
  { name: "Colete Preto", color: "#64748b", badge: "⚫" },
  { name: "Colete Roxo", color: "#a855f7", badge: "🟣" },
  { name: "Colete Branco", color: "#e2e8f0", badge: "⚪" },
];

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
  if (lower.includes("branco") || lower.includes("white")) return "#f8fafc";
  if (lower.includes("rosa") || lower.includes("pink")) return "#f472b6";
  if (lower.includes("cinza") || lower.includes("gray") || lower.includes("grey")) return "#94a3b8";

  // 3. Fallback na paleta padrão por índice se for numérico ou conhecido
  const paletteMatch = DEFAULT_TEAM_PALETTE.find(p => p.name.toLowerCase() === lower);
  if (paletteMatch) return paletteMatch.color;

  return fallback;
}

function renderTeamBadge(teamName, teamIdOrColor = null, extraClasses = "") {
  if (!teamName) return "";
  const color = (teamIdOrColor && String(teamIdOrColor).startsWith("#"))
    ? teamIdOrColor
    : getTeamColor(teamIdOrColor || teamName);
  return `<span class="font-extrabold inline-block ${extraClasses}" style="color: ${color};">${escapeHtml(teamName)}</span>`;
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
  amarelo: "#facc15",
  derrota: "#f87171",
};


function pdfTruncar(texto, max) {
  const s = String(texto ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function pdfIcone(nome, cor, tamanho) {
  return `<i data-lucide="${nome}" width="${tamanho}" height="${tamanho}" style="color: ${cor};"></i>`;
}

function pdfFundo() {
  return `
    <img src="/static/bg-pitch.jpg" alt="" style="position: absolute; top: 0; left: 0; width: 794px; height: 1123px; object-fit: cover; opacity: 0.85; z-index: 0;" />
    <div style="position: absolute; top: 0; left: 0; width: 794px; height: 1123px; background: linear-gradient(to top, #080c14 15%, rgba(8,12,20,0.85) 60%, rgba(8,12,20,0.7) 100%); z-index: 1;"></div>
    <div style="position: absolute; top: 0; left: 0; width: 794px; height: 1123px; background: radial-gradient(circle at center, transparent 0%, rgba(8,12,20,0.6) 60%, #080c14 100%); z-index: 1;"></div>`;
}

const PDF_BOLA_AJUSTE_Y = -11;

function pdfCabecalho(nomePelada, codigo, geradoEm) {
  const codigoHtml = codigo
    ? `<span style="font-size: 12px; line-height: 16px; font-weight: 800; color: ${PDF_CORES.destaque}; letter-spacing: 1px; white-space: nowrap;">#${escapeHtml(codigo)}</span>`
    : "";
  return `
    <table style="width: 100%; border-collapse: collapse; border-bottom: 2px solid rgba(0, 245, 155, 0.4);"><tr>
      <td style="width: 58px; vertical-align: middle; padding-bottom: 14px;">
        <table style="width: 46px; height: 46px; border-collapse: separate; border-spacing: 0; background: linear-gradient(135deg, #00f59b 0%, #00b875 100%); border-radius: 12px;"><tr>
          <td style="width: 46px; height: 46px; padding: 0; text-align: center; vertical-align: middle; font-size: 22px; line-height: 46px;"><span style="position: relative; top: ${PDF_BOLA_AJUSTE_Y}px;">⚽</span></td>
        </tr></table>
      </td>
      <td style="vertical-align: middle; padding-bottom: 14px;">
        <div style="font-size: 24px; line-height: 28px; font-weight: 900; letter-spacing: -0.5px; color: #ffffff; white-space: nowrap;">Fut<span style="color: ${PDF_CORES.destaque};">Match</span></div>
        <div style="margin-top: 4px; font-size: 13px; line-height: 18px; color: ${PDF_CORES.textoSuave}; white-space: nowrap;">Relatório &amp; Estatísticas da Pelada: <strong style="color: #ffffff;">${escapeHtml(pdfTruncar(nomePelada, 28))}</strong>&nbsp;&nbsp;${codigoHtml}</div>
      </td>
      <td style="text-align: right; vertical-align: middle; padding-bottom: 14px; white-space: nowrap;">
        <div style="font-size: 10px; line-height: 12px; text-transform: uppercase; letter-spacing: 1px; color: ${PDF_CORES.textoApagado}; font-weight: 700;">Gerado em</div>
        <div style="margin-top: 4px; font-size: 12px; line-height: 16px; color: ${PDF_CORES.textoClaro}; font-weight: 600;">${geradoEm}</div>
      </td>
    </tr></table>`;
}

function pdfSecao(icone, cor, titulo, subtitulo, deslocamento = -8) {
  return `
    <table style="border-collapse: collapse;"><tr>
      <td style="width: 4px; height: 22px; padding: 0; background: ${cor}; border-radius: 2px;"></td>
      <td style="width: 24px; height: 22px; padding: 0 0 0 10px; vertical-align: middle; color: ${cor};">${pdfIcone(icone, cor, 18)}</td>
      <td style="height: 22px; padding: 0; vertical-align: middle; font-size: 16px; line-height: 22px; font-weight: 700; color: #ffffff; white-space: nowrap;"><span style="position: relative; top: ${deslocamento}px;">${titulo}</span></td>
    </tr></table>
    ${subtitulo ? `<div style="margin-top: 4px; font-size: 12px; line-height: 16px; color: ${PDF_CORES.textoSuave};">${subtitulo}</div>` : ""}
    <div style="height: 1px; background: ${PDF_CORES.borda}; margin: 12px 0;"></div>`;
}

function pdfCard(conteudo) {
  return `<div style="background: ${PDF_CORES.fundoCard}; border: 1px solid ${PDF_CORES.borda}; border-radius: 18px; padding: 18px 20px; box-sizing: border-box;">${conteudo}</div>`;
}

function pdfKpi(rotulo, icone, cor, valor, sub, margemEsquerda, ehTexto) {
  return `
    <div style="flex: 1; min-width: 0; box-sizing: border-box; margin-left: ${margemEsquerda}px; height: 116px; padding: 14px 18px; background: ${PDF_CORES.fundoCard}; border: 1px solid ${PDF_CORES.borda}; border-radius: 16px;">
      <table style="width: 100%; border-collapse: collapse;"><tr>
        <td style="font-size: 12px; line-height: 16px; font-weight: 500; color: ${PDF_CORES.textoSuave}; white-space: nowrap; vertical-align: middle;"><span style="position: relative; top: -4px;">${rotulo}</span></td>
        <td style="width: 18px; text-align: right; vertical-align: middle; color: ${cor};">${pdfIcone(icone, cor, 16)}</td>
      </tr></table>
      <div style="position: relative; top: -4px; margin-top: 0px; padding-bottom: 4px; line-height: 40px; font-size: ${ehTexto ? 22 : 30}px; font-weight: 900; color: #ffffff; white-space: nowrap;">${valor}</div>
      <div style="position: relative; top: -4px; margin-top: 4px; font-size: 11px; line-height: 16px; color: ${PDF_CORES.textoSuave}; white-space: nowrap;">${sub}</div>
    </div>`;
}

function pdfTabelaClassificacao(leaderboard, corPorNome) {
  const cabeca = (texto, extra = "") =>
    `<th style="padding: 0 4px 8px 4px; font-size: 10px; line-height: 14px; font-weight: 700; text-transform: uppercase; color: ${PDF_CORES.textoSuave}; text-align: center; border-bottom: 1px solid ${PDF_CORES.borda}; ${extra}">${texto}</th>`;
  const celula = `padding: 0 4px; height: 44px; font-size: 12px; line-height: 16px; text-align: center; vertical-align: middle; color: ${PDF_CORES.textoClaro}; border-bottom: 1px solid ${PDF_CORES.bordaSuave};`;

  const linhas = leaderboard.slice(0, 6).map((t, idx) => {
    const sg = (t.goals_scored || 0) - (t.goals_conceded || 0);
    const sgCor = sg > 0 ? "#34d399" : (sg < 0 ? PDF_CORES.derrota : PDF_CORES.textoSuave);
    const cor = getTeamColor(t.id || t.name, corPorNome[t.name] || PDF_CORES.textoClaro);
    const corPos = idx === 0 ? PDF_CORES.ouro : idx === 1 ? PDF_CORES.prata : idx === 2 ? PDF_CORES.bronze : PDF_CORES.textoSuave;
    return `
      <tr>
        <td style="height: 44px; padding: 14px 8px 0 0; vertical-align: top; text-align: left; line-height: 16px; white-space: nowrap; border-bottom: 1px solid ${PDF_CORES.bordaSuave};">
          <span style="position: relative; top: -3px; font-size: 12px; font-weight: 800; color: ${corPos}; margin-right: 8px;">${idx + 1}º</span><span style="position: relative; top: -3px; font-size: 13px; font-weight: 800; color: ${cor};">${escapeHtml(pdfTruncar(t.name, 20))}</span>
        </td>
        <td style="${celula}">${t.matches}</td>
        <td style="${celula} color: #34d399; font-weight: 600;">${t.wins}</td>
        <td style="${celula}">${t.draws}</td>
        <td style="${celula} color: ${PDF_CORES.derrota};">${t.losses}</td>
        <td style="${celula}">${t.goals_scored}</td>
        <td style="${celula}">${t.goals_conceded}</td>
        <td style="${celula} color: ${sgCor}; font-weight: 600;">${sg > 0 ? "+" + sg : sg}</td>
        <td style="${celula} color: ${PDF_CORES.destaque}; font-weight: 900; font-size: 14px;"><span style="position: relative; top: -1px;">${t.points}</span></td>
      </tr>`;
  }).join("");

  return `
    <table style="width: 100%; border-collapse: collapse;">
      <thead><tr>
        ${cabeca("Equipe", "text-align: left;")}${cabeca("J")}${cabeca("V")}${cabeca("E")}${cabeca("D")}${cabeca("GP")}${cabeca("GC")}${cabeca("SG")}${cabeca("PTS", `color: ${PDF_CORES.destaque};`)}
      </tr></thead>
      <tbody>${linhas || `<tr><td colspan="9" style="height: 40px; text-align: center; font-size: 12px; color: ${PDF_CORES.textoApagado};">Nenhuma partida finalizada até o momento.</td></tr>`}</tbody>
    </table>`;
}

function pdfColunaRanking(titulo, icone, cor, linhas, vazio) {
  const ALTURA = 18;
  const ESPACO = 8;
  const LARGURA_PILULA = 96;
  const nomes = linhas.map((l) => `
    <tr><td style="height: ${ALTURA}px; padding: 0; vertical-align: middle; font-size: 12px; line-height: ${ALTURA}px; font-weight: 600; color: ${PDF_CORES.texto}; white-space: nowrap;"><span style="position: relative; top: -6px; font-weight: 800; color: ${PDF_CORES.textoSuave};">${l.pos}.</span><span style="position: relative; top: -6px;"> ${escapeHtml(pdfTruncar(l.nome, 18))}</span></td></tr>
    <tr><td style="height: ${ESPACO}px; padding: 0; font-size: 0; line-height: 0;">&nbsp;</td></tr>`).join("");
  // Pílula em SVG: retângulo arredondado e texto centralizado por atributo (sem depender de caixa CSS)
  const pilulas = linhas.map((l) => `
    <tr><td style="height: ${ALTURA}px; padding: 0; font-size: 0; line-height: 0;">
      <div style="position: relative; width: ${LARGURA_PILULA}px; height: ${ALTURA}px;">
        <svg width="${LARGURA_PILULA}" height="${ALTURA}" viewBox="0 0 ${LARGURA_PILULA} ${ALTURA}" style="position: absolute; top: 0; left: 0; display: block;">
          <rect x="0" y="0" width="${LARGURA_PILULA}" height="${ALTURA}" rx="${ALTURA / 2}" ry="${ALTURA / 2}" fill="${l.fundo}"/>
        </svg>
        <div style="position: absolute; top: -8px; left: 0; width: ${LARGURA_PILULA}px; height: ${ALTURA}px; line-height: ${ALTURA}px; text-align: center; font-family: 'Outfit', sans-serif; font-size: 11px; font-weight: 800; color: ${l.cor}; white-space: nowrap;">${escapeHtml(l.texto)}</div>
      </div>
    </td></tr>
    <tr><td style="height: ${ESPACO}px; padding: 0; font-size: 0; line-height: 0;">&nbsp;</td></tr>`).join("");

  const corpo = linhas.length
    ? `<table style="width: 100%; border-collapse: collapse;"><tr>
         <td style="vertical-align: top; padding: 0;"><table style="width: 100%; border-collapse: collapse;">${nomes}</table></td>
         <td style="width: ${LARGURA_PILULA}px; vertical-align: top; padding: 0 0 0 12px;"><table style="border-collapse: collapse;">${pilulas}</table></td>
       </tr></table>`
    : `<div style="font-size: 11px; line-height: 16px; color: ${PDF_CORES.textoApagado};">${vazio}</div>`;

  return `
    <table style="border-collapse: collapse; margin-bottom: 10px;"><tr>
      <td style="width: 3px; height: 16px; padding: 0; background: ${cor}; border-radius: 2px;"></td>
      <td style="width: 22px; height: 16px; padding: 0 0 0 8px; vertical-align: middle; color: ${cor};">${pdfIcone(icone, cor, 15)}</td>
      <td style="height: 16px; padding: 0; vertical-align: middle; font-size: 11px; line-height: 16px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: ${PDF_CORES.textoClaro}; white-space: nowrap;"><span style="position: relative; top: -6px;">${titulo}</span></td>
    </tr></table>
    ${corpo}`;
}

function pdfRodape(textoPagina) {
  return `
    <table style="width: 100%; border-collapse: collapse; border-top: 1px solid ${PDF_CORES.borda};"><tr>
      <td style="padding-top: 12px; font-size: 10px; line-height: 14px; color: ${PDF_CORES.textoApagado}; white-space: nowrap;">FutMatch — Gestão Inteligente e Estatísticas de Peladas</td>
      <td style="padding-top: 12px; text-align: right; font-size: 10px; line-height: 14px; font-weight: 600; color: ${PDF_CORES.destaque}; white-space: nowrap;">Folha oficial de resumo • ${textoPagina}</td>
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
      <td style="padding: 1px 0; font-size: 11px; line-height: 15px; white-space: nowrap; color: ${i.contra ? PDF_CORES.derrota : PDF_CORES.texto};">${escapeHtml(pdfTruncar(i.nome, 13))}${i.contra ? ` <span style="font-size: 10px; color: ${PDF_CORES.derrota};">(contra)</span>` : ""}</td>
      <td style="width: 1%; padding: 1px 0 1px 6px; text-align: right; font-size: 11px; line-height: 15px; font-weight: 800; color: ${PDF_CORES.destaque}; white-space: nowrap;">${i.n > 1 ? "×" + i.n : ""}</td>
    </tr>`).join("");
  const resto = resumo.itens.length > MAX
    ? `<tr><td colspan="2" style="font-size: 10px; line-height: 14px; color: ${PDF_CORES.textoApagado};">+${resumo.itens.length - MAX} jogador(es)</td></tr>` : "";
  const semAutor = resumo.semAutor > 0
    ? `<tr><td colspan="2" style="font-size: 10px; line-height: 14px; color: ${PDF_CORES.textoApagado};">+${resumo.semAutor} gol(s) sem autor</td></tr>` : "";
  const vazio = !resumo.itens.length && !resumo.semAutor
    ? `<tr><td colspan="2" style="font-size: 11px; line-height: 15px; color: ${PDF_CORES.textoApagado};">Sem gols</td></tr>` : "";

  return `<table style="width: 100%; border-collapse: collapse;">${linhas}${resto}${semAutor}${vazio}</table>`;
}

function pdfCelulaPartida(partida, corPorNome) {
  const cCasa = getTeamColor(partida.home_team_id || partida.home_team_name, corPorNome[partida.home_team_name] || PDF_CORES.textoClaro);
  const cFora = getTeamColor(partida.away_team_id || partida.away_team_name, corPorNome[partida.away_team_name] || PDF_CORES.textoClaro);
  const resumo = pdfResumoGols(partida);
  const dataHora = typeof partida.played_at === "string" ? partida.played_at.slice(0, 16) : "";

  return `
    <td style="vertical-align: top; padding: 10px 12px; background: ${PDF_CORES.fundoCard}; border: 1px solid ${PDF_CORES.borda}; border-radius: 14px;">
      <table style="width: 100%; border-collapse: collapse;"><tr>
        <td style="font-size: 10px; line-height: 14px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: ${PDF_CORES.textoSuave}; white-space: nowrap;">Rodada ${partida.round_number}</td>
        <td style="text-align: right; font-size: 10px; line-height: 14px; color: ${PDF_CORES.textoApagado}; white-space: nowrap;">${escapeHtml(dataHora)}</td>
      </tr></table>

      <table style="width: 100%; border-collapse: collapse; margin-top: 8px;"><tr>
        <td style="text-align: left; vertical-align: middle; font-size: 12px; line-height: 16px; font-weight: 800; white-space: nowrap; color: ${cCasa};">${escapeHtml(pdfTruncar(partida.home_team_name, 14))}</td>
        <td style="text-align: right; vertical-align: middle; font-size: 12px; line-height: 16px; font-weight: 800; white-space: nowrap; color: ${cFora};">${escapeHtml(pdfTruncar(partida.away_team_name, 14))}</td>
      </tr></table>
      <div style="margin-top: 4px; text-align: center; font-size: 20px; line-height: 26px; font-weight: 900; color: #ffffff; white-space: nowrap;">${partida.home_score}<span style="font-weight: 600; color: ${PDF_CORES.textoApagado};"> - </span>${partida.away_score}</div>

      <div style="height: 1px; background: ${PDF_CORES.borda}; margin: 8px 0 10px 0;"></div>

      <table style="width: 100%; border-collapse: collapse; table-layout: fixed;"><tr>
        <td style="width: 50%; vertical-align: top; padding-right: 8px;">${pdfListaGols(resumo.casa)}</td>
        <td style="width: 50%; vertical-align: top; padding-left: 8px; border-left: 1px solid ${PDF_CORES.borda};">${pdfListaGols(resumo.fora)}</td>
      </tr></table>
    </td>`;
}

function pdfTituloRodada(rodada, continuacao) {
  const sufixo = continuacao
    ? ` <span style="font-size: 12px; font-weight: 600; color: ${PDF_CORES.textoSuave};">(continuação)</span>`
    : "";
  return `
    <div style="padding: 6px 0 12px 0;">
      <table style="border-collapse: collapse;"><tr>
        <td style="padding: 0 0 8px 0; border-bottom: 2px solid ${PDF_CORES.destaqueSublinhado}; font-size: 18px; line-height: 24px; font-weight: 800; color: #ffffff; white-space: nowrap;">Rodada ${rodada}${sufixo}</td>
      </tr></table>
    </div>`;
}

function pdfLinhaCards(celulas) {
  const cartoes = [...celulas];
  while (cartoes.length < 3) cartoes.push("<td></td>");
  return `
    <div style="padding-bottom: 12px;">
      <table style="width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 12px 0; margin: 0 -12px;"><tr>${cartoes.join("")}</tr></table>
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
    <div style="display: flex;">
      ${pdfKpi("Partidas Jogadas", "flag", PDF_CORES.destaque, d.totalPartidas, "&nbsp;", 0, false)}
      ${pdfKpi("Total de Gols", "goal", PDF_CORES.destaque, d.totalGols, `Média: <strong style="color: ${PDF_CORES.destaque};">${d.media}</strong> por partida`, 12, false)}
      ${pdfKpi("Artilheiro Máximo", "award", PDF_CORES.ouro, pdfTruncar(d.artilheiro, 15), `${d.artilheiroGols} gols marcados`, 12, true)}
      ${pdfKpi("Maior Vencedor", "crown", PDF_CORES.amarelo, pdfTruncar(d.vencedor, 15), `${d.vencedorVitorias} vitórias (${d.vencedorTaxa}%)`, 12, true)}
    </div>`;
  return `${pdfCabecalho(d.nomePelada, d.codigo, d.geradoEm)}<div style="padding-top: 12px;">${kpis}</div>`;
}

/* Legenda em grade (6 colunas) acima do gráfico: cresce com os jogadores sem invadir o plot. */
function pdfLegendaGrafico(itens) {
  const COLUNAS = 6;
  const linhas = [];
  for (let i = 0; i < itens.length; i += COLUNAS) linhas.push(itens.slice(i, i + COLUNAS));
  const celula = (item) => item
    ? `<td style="padding: 3px 2px; font-size: 10px; line-height: 14px; font-weight: 600; color: ${PDF_CORES.textoSuave}; white-space: nowrap; overflow: hidden;">${item.marcador ? `<img src="${item.marcador}" alt="" width="10" height="10" style="display: inline-block; vertical-align: -1px; margin-right: 4px;" />` : ""}${escapeHtml(pdfTruncar(item.nome, 14))}</td>`
    : `<td></td>`;
  return `<table style="width: 100%; border-collapse: collapse; table-layout: fixed;">${linhas.map((linha) => {
    const preenchida = [...linha];
    while (preenchida.length < COLUNAS) preenchida.push(null);
    return `<tr>${preenchida.map(celula).join("")}</tr>`;
  }).join("")}</table>`;
}

function pdfCardGrafico(titulo, icone, cor, grafico) {
  const corpo = grafico
    ? `${pdfLegendaGrafico(grafico.legenda)}<div style="padding-top: 10px;"><img src="${grafico.imagem}" alt="" style="display: block; width: 670px; height: 200px;" /></div>`
    : `<div style="height: 200px; line-height: 200px; text-align: center; font-size: 12px; color: ${PDF_CORES.textoApagado};">Sem dados para exibir.</div>`;
  return pdfCard(pdfSecao(icone, cor, titulo, "", -8) + corpo);
}

function pdfBlocosResumo(d) {
  const classificacao = pdfCard(
    pdfSecao("list-ordered", PDF_CORES.destaque, "Tabela Geral de Classificação", "") +
    pdfTabelaClassificacao(d.leaderboard, d.corPorNome)
  );

  const destaques = pdfCard(
    pdfSecao("flame", PDF_CORES.ouro, "Destaques Individuais", "Quem mais balançou as redes e quem mais venceu") +
    `<table style="width: 100%; border-collapse: collapse;"><tr>
       <td style="width: 50%; vertical-align: top; padding-right: 12px;">${pdfColunaRanking("Top goleadores", "goal", PDF_CORES.destaque, d.artilheiros, "Nenhum gol atribuído ainda.")}</td>
       <td style="width: 50%; vertical-align: top; padding-left: 12px; border-left: 1px solid ${PDF_CORES.borda};">${pdfColunaRanking("Mais vitoriosos (taxa de vitória)", "crown", PDF_CORES.amarelo, d.vitoriosos, "Sem jogos concluídos.")}</td>
     </tr></table>`
  );

  const aproveitamento = pdfCardGrafico("Aproveitamento", "target", PDF_CORES.destaque, d.graficos.aproveitamento);
  const media = pdfCardGrafico("Média de gols", "goal", PDF_CORES.destaque, d.graficos.media);

  // padding-top (e não margin-top) para que a medição do bloco inclua o espaçamento
  return [classificacao, destaques, aproveitamento, media].map((html) => `<div style="padding-top: 12px;">${html}</div>`);
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
    <div style="margin-top: 4px;">${conteudo}</div>
    <div style="margin-top: auto;">${pdfRodape(`Página ${numero} de ${total}`)}</div>`;
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
    <div style="position: relative; width: 794px; height: 1123px; overflow: hidden; padding: 36px 40px; box-sizing: border-box;">
      ${pdfFundo()}
      <div style="position: relative; z-index: 2; display: flex; flex-direction: column; height: 1051px;">${conteudo}</div>
    </div>`;
  document.body.appendChild(el);

  try {
    if (window.lucide && typeof window.lucide.createIcons === "function") {
      window.lucide.createIcons();
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

  try {
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = "Gerando...";

    // 1. Dados: dashboard (KPIs e destaques), partidas (histórico) e pelada (cores dos times)
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const dashUrl = pCode ? `/api/dashboard?pelada_code=${pCode}` : "/api/dashboard";
    const matchesUrl = pCode ? `/api/matches?pelada_code=${pCode}` : "/api/matches";
    const [dash, partidasBrutas, info] = await Promise.all([
      fetch(dashUrl).then((r) => r.json()),
      fetch(matchesUrl).then((r) => r.json()),
      pCode ? fetch(`/api/peladas/${pCode}`).then((r) => r.json()) : Promise.resolve({}),
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
    const dadosResumo = {
      ...base,
      graficos,
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
      paginas.push(`${topo}${corpo}<div style="margin-top: auto;">${pdfRodape(`Página ${i + 1} de ${totalPaginas}`)}</div>`);
    });
    paginasHistorico.forEach((pagina, i) => {
      const conteudo = pagina.length
        ? pagina.map((u) => u.html).join("")
        : pdfCard(`<div style="padding: 24px 0; text-align: center; font-size: 12px; color: ${PDF_CORES.textoApagado};">Nenhuma partida finalizada até o momento.</div>`);
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
    await showCustomAlert("Houve uma falha ao gerar o arquivo PDF. Verifique o console.", "Erro ao Gerar PDF");
  } finally {
    updatePdfExportButtonState();
    if (btnText) btnText.textContent = originalText;
  }
}
