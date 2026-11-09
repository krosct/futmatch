/**
 * FutMatch - Módulo de Gerenciamento de Áudios e Músicas
 * 
 * Executa sons de forma 100% oculta em segundo plano.
 * Suporta sorteio de faixas para uma mesma ação (random pool),
 * controle de volume, crossfade/parada de música anterior e pré-carregamento.
 */

const SoundManager = {
  // Configurações gerais
  settings: {
    soundVolume: 0.8,
    musicVolume: 0.5,
    muted: typeof localStorage !== 'undefined' ? localStorage.getItem('futmatch_sound_muted') === 'true' : false
  },

  // Efeitos Sonoros / Músicas individuais ou listas para sorteio
  // Você pode configurar cada ação apontando para um único arquivo de áudio
  // ou para um array (lista) de arquivos. Quando for array, um deles será sorteado aleatoriamente!
  registry: {
    // Músicas tocadas aleatoriamente ao entrar ou criar pelada
    abertura: [
      '/static/music/dancing-shower.mp3',
      '/static/music/dj-chicken.mp3',
      '/static/music/fifa-world-cup-theme.mp3',
      '/static/music/galaxy-meme.mp3',
      '/static/music/indian-song.mp3',
      '/static/music/jettism-goodbye.mp3',
      '/static/music/mentalista.mp3',
      '/static/music/pega-o-pato.mp3',
      '/static/music/ps2_start_up.mp3',
      '/static/music/run-vine-sound-effect.mp3',
      '/static/music/spiderman-meme-song.mp3',
      '/static/music/vinheta-galvao-do-tetra.mp3'
    ],
    // Efeitos sonoros aleatórios para os botões e ações do sistema
    efeitos: [
      '/static/sounds/139-item-catch.mp3',
      '/static/sounds/abrindo-latinha.mp3',
      '/static/sounds/bem-te-vi-assobio.mp3',
      '/static/sounds/camera-flash-sound-effect.mp3',
      '/static/sounds/correct.mp3',
      '/static/sounds/cringe-sus-anime-girl.mp3',
      '/static/sounds/ea-sports-its-in-the-game.mp3',
      '/static/sounds/efeitos-sonoros-fiu-fiu.mp3',
      '/static/sounds/faaaa.mp3',
      '/static/sounds/maro-jump-sound-effect_1.mp3',
      '/static/sounds/michael-jackson-hee-hee.mp3',
      '/static/sounds/money-soundfx.mp3',
      '/static/sounds/msn-alert_TktfiPZ.mp3',
      '/static/sounds/oh-my-god-meme.mp3',
      '/static/sounds/ole.mp3',
      '/static/sounds/oooo-o-gas-oia-o-gas.mp3',
      '/static/sounds/pabllo-vittar-aiin-q-deliciaann-uarroinn-original.mp3',
      '/static/sounds/perfect-fart.mp3',
      '/static/sounds/piuw.mp3',
      '/static/sounds/quack_5.mp3',
      '/static/sounds/six-seven_okPwnRN.mp3',
      '/static/sounds/som-de-brilho.mp3',
      '/static/sounds/surpresaaaaaaa.mp3',
      '/static/sounds/whatsapp-whistle.mp3',
      '/static/sounds/wow_8.mp3',
      '/static/sounds/y2mate_rLgMJTu.mp3',
      '/static/sounds/yahoojingle.mp3'
    ],
    // Sons de alarme disponíveis para o fim da partida
    alarms: [
      '/static/alarms/standard-emergency-warning-signal.mp3',
      '/static/alarms/samsung-alarm-morning-flower.mp3',
      '/static/alarms/this-is-the-end-adele.mp3',
      '/static/alarms/end_Mz9V9Hh.mp3',
      '/static/alarms/electronic-alarm-clock-buzz-sfx-sound-effect-17-audiotrimmer.mp3',
      '/static/alarms/alarm-danger-danger.mp3',
      '/static/alarms/police-alarm.mp3',
      '/static/alarms/warning-alarm-loud-af.mp3'
    ]
  },

  // Instância da música atualmente em reprodução (para controle de parada e troca)
  _currentMusic: null,
  _currentMusicAction: null,

  // Instância de prévia de áudio (para teste de alarme nas configurações)
  _previewAudio: null,
  _previewSrc: null,

  // Cache de instâncias de áudio para desempenho rápido
  _audioCache: new Map(),

  /**
   * Registra ou atualiza ações de áudio
   * @param {string} actionName Nome do evento/ação (ex: 'gol', 'sorteio', 'fimPartida')
   * @param {string|string[]} sources Caminho ou array de caminhos dos arquivos de som
   */
  register(actionName, sources) {
    this.registry[actionName] = Array.isArray(sources) ? sources : [sources];
  },

  /**
   * Registra múltiplas ações de uma vez
   * @param {Object.<string, string|string[]>} configMap 
   */
  registerAll(configMap) {
    for (const [action, sources] of Object.entries(configMap)) {
      this.register(action, sources);
    }
  },

  /**
   * Sorteia um arquivo de áudio de uma lista associada à ação
   * @private
   */
  _pickRandomSource(actionName) {
    const list = this.registry[actionName];
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const randomIndex = Math.floor(Math.random() * list.length);
    return list[randomIndex];
  },

  /**
   * Toca um efeito sonoro rápido (oculto, com disparo instantâneo)
   * Se a ação contiver vários arquivos, sorteia um deles.
   * @param {string} actionName Nome da ação registrada
   * @param {number} [customVolume] Volume opcional entre 0.0 e 1.0
   */
  play(actionName, customVolume = null) {
    if (this.settings.muted) return;

    const source = this._pickRandomSource(actionName);
    if (!source) {
      console.warn(`[SoundManager] Nenhuma faixa registrada para a ação: "${actionName}"`);
      return;
    }

    try {
      // Cria instância pontual para permitir sobreposição de efeitos simultâneos
      const audio = new Audio(source);
      audio.volume = customVolume !== null ? customVolume : this.settings.soundVolume;
      audio.play().catch(err => {
        // Trata restrições de autoplay caso o usuário ainda não tenha interagido
        console.warn(`[SoundManager] Não foi possível reproduzir som para "${actionName}":`, err);
      });
      if (window.auditTracker) {
        window.auditTracker.track('play_sound_effect', source, 'media', { action: actionName, volume: audio.volume });
      }
    } catch (e) {
      console.error('[SoundManager] Erro ao instanciar áudio:', e);
    }
  },

  /**
   * Toca uma música em segundo plano (oculta).
   * Interrompe qualquer música que estiver tocando antes de iniciar a nova (com fade out).
   * Se a ação contiver um array de músicas, sorteia uma aleatoriamente!
   * @param {string} actionName Nome da ação registrada
   * @param {boolean} [loop=false] Se a música deve ficar em loop
   * @param {number} [customVolume] Volume opcional entre 0.0 e 1.0
   * @param {number} [fadeOutMs=1000] Duração do fade out da música anterior em milissegundos
   */
  playMusic(actionName, loop = false, customVolume = null, fadeOutMs = 1000) {
    if (this.settings.muted) return;

    const source = this._pickRandomSource(actionName);
    if (!source) {
      console.warn(`[SoundManager] Nenhuma música registrada para a ação: "${actionName}"`);
      return;
    }

    // Se já estiver tocando algo, interrompe com fade out de 1s
    this.stopMusic(fadeOutMs);

    try {
      const audio = new Audio(source);
      audio.loop = loop;
      audio.volume = customVolume !== null ? customVolume : this.settings.musicVolume;
      
      this._currentMusic = audio;
      this._currentMusicAction = actionName;

      audio.play().catch(err => {
        console.warn(`[SoundManager] Não foi possível reproduzir música "${actionName}":`, err);
      });

      // Limpa referência quando terminar caso não seja loop
      audio.addEventListener('ended', () => {
        if (this._currentMusic === audio) {
          this._currentMusic = null;
          this._currentMusicAction = null;
        }
      });
    } catch (e) {
      console.error('[SoundManager] Erro ao instanciar música:', e);
    }
  },

  /**
   * Para a música atualmente em execução com transição suave (fade out)
   * @param {number} [durationMs=1000] Duração do fade out em milissegundos (padrão: 1000ms = 1s)
   */
  stopMusic(durationMs = 1000) {
    if (!this._currentMusic) return;

    const audio = this._currentMusic;
    this._currentMusic = null;
    this._currentMusicAction = null;

    if (durationMs <= 0 || audio.paused) {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch (e) {}
      return;
    }

    // Fade out linear de 1 segundo (atualizado a cada 50ms)
    const initialVolume = audio.volume;
    const steps = 20;
    const intervalTime = durationMs / steps;
    const volumeStep = initialVolume / steps;

    const fadeInterval = setInterval(() => {
      try {
        if (audio.volume > volumeStep) {
          audio.volume = Math.max(0, audio.volume - volumeStep);
        } else {
          audio.volume = 0;
          audio.pause();
          audio.currentTime = 0;
          clearInterval(fadeInterval);
        }
      } catch (e) {
        clearInterval(fadeInterval);
      }
    }, intervalTime);
  },

  /**
   * Pausa a música atual
   */
  pauseMusic() {
    if (this._currentMusic) {
      this._currentMusic.pause();
    }
  },

  /**
   * Retoma a música pausada
   */
  resumeMusic() {
    if (this._currentMusic && !this.settings.muted) {
      this._currentMusic.play().catch(e => console.warn(e));
    }
  },

  /**
   * Alterna mudo/desmudo geral
   */
  toggleMute() {
    this.settings.muted = !this.settings.muted;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('futmatch_sound_muted', this.settings.muted);
    }
    if (this.settings.muted && this._currentMusic) {
      this._currentMusic.pause();
    } else if (!this.settings.muted && this._currentMusic) {
      this._currentMusic.play().catch(e => console.warn(e));
    }
    if (window.auditTracker) {
      window.auditTracker.track('toggle_sound_mute', 'btn-toggle-sound', 'media', { muted: this.settings.muted });
    }
    return this.settings.muted;
  },

  /**
   * Sincroniza dinamicamente a lista de músicas e efeitos com os arquivos da pasta via backend
   */
  async loadDynamicCatalog() {
    try {
      const res = await fetch('/api/audio-catalog');
      if (res.ok) {
        const catalog = await res.json();
        if (catalog.abertura && Array.isArray(catalog.abertura) && catalog.abertura.length > 0) {
          this.registry.abertura = catalog.abertura;
        }
        if (catalog.efeitos && Array.isArray(catalog.efeitos) && catalog.efeitos.length > 0) {
          this.registry.efeitos = catalog.efeitos;
        }
        if (catalog.alarms && Array.isArray(catalog.alarms) && catalog.alarms.length > 0) {
          this.registry.alarms = catalog.alarms;
        }
      }
    } catch (e) {
      console.warn('[SoundManager] Não foi possível carregar catálogo dinâmico de áudio do servidor, mantendo faixas locais:', e);
    }
  },

  /**
   * Toca ou para uma prévia de som (por exemplo, ao testar alarme no dropdown)
   * @param {string} source Caminho do arquivo ou nome do arquivo
   * @param {Function} [onEndCallback] Chamado quando a prévia terminar ou parar
   * @returns {boolean} true se começou a tocar, false se parou
   */
  togglePreview(source, onEndCallback = null) {
    let fullPath = source;
    if (!fullPath.startsWith('/') && !fullPath.startsWith('http')) {
      fullPath = `/static/alarms/${source}`;
    }

    if (this._previewAudio && this._previewSrc === fullPath && !this._previewAudio.paused) {
      this._previewAudio.pause();
      this._previewAudio.currentTime = 0;
      this._previewAudio = null;
      this._previewSrc = null;
      if (onEndCallback) onEndCallback(false);
      return false;
    }

    if (this._previewAudio) {
      this._previewAudio.pause();
      this._previewAudio.currentTime = 0;
      this._previewAudio = null;
    }

    try {
      const audio = new Audio(fullPath);
      audio.volume = this.settings.soundVolume;
      this._previewAudio = audio;
      this._previewSrc = fullPath;
      audio.onended = () => {
        this._previewAudio = null;
        this._previewSrc = null;
        if (onEndCallback) onEndCallback(false);
      };
      audio.play().catch(e => {
        console.warn('[SoundManager] Erro ao tocar prévia:', e);
        if (onEndCallback) onEndCallback(false);
      });
      if (onEndCallback) onEndCallback(true);
      return true;
    } catch (e) {
      console.error('[SoundManager] Falha ao instanciar prévia:', e);
      if (onEndCallback) onEndCallback(false);
      return false;
    }
  },

  stopPreview() {
    if (this._previewAudio) {
      this._previewAudio.onended = null;
      this._previewAudio.pause();
      this._previewAudio.currentTime = 0;
      this._previewAudio = null;
      this._previewSrc = null;
    }
  },

  /**
   * Toca o alarme especificado ou o padrão.
   * O alarme possui prioridade máxima e toca MESMO se o app estiver silenciado/mutado.
   * @param {string} [alarmName] Nome do arquivo do alarme
   */
  playAlarm(alarmName = null) {
    let path = alarmName;
    if (!path) {
      path = '/static/alarms/standard-emergency-warning-signal.mp3';
    } else if (!path.startsWith('/') && !path.startsWith('http')) {
      path = `/static/alarms/${path}`;
    }

    try {
      const audio = new Audio(path);
      audio.volume = this.settings.soundVolume || 0.8;
      audio.play().catch(err => {
        console.warn('[SoundManager] Não foi possível reproduzir som de alarme:', err);
      });
    } catch (e) {
      console.error('[SoundManager] Erro ao disparar alarme:', e);
    }
  }
};

// Disponibiliza globalmente
window.SoundManager = SoundManager;

// Inicializa catálogo dinâmico automaticamente ao carregar
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SoundManager.loadDynamicCatalog());
  } else {
    SoundManager.loadDynamicCatalog();
  }
}
