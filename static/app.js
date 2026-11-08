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
    points_draw: 1
  }
};

let syncDebounceTimer = null;
let claimAdminCooldownTimer = null;

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
      roleBadge.innerHTML = `<i data-lucide="crown" class="w-3 h-3 text-neon-accent"></i><span>Admin</span>`;
      roleBadge.className = 'h-5 inline-flex items-center justify-center text-[10px] font-bold px-2 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 gap-1 leading-none';
    } else {
      roleBadge.innerHTML = `<i data-lucide="eye" class="w-3 h-3 text-amber-400"></i><span>Espectador</span>`;
      roleBadge.className = 'h-5 inline-flex items-center justify-center text-[10px] font-bold px-2 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/30 gap-1 leading-none';
    }
  }

  if (settingsIndicator) {
    if (isLeader) {
      settingsIndicator.textContent = 'Administrador';
      settingsIndicator.className = 'text-xs font-bold px-3 py-1 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else {
      settingsIndicator.textContent = 'Modo Espectador';
      settingsIndicator.className = 'text-xs font-bold px-3 py-1 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/30';
    }
  }

  // Se já for admin, estiliza ou oculta o box de claim
  if (claimAdminBox) {
    if (isLeader) {
      claimAdminBox.classList.add('opacity-75');
    } else {
      claimAdminBox.classList.remove('opacity-75');
    }
  }

  // Habilitar / desabilitar botões de edição administrativa
  const adminOnlyElements = document.querySelectorAll('.admin-only');
  adminOnlyElements.forEach(el => {
    if (isLeader) {
      el.classList.remove('hidden');
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        el.disabled = false;
      }
    } else {
      el.classList.add('hidden');
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        el.disabled = true;
      }
    }
  });

  lucide.createIcons();
}

async function inicializarPelada() {
  const code = getActivePeladaCode();
  const landingScreen = document.getElementById('landing-screen');

  if (!code) {
    if (landingScreen) landingScreen.classList.remove('hidden');
    return;
  }

  try {
    const res = await fetch(`/api/peladas/${code}`);
    if (!res.ok) {
      // Se não encontrou, remove do storage e exibe landing
      localStorage.removeItem('futmatch_active_pelada');
      if (landingScreen) landingScreen.classList.remove('hidden');
      await showCustomAlert("A pelada com o código informado não foi encontrada.", "Código Inválido");
      return;
    }

    const data = await res.json();
    const savedRole = localStorage.getItem(`futmatch_role_${code}`) || 'spectator';
    state.currentPelada = data;
    state.role = savedRole;

    if (landingScreen) landingScreen.classList.add('hidden');

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

    // Se o líder acabou de criar e ainda não configurou a senha
    if (state.role === 'admin' && !data.has_password) {
      abrirModalDefinirSenha();
    }
  } catch (err) {
    console.error("Erro ao carregar pelada:", err);
    if (landingScreen) landingScreen.classList.remove('hidden');
  }
}

async function criarNovaPelada() {
  const nameInput = document.getElementById('input-new-pelada-name');
  const peladaName = nameInput ? nameInput.value.trim() : "";
  const btn = document.getElementById('btn-create-pelada');

  if (btn) btn.disabled = true;

  try {
    const res = await fetch("/api/peladas/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: peladaName || "Pelada dos Amigos" })
    });

    if (!res.ok) {
      await showCustomAlert("Falha ao gerar nova pelada. Tente novamente.", "Erro");
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

    // Inicia música aleatória de abertura
    if (window.SoundManager) {
      window.SoundManager.playMusic('abertura');
    }

    // Oculta tela inicial
    const landing = document.getElementById('landing-screen');
    if (landing) landing.classList.add('hidden');

    // Redireciona para aba de jogadores
    switchTab('matchmaker');
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();

    // Abre imediatamente o modal obrigatório de senha mestra
    abrirModalDefinirSenha();
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

    const landing = document.getElementById('landing-screen');
    if (landing) landing.classList.add('hidden');

    // Inicia música aleatória de abertura
    if (window.SoundManager) {
      window.SoundManager.playMusic('abertura');
    }

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

  localStorage.removeItem('futmatch_active_pelada');
  const cleanUrl = window.location.pathname;
  window.history.replaceState({}, '', cleanUrl);

  const landing = document.getElementById('landing-screen');
  if (landing) {
    landing.classList.remove('hidden');
    const inputCode = document.getElementById('input-join-code');
    if (inputCode) inputCode.value = "";
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
      renderPoolUI(state.currentPelada.chain_codes);
      await atualizarDashboard();
      showToast("Pelada desvinculada da pool!");
    }
  } catch (e) {
    console.error(e);
  }
}

function renderPoolUI(chainCodes) {
  const codes = chainCodes || (state.currentPelada && state.currentPelada.chain_codes) || [state.currentPelada?.code];
  const count = codes.length;

  // Status Badge no Menu Ajustes
  const badgeStatus = document.getElementById('badge-pool-status');
  if (badgeStatus) {
    badgeStatus.textContent = count > 1 ? `${count} Peladas em Corrente` : '1 Pelada (Individual)';
    badgeStatus.className = count > 1
      ? 'text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30'
      : 'text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
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
function sincronizarEstadoServidor() {
  if (!state.currentPelada || !state.currentPelada.code) return;
  if (state.role !== 'admin') return;

  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
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
  }, 600);
}

// ==============================
// INICIALIZAÇÃO & TABS
// ==============================
document.addEventListener("DOMContentLoaded", async () => {
  updateTabPanesVisibility(0);
  await inicializarPelada();
  lucide.createIcons();
});


let currentActiveTab = 'matchmaker';
let tabSlideTimeout = null;

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

function switchTab(tabId) {
  const sections = ['matchmaker', 'fixtures', 'dashboard', 'settings'];
  const targetIndex = sections.indexOf(tabId);
  if (targetIndex === -1) return;

  currentActiveTab = tabId;

  // Garante que a página sempre volte ao topo para evitar cair em áreas vazias
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });

  // Desloca o slider para a aba alvo considerando a largura de cada tela + o espaçamento (gap) entre elas
  const slider = document.getElementById('tabs-slider');
  const viewport = document.getElementById('tab-viewport');
  const panes = document.querySelectorAll('.tab-slide-pane');

  if (tabSlideTimeout) {
    clearTimeout(tabSlideTimeout);
    tabSlideTimeout = null;
  }

  // Durante a animação de transição, todos os painéis precisam estar visíveis
  panes.forEach(pane => pane.classList.remove('tab-inactive'));

  if (slider && viewport) {
    if (targetIndex === 0) {
      slider.style.transform = `translateX(0px)`;
    } else {
      const vpWidth = viewport.offsetWidth;
      const gap = 48; // mesmo valor de --tab-gap
      const offset = targetIndex * (vpWidth + gap);
      slider.style.transform = `translateX(-${offset}px)`;
    }
  }

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
        btn.classList.add('bg-neon-accent', 'text-black', 'shadow-sm');
        btn.classList.remove('text-slate-400', 'hover:bg-cardLight');
      } else {
        btn.classList.remove('bg-neon-accent', 'text-black', 'shadow-sm');
        btn.classList.add('text-slate-400', 'hover:bg-cardLight');
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

  if (tabId === 'dashboard') {
    atualizarDashboard();
  }
  lucide.createIcons();
}

function showToast(msg) {
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  if (!toast || !toastMsg) return;
  toastMsg.textContent = msg;
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
    msgEl.textContent = message;
    cancelBtn.classList.add("hidden");
    okBtn.textContent = "Entendido";
    okBtn.className = "px-5 py-2 bg-neon-accent hover:bg-emerald-400 text-black text-xs font-bold rounded-xl transition shadow";
    iconContainer.className = "w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 text-xl text-neon-accent";

    const handleOk = () => {
      cleanup();
      resolve();
    };

    const cleanup = () => {
      modal.classList.add("hidden");
      okBtn.removeEventListener("click", handleOk);
    };

    okBtn.addEventListener("click", handleOk, { once: true });
    modal.classList.remove("hidden");
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
    msgEl.textContent = message;
    cancelBtn.textContent = cancelText;
    cancelBtn.classList.remove("hidden");
    okBtn.textContent = confirmText;
    okBtn.className = "px-5 py-2 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-xl transition shadow";
    iconContainer.className = "w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0 text-xl text-amber-400";

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
    };

    okBtn.addEventListener("click", handleOk, { once: true });
    cancelBtn.addEventListener("click", handleCancel, { once: true });
    modal.classList.remove("hidden");
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

  renderPlayersList();
  showToast(`${name} adicionado!`);
}

function removePlayer(id) {
  state.players = state.players.filter(p => p.id !== id);
  renderPlayersList();
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
    renderPlayersList();
    renderTeamsGrid();
    renderFixtures();
    showToast("Lista de jogadores limpa!");
  }
}

function togglePlayerRole(id) {
  const p = state.players.find(x => x.id === id);
  if (!p) return;
  p.is_goalkeeper = !p.is_goalkeeper;
  renderPlayersList();
  showToast(`${p.name} agora é ${p.is_goalkeeper ? '🧤 Goleiro (GK)' : '🏃 Jogador de Linha (LIN)'}`);
}

function cyclePlayerLevel(id) {
  const p = state.players.find(x => x.id === id);
  if (!p) return;
  // Aumenta até 5, depois volta para 1
  p.level = p.level >= 5 ? 1 : p.level + 1;
  renderPlayersList();
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
    <div class="flex items-center justify-between p-2.5 bg-card/60 hover:bg-card border border-borderLight/40 rounded-xl transition">
      <div class="flex items-center space-x-2.5 min-w-0">
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

    // Detecta se é goleiro considerando parênteses ou termos
    let isGk = false;
    const parenMatches = clean.match(/\(([^)]*)\)/g) || [];
    for (const pm of parenMatches) {
      if (/\b(goleiro|gk|g)\b/i.test(pm)) {
        isGk = true;
      }
    }
    if (/\b(goleiro|gk)\b/i.test(clean) || /\b(g)\b/i.test(clean)) {
      isGk = true;
    }

    // Remove referências explícitas de goleiro para não sujar o nome
    let textWithoutGk = clean.replace(/\(\s*(goleiro|gk|g)\s*\)/gi, " ");
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
      .replace(/\s*\(.*?\)/g, " ")
      .replace(/[–—\-]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!playerName) return;

    state.players.push({
      id: "p_" + Date.now() + "_" + Math.floor(Math.random() * 10000) + "_" + addedCount,
      name: playerName,
      level: level,
      is_goalkeeper: isGk
    });
    addedCount++;
  });

  textarea.value = "";
  renderPlayersList();
  showToast(`${addedCount} jogadores importados com sucesso!`);
}

// ==============================
// SORTEIO E TABELA DE CONFRONTOS
// ==============================
async function sortearTimes() {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  if (state.players.length < 4) {
    await showCustomAlert("Adicione pelo menos 4 jogadores para formar no mínimo 2 times!", "Poucos Jogadores");
    return;
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
    renderTeamsGrid();
    sincronizarEstadoServidor();

    // Dispara confetes animados para celebrar o sorteio
    if (window.confetti) {
      confetti({ particleCount: 70, spread: 60, origin: { y: 0.7 } });
    }

    showToast("Times sorteados e balanceados!");
    document.getElementById("btn-generate-matches")?.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    await showCustomAlert("Ocorreu um erro ao realizar o sorteio dos times.", "Erro no Sorteio");
  }
}

function renderTeamsGrid() {
  const container = document.getElementById("teams-grid");
  if (!container) return;

  if (state.teams.length === 0) {
    container.innerHTML = `
      <div class="md:col-span-2 text-center py-16 border-2 border-dashed border-borderLight rounded-2xl text-slate-500 space-y-3">
        <i data-lucide="users-2" class="w-12 h-12 mx-auto stroke-1 text-slate-600"></i>
        <p class="text-sm">Clique em <strong class="text-neon-accent">"Equilibrar Times & Sorteio"</strong> para dividir os jogadores automaticamente entre os coletes!</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = state.teams.map((t, idx) => {
    const totalLevel = t.players.reduce((sum, p) => {
      const lvl = (p.effective_level !== undefined && p.effective_level !== null) ? p.effective_level : p.level;
      return sum + lvl;
    }, 0);
    const avgStars = (totalLevel / (t.players.length || 1)).toFixed(1);

    return `
      <div class="bg-card border border-borderLight rounded-2xl p-5 space-y-3.5 relative overflow-hidden transition hover:border-slate-500">
        <!-- Barra de Cor no Topo -->
        <div class="absolute top-0 left-0 right-0 h-1.5" style="background-color: ${t.color}"></div>

        <div class="flex items-center justify-between pt-1">
          <div class="flex items-center space-x-2.5">
            <span class="w-3.5 h-3.5 rounded-full shadow" style="background-color: ${t.color}"></span>
            <h4 class="font-extrabold text-white text-base">${escapeHtml(t.name)}</h4>
          </div>
          <div class="text-[11px] font-bold text-slate-400 bg-pitch px-2 py-0.5 rounded-lg border border-borderLight" title="Força média do time">
            ★ ${avgStars} / 5.0
          </div>
        </div>

        <!-- Lista de Jogadores do Time -->
        <div class="space-y-1.5">
          ${t.players.map(p => {
            const hasEff = p.effective_level !== undefined && p.effective_level !== null && Math.abs(p.effective_level - p.level) >= 0.05;
            return `
            <div class="flex items-center justify-between text-xs py-1 px-2 rounded-lg bg-surface/60 border border-borderLight/30">
              <span class="flex items-center gap-1.5 text-slate-200">
                ${p.is_goalkeeper ? '<span class="text-[9px] font-extrabold bg-amber-500 text-black px-1 rounded">GK</span>' : ''}
                ${escapeHtml(p.name)}
              </span>
              <div class="flex items-center gap-1.5">
                ${hasEff ? `<span class="text-[10px] font-bold text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-1 py-0.2 rounded" title="Nível efetivo ponderado pelo histórico (vitórias e gols): ${p.effective_level.toFixed(1)}">⚡ ${p.effective_level.toFixed(1)}</span>` : ''}
                <span class="text-amber-400 text-[10px]" title="${p.level} estrelas cadastradas">${"★".repeat(p.level)}</span>
              </div>
            </div>
          `;}).join("")}
        </div>
      </div>
    `;
  }).join("");

  lucide.createIcons();
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

  // Renderiza opções do Mandante
  homeSelect.innerHTML = state.teams.map(t => {
    const isCurrentAway = t.id === currentAway;
    return `<option value="${t.id}" ${t.id === currentHome ? 'selected' : ''} ${isCurrentAway ? 'disabled class="text-slate-600 bg-pitch"' : ''}>${escapeHtml(t.name)}${isCurrentAway ? ' (Já selecionado como Visitante)' : ''}</option>`;
  }).join("");

  // Renderiza opções do Visitante
  awaySelect.innerHTML = state.teams.map(t => {
    const isCurrentHome = t.id === currentHome;
    return `<option value="${t.id}" ${t.id === currentAway ? 'selected' : ''} ${isCurrentHome ? 'disabled class="text-slate-600 bg-pitch"' : ''}>${escapeHtml(t.name)}${isCurrentHome ? ' (Já selecionado como Mandante)' : ''}</option>`;
  }).join("");

  homeSelect.value = currentHome;
  awaySelect.value = currentAway;
}

function onCustomHomeChange() {
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  if (!homeSelect || !awaySelect) return;

  // Se o visitante for igual ao novo mandante, escolhe outro time válido
  if (awaySelect.value === homeSelect.value) {
    const otherTeam = state.teams.find(t => t.id !== homeSelect.value);
    if (otherTeam) awaySelect.value = otherTeam.id;
  }
  atualizarOpcoesTimesModal("home");
}

function onCustomAwayChange() {
  const homeSelect = document.getElementById("custom-match-home");
  const awaySelect = document.getElementById("custom-match-away");
  if (!homeSelect || !awaySelect) return;

  // Se o mandante for igual ao novo visitante, escolhe outro time válido
  if (homeSelect.value === awaySelect.value) {
    const otherTeam = state.teams.find(t => t.id !== awaySelect.value);
    if (otherTeam) homeSelect.value = otherTeam.id;
  }
  atualizarOpcoesTimesModal("away");
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
  const roundNum = parseInt(document.getElementById("custom-match-round").value) || 1;
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

  const confirmed = await showCustomConfirm(
    `Deseja realmente remover a partida "${match.home_team_name} x ${match.away_team_name}" da tabela?`,
    "Remover Partida",
    "Sim, Remover"
  );
  if (!confirmed) return;

  state.fixtures = state.fixtures.filter(m => m.id !== matchId);
  renderFixtures();
  sincronizarEstadoServidor();
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
    container.innerHTML = `
      <div class="bg-surface border border-borderLight rounded-3xl p-12 text-center text-slate-500 space-y-3">
        <i data-lucide="calendar-x" class="w-12 h-12 mx-auto stroke-1"></i>
        <p class="text-sm">
          ${isCustom 
            ? 'Nenhuma partida livre criada ainda. Clique em <strong class="text-neon-accent">"Nova Partida"</strong> acima para montar seus jogos!' 
            : 'Nenhum confronto gerado ainda. Sorteie os times e clique em "Gerar Confrontos Agora"!'}
        </p>
      </div>
    `;
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

  let html = "";
  for (const [roundNum, matches] of Object.entries(roundsMap)) {
    html += `
      <div class="space-y-3">
        <div class="flex items-center justify-between text-xs font-bold text-slate-400 uppercase tracking-wider">
          <div class="flex items-center space-x-2">
            <i data-lucide="layers" class="w-4 h-4 text-emerald-400"></i>
            <span>Rodada ${roundNum}</span>
          </div>
          ${isCustomMode ? `
            <button onclick="abrirModalNovaPartida(${roundNum})" class="text-[11px] text-neon-accent hover:underline flex items-center gap-1 font-semibold normal-case">
              <i data-lucide="plus" class="w-3 h-3"></i>
              <span>+ Jogo na Rodada ${roundNum}</span>
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
}

function renderSingleMatchCard(m) {
  const isFinished = m.finished;
  const isCustomMode = state.config.championship_type === "custom";
  const isLeader = state.role === 'admin';
  
  return `
    <div id="match-card-${m.id}" class="bg-surface border ${isFinished ? 'border-borderLight/40 opacity-90' : 'border-borderLight hover:border-emerald-500/50'} rounded-3xl p-5 space-y-4 transition shadow-lg relative overflow-hidden">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Jogo #${escapeHtml(String(m.id).replace('m_custom_', '').substring(0, 6))}</span>
        <div class="flex items-center gap-2">
          ${isFinished ? '<span class="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded-full bg-slate-800 text-emerald-400 border border-emerald-500/30">Encerrado</span>' : ''}
          ${(!isFinished && isLeader) ? `
            <button onclick="removerPartidaCustomizada('${m.id}')" title="Excluir partida da tabela" class="text-slate-500 hover:text-rose-400 p-1 rounded-lg transition">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          ` : ''}
        </div>
      </div>
      
      <!-- Linha dos Times e Placar -->
      <div class="flex items-center justify-between gap-4">
        
        <!-- Mandante -->
        <div class="flex-1 text-center space-y-2">
          <h4 class="font-extrabold text-sm sm:text-base text-white truncate">${escapeHtml(m.home_team_name)}</h4>
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

        <!-- Divisor VS -->
        <div class="text-center px-2">
          <span class="text-xs font-black text-slate-600 bg-pitch px-2 py-1 rounded-md border border-borderLight">VS</span>
        </div>

        <!-- Visitante -->
        <div class="flex-1 text-center space-y-2">
          <h4 class="font-extrabold text-sm sm:text-base text-white truncate">${escapeHtml(m.away_team_name)}</h4>
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

      <!-- Atribuição rápida de gols aos atletas -->
      ${!isFinished ? `
        <div class="pt-2 border-t border-borderLight/40 flex items-center justify-between text-xs">
          ${isLeader ? `
            <button onclick="abrirAtribuicaoGols('${m.id}')" class="text-slate-400 hover:text-neon-accent flex items-center gap-1 transition">
              <i data-lucide="user-check" class="w-3.5 h-3.5"></i>
              <span>Quem fez os gols? (${m.events ? m.events.length : 0})</span>
            </button>
            <button onclick="salvarPartidaFinalizada('${m.id}')" class="px-4 py-1.5 bg-neon-accent hover:bg-emerald-400 text-black font-extrabold rounded-xl transition shadow">
              Salvar Resultado
            </button>
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

  content.innerHTML = `
    <div>
      <div class="flex items-center justify-between pr-6">
        <h3 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="goal" class="w-5 h-5 text-neon-accent"></i>
          <span>Artilharia da Partida</span>
        </h3>
        <span class="text-xs px-2.5 py-1 rounded-xl bg-card border border-borderLight text-slate-300 font-extrabold">
          ${m.home_team_name} ${m.home_score} x ${m.away_score} ${m.away_team_name}
        </span>
      </div>
      <p class="text-xs text-slate-400 mt-1">Distribua os gols marcados no placar entre os atletas de cada equipe:</p>
      
      <!-- Status de Gols por Time -->
      <div class="grid grid-cols-2 gap-2 mt-3">
        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="font-bold text-white truncate">${escapeHtml(m.home_team_name)}</div>
          <div class="flex items-center justify-between mt-1 text-[11px]">
            <span class="text-slate-400">Atribuídos: <strong class="text-white">${homeGoalsAssigned}/${m.home_score}</strong></span>
            ${homeRemaining === 0 ? '<span class="text-emerald-400 font-bold">✓ Completo</span>' : `<span class="text-amber-400 font-bold">Faltam ${homeRemaining}</span>`}
          </div>
        </div>

        <div class="p-2.5 rounded-xl bg-card border border-borderLight/60 text-xs">
          <div class="font-bold text-white truncate">${escapeHtml(m.away_team_name)}</div>
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
        <div class="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center justify-between">
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
                ${p.is_goalkeeper ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">GK</span>' : ''}
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
        <div class="text-[11px] font-bold uppercase tracking-wider text-cyan-400 flex items-center justify-between">
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
                ${p.is_goalkeeper ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">GK</span>' : ''}
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
    if (m.home_score === 0) {
      showToast(`${m.home_team_name} está com 0 gols no placar!`);
      return;
    }
    if (homeGoalsAssigned >= m.home_score) {
      showToast(`Limite de gols atingido para ${m.home_team_name} (${m.home_score} gols)`);
      return;
    }
  } else if (isAway) {
    if (m.away_score === 0) {
      showToast(`${m.away_team_name} está com 0 gols no placar!`);
      return;
    }
    if (awayGoalsAssigned >= m.away_score) {
      showToast(`Limite de gols atingido para ${m.away_team_name} (${m.away_score} gols)`);
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
}

async function reabrirPartida(matchId) {
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const m = state.fixtures.find(x => x.id === matchId);
  if (!m) return;

  const confirmed = await showCustomConfirm(
    `Deseja reabrir a partida "${m.home_team_name} x ${m.away_team_name}" para edição? O resultado será recalculado quando você salvar novamente.`,
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

    if (!res.ok) throw new Error("Erro na gravação da partida");

    const data = await res.json();
    m.finished = true;
    m.played_at = data.match.played_at;

    renderFixtures();
    sincronizarEstadoServidor();
    await atualizarDashboard();
    showToast(`Resultado salvo! ${m.home_team_name} ${m.home_score} x ${m.away_score} ${m.away_team_name}`);
  } catch (err) {
    console.error(err);
    await showCustomAlert("Falha ao salvar a partida no banco de dados SQLite.", "Erro na Gravação");
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
      document.getElementById("kpi-top-scorer-goals").textContent = `${data.top_scorers[0].goals} gols marcados`;
    } else {
      document.getElementById("kpi-top-scorer").textContent = "-";
      document.getElementById("kpi-top-scorer-goals").textContent = "0 gols";
    }

    if (data.top_winners && data.top_winners.length > 0) {
      const best = data.top_winners[0];
      document.getElementById("kpi-top-winner").textContent = best.name;
      document.getElementById("kpi-top-winner-rate").textContent = `${best.wins} vitórias (${best.win_rate}%)`;
    } else {
      document.getElementById("kpi-top-winner").textContent = "-";
      document.getElementById("kpi-top-winner-rate").textContent = "0 vitórias (0%)";
    }

    // Tabela Leaderboard Times
    renderLeaderboard(data.leaderboard);

    // Destaques Individuais
    renderIndividualRankings(data.top_scorers, data.top_winners);

    // Histórico de Partidas
    renderMatchesHistory(data.recent_matches);

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
    const isFirst = idx === 0;

    return `
      <tr class="hover:bg-card/40 transition">
        <td class="py-2.5 font-bold text-white flex items-center space-x-2">
          <span class="w-5 text-center ${isFirst ? 'text-amber-400 font-extrabold' : 'text-slate-500'}">${idx + 1}</span>
          <span>${escapeHtml(t.name)}</span>
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
      scorersEl.innerHTML = scorers.filter(s => s.goals > 0).slice(0, 5).map((s, idx) => `
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
      winnersEl.innerHTML = winners.filter(w => w.wins > 0).slice(0, 5).map((w, idx) => `
        <div class="flex items-center justify-between text-xs py-1.5 px-3 rounded-xl bg-card border border-borderLight/40">
          <span class="flex items-center gap-2 text-white font-medium">
            <span class="text-yellow-400 font-bold">${idx + 1}.</span>
            ${escapeHtml(w.name)}
          </span>
          <span class="font-extrabold text-slate-300">${w.wins} vitórias <span class="text-neon-accent font-semibold text-[10px]">(${w.win_rate}%)</span></span>
        </div>
      `).join("");
    }
  }
}

function renderMatchesHistory(matches) {
  const container = document.getElementById("history-matches-list");
  if (!container) return;

  if (!matches || matches.length === 0) {
    container.innerHTML = `<p class="text-sm text-slate-500 text-center py-6">Nenhuma partida finalizada no histórico.</p>`;
    return;
  }

  container.innerHTML = matches.map(m => {
    return `
      <div class="p-4 bg-card hover:bg-cardLight border border-borderLight rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3 transition">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold text-slate-400">Rodada ${m.round_number}</span>
            <span class="text-slate-600">•</span>
            <span class="text-xs text-emerald-400 font-medium">🕒 ${m.played_at || 'Data não gravada'} (Brasília)</span>
          </div>

          <div class="text-base font-extrabold text-white flex items-center gap-3">
            <span class="${m.winner_team_id === m.home_team_id ? 'text-neon-accent' : ''}">${escapeHtml(m.home_team_name)}</span>
            <span class="px-2.5 py-0.5 rounded-lg bg-pitch border border-borderLight text-white font-black text-sm">${m.home_score} - ${m.away_score}</span>
            <span class="${m.winner_team_id === m.away_team_id ? 'text-neon-accent' : ''}">${escapeHtml(m.away_team_name)}</span>
          </div>
        </div>

        <button onclick="verDetalhesPartida('${m.id}')" class="text-xs px-3 py-2 bg-surface hover:bg-card border border-borderLight rounded-xl text-slate-300 hover:text-white transition flex items-center justify-center gap-1.5 self-start md:self-auto">
          <i data-lucide="eye" class="w-3.5 h-3.5 text-neon-accent"></i>
          <span>Ver Integrantes & Detalhes</span>
        </button>
      </div>
    `;
  }).join("");

  lucide.createIcons();
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

  const isHomeWinner = match.winner_team_id === match.home_team_id;
  const isAwayWinner = match.winner_team_id === match.away_team_id;

  content.innerHTML = `
    <div>
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span>Partida Rodada ${match.round_number}</span>
        <span>•</span>
        <span class="text-emerald-400 font-semibold">${match.played_at || ''} (Horário de Brasília)</span>
      </div>
      <h3 class="text-xl font-black text-white mt-1">
        ${escapeHtml(match.home_team_name)} <span class="text-neon-accent">${match.home_score} x ${match.away_score}</span> ${escapeHtml(match.away_team_name)}
      </h3>
      <p class="text-xs text-slate-400 mt-0.5">
        ${match.is_draw ? 'Empate registrado' : `Vencedor: 🏆 ${isHomeWinner ? match.home_team_name : match.away_team_name}`}
      </p>
    </div>

    <div class="grid grid-cols-2 gap-4 text-xs pt-2">
      <!-- Elenco Mandante -->
      <div class="space-y-2 bg-card p-3 rounded-2xl border ${isHomeWinner ? 'border-emerald-500/40 bg-emerald-950/10' : 'border-borderLight'}">
        <h4 class="font-bold text-white flex items-center justify-between">
          <span>${escapeHtml(match.home_team_name)}</span>
          ${isHomeWinner ? '<span class="text-[10px] text-emerald-400 font-extrabold uppercase">Venceu</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-300">
          ${(match.home_players || []).map(p => `<li>• ${escapeHtml(p.name)}</li>`).join("")}
        </ul>
      </div>

      <!-- Elenco Visitante -->
      <div class="space-y-2 bg-card p-3 rounded-2xl border ${isAwayWinner ? 'border-emerald-500/40 bg-emerald-950/10' : 'border-borderLight'}">
        <h4 class="font-bold text-white flex items-center justify-between">
          <span>${escapeHtml(match.away_team_name)}</span>
          ${isAwayWinner ? '<span class="text-[10px] text-emerald-400 font-extrabold uppercase">Venceu</span>' : ''}
        </h4>
        <ul class="space-y-1 text-slate-300">
          ${(match.away_players || []).map(p => `<li>• ${escapeHtml(p.name)}</li>`).join("")}
        </ul>
      </div>
    </div>

    <!-- Eventos de Gols -->
    ${match.events && match.events.length > 0 ? `
      <div class="pt-2 border-t border-borderLight">
        <h4 class="text-xs font-bold text-slate-300 mb-1">Gols da Partida:</h4>
        <div class="flex flex-wrap gap-1.5">
          ${match.events.map(ev => `
            <span class="text-[11px] bg-pitch px-2 py-0.5 rounded-lg border border-borderLight text-slate-300">
              ⚽ ${escapeHtml(ev.player_name)}
            </span>
          `).join("")}
        </div>
      </div>
    ` : ''}

    <div class="pt-3 border-t border-borderLight flex justify-end">
      <button onclick="closeModal()" class="px-4 py-2 bg-cardLight hover:bg-slate-700 text-white font-bold text-xs rounded-xl">Fechar</button>
    </div>
  `;

  modal.classList.remove("hidden");
  lucide.createIcons();
}

function closeModal() {
  document.getElementById("modal-match-details")?.classList.add("hidden");
}

async function limparHistorico() {
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

    if (elPerTeam) elPerTeam.value = cfg.players_per_team;
    if (elDuration) elDuration.value = cfg.match_duration_minutes;
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
  const btnAdd = document.getElementById("btn-add-custom-match");
  const actionLabel = document.getElementById("btn-fixtures-action-label");
  const btnGenerateMatches = document.getElementById("btn-generate-matches");

  if (btnAdd) {
    btnAdd.classList.toggle("hidden", !isCustom);
  }
  if (actionLabel) {
    actionLabel.textContent = isCustom ? "Recriar Auto" : "Recriar Tabela";
  }
  if (btnGenerateMatches) {
    if (isCustom) {
      btnGenerateMatches.innerHTML = `<i data-lucide="plus-circle" class="w-4 h-4"></i><span>Montar Rodadas Livres</span>`;
    } else {
      btnGenerateMatches.innerHTML = `<i data-lucide="calendar" class="w-4 h-4"></i><span>Gerar Confrontos Agora</span>`;
    }
    lucide.createIcons();
  }
}

async function salvarConfiguracoes(event) {
  event.preventDefault();
  if (window.SoundManager) window.SoundManager.play('efeitos');
  const perTeam = parseInt(document.getElementById("cfg-players-per-team").value) || 5;
  const duration = parseInt(document.getElementById("cfg-duration").value) || 10;
  const selectedFormat = document.getElementById("cfg-rounds").value;

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

  try {
    const pCode = (state.currentPelada && state.currentPelada.code) ? state.currentPelada.code : "";
    const url = pCode ? `/api/config?pelada_code=${pCode}` : "/api/config";
    const res = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(state.config)
    });
    if (res.ok) {
      atualizarVisibilidadeControlesFormato();
      sincronizarEstadoServidor();
      showToast("Configurações salvas com sucesso!");
    }
  } catch (e) {
    console.error(e);
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
