/* Despacho de eventos da interface.
 *
  * Substitui os atributos on*="..." inline (que exigiriam 'unsafe-inline' na CSP). Cada elemento declara:
 *   data-h-<evento>="nomeDaFuncao"        (ex.: data-h-click, data-h-submit, data-h-keydown)
 *   data-a='["arg", "@event", ...]'       (argumentos; tokens @event, @this, @value, @checked)
 *   data-k="Enter"                        (opcional: só dispara para essa tecla)
 * Só funções da lista ACOES_PERMITIDAS podem ser chamadas, e os argumentos são sempre dados, nunca código.
 */
(function () {
  'use strict';

  const ACOES_PERMITIDAS = new Set([
    'abrirAtribuicaoGols',
    'editarNomeTime',
    'toggleMatchTimer',
    'abrirModalNovaPartida',
    'abrirSeletorCor',
    'addSinglePlayer',
    'adicionarGolJogadorDeBotao',
    'adicionarTimeManual',
    'adjustScore',
    'aoMudarSomAlarme',
    'atualizarRotuloEstrelas',
    'editarNomeJogador',
    'onPoolLinkChange',
    'autoSalvarConfiguracoes',
    'submeterNovaPartida',
    'submeterSenhaMestra',
    'clearPlayers',
    'closeModal',
    'concluirAtribuicaoGols',
    'copiarCodigoPelada',
    'copiarLinkPelada',
    'criarNovaPelada',
    'cyclePlayerLevel',
    'desvincularPool',
    'removerPool',
    'entrarNaPelada',
    'escolherCorTime',
    'executarAssumirAdmin',
    'exportarPelada',
    'exportarRelatorioPDF',
    'filterChartPlayerSearch',
    'gerarTabelaConfrontos',
    'importarPelada',
    'importBulkPlayers',
    'inicioRapido',
    'limparHistorico',
    'limparTodasRodadas',
    'mostrarArquivoImportacao',
    'mudarPaginaHistorico',
    'onCardDragLeave',
    'onCardDragOver',
    'onCardDrop',
    'onCustomAwayChange',
    'onCustomHomeChange',
    'onDragEnd',
    'onFixtureDragEnd',
    'onFixtureDragLeave',
    'onFixtureDragOver',
    'onFixtureDragStart',
    'onFixtureDrop',
    'onRoundDragOver',
    'onRoundDrop',
    'onPlayerDragStart',
    'onTeamDragStart',
    'onToggleChartPlayerCheckbox',
    'reabrirPartida',
    'removePlayer',
    'removerGolJogador',
    'removerInicioPartida',
    'removerJogadorDoTime',
    'removerPartidaCustomizada',
    'removerTime',
    'sairPelada',
    'salvarPartidaFinalizada',
    'salvarPoolPeladas',
    'scrollPlayersListDown',
    'scrollPlayersListUp',
    'scrollScorersListDown',
    'scrollScorersListUp',
    'scrollWinnersListDown',
    'scrollWinnersListUp',
    'selectAllChartPlayers',
    'setDashboardChartMetric',
    'sortearTimes',
    'submitConfiguracoes',
    'irParaPartidaEmAndamento',
    'switchTab',
    'testarSomAlarme',
    'togglePlayerFilterDropdown',
    'togglePlayerRole',
    'toggleSoundMute',
    'verDetalhesPartida'
  ]);

  const EVENTOS = ['click', 'change', 'input', 'submit', 'keydown', 'dragstart', 'dragend', 'dragover', 'dragleave', 'drop', 'dblclick'];

  function resolverArgumento(valor, evento, elemento) {
    switch (valor) {
      case '@event': return evento;
      case '@this': return elemento;
      case '@value': return elemento.value;
      case '@checked': return elemento.checked;
      default: return valor;
    }
  }

  function invocar(elemento, evento) {
    const nome = elemento.getAttribute('data-h-' + evento.type);
    if (!nome) return;
    const tecla = elemento.getAttribute('data-k');
    if (tecla && evento.key !== tecla) return;
    if (!ACOES_PERMITIDAS.has(nome) || typeof window[nome] !== 'function') return;

    let args = [];
    const brutos = elemento.getAttribute('data-a');
    if (brutos) {
      try {
        args = JSON.parse(brutos).map((v) => resolverArgumento(v, evento, elemento));
      } catch (erro) {
        console.error('Argumentos inválidos para ' + nome, erro);
        return;
      }
    }
    window[nome].apply(elemento, args);
  }

  // Percorre os ancestrais do alvo, como a propagação de eventos faria com handlers inline.
  // Handlers recebem o próprio elemento como `this` (equivale a event.currentTarget no handler inline).
  function despachar(evento) {
    let alvo = evento.target instanceof Element ? evento.target : null;
    while (alvo) {
      if (alvo.hasAttribute('data-h-' + evento.type)) {
        invocar(alvo, evento);
        // Mesmo efeito de stopPropagation() em handlers inline: interrompe a subida pelos ancestrais
        if (evento.cancelBubble) break;
      }
      alvo = alvo.parentElement;
    }
  }

  EVENTOS.forEach((tipo) => document.addEventListener(tipo, despachar));

  // Ícones Lucide: renderização resiliente (aguarda carregamento assíncrono ou Rocket Loader se necessário)
  window.refreshIcons = function () {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try {
        window.lucide.createIcons();
      } catch (err) {
        console.warn('Erro ao atualizar ícones Lucide:', err);
      }
    }
  };
  window.refreshIcons();

  // Se o script do Lucide ainda estiver carregando (ex.: rede lenta, proxy ou cache), agenda retentativas seguras
  if (!window.lucide || typeof window.lucide.createIcons !== 'function') {
    let tentativas = 0;
    const intervalId = setInterval(() => {
      tentativas++;
      if (window.lucide && typeof window.lucide.createIcons === 'function') {
        clearInterval(intervalId);
        window.refreshIcons();
      } else if (tentativas >= 50) {
        clearInterval(intervalId);
      }
    }, 100);
  }

  // Registro do Service Worker para PWA
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => console.log('FutMatch PWA Service Worker registrado:', reg.scope))
        .catch((err) => console.warn('Erro ao registrar Service Worker:', err));
    });
  }
})();
