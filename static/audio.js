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
    muted: false
  },

  // Efeitos Sonoros / Músicas individuais ou listas para sorteio
  // Você pode configurar cada ação apontando para um único arquivo de áudio
  // ou para um array (lista) de arquivos. Quando for array, um deles será sorteado aleatoriamente!
  registry: {
    // Músicas tocadas aleatoriamente ao entrar ou criar pelada
    abertura: [
      '/static/music/fifa-world-cup-theme.mp3',
      '/static/music/galaxy-meme.mp3',
      '/static/music/indian-song.mp3',
      '/static/music/mentalista.mp3',
      '/static/music/run-vine-sound-effect.mp3',
      '/static/music/spiderman-meme-song.mp3'
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
    ]
  },

  // Instância da música atualmente em reprodução (para controle de parada e troca)
  _currentMusic: null,
  _currentMusicAction: null,

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
    if (this.settings.muted && this._currentMusic) {
      this._currentMusic.pause();
    } else if (!this.settings.muted && this._currentMusic) {
      this._currentMusic.play().catch(e => console.warn(e));
    }
    return this.settings.muted;
  }
};

// Disponibiliza globalmente
window.SoundManager = SoundManager;
