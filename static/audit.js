// FutMatch Telemetry & Audit Service
(function() {
  const BATCH_INTERVAL_MS = 2000;
  const MAX_BATCH_SIZE = 10;
  const ENDPOINT = '/api/audit/events';

  // ID anônimo único por sessão do navegador
  function getSessionId() {
    let sid = sessionStorage.getItem('futmatch_sid');
    if (!sid) {
      sid = 'sid_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
      sessionStorage.setItem('futmatch_sid', sid);
    }
    return sid;
  }

  const queue = [];
  let flushTimer = null;

  function formatBRT(date) {
    // Retorna DD/MM/YYYY HH:MM:SS
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  }

  function flushEvents() {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);

    const payload = JSON.stringify({ events: batch });

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      const sent = navigator.sendBeacon(ENDPOINT, blob);
      if (!sent) {
        fallbackFetch(payload);
      }
    } else {
      fallbackFetch(payload);
    }
  }

  function fallbackFetch(payload) {
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    }).catch(function() {});
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function() {
      flushTimer = null;
      flushEvents();
    }, BATCH_INTERVAL_MS);
  }

  function trackEvent(action, target, category = 'action', metadata = {}) {
    try {
      const peladaCode = (window.state && window.state.currentPelada && window.state.currentPelada.code)
        ? window.state.currentPelada.code
        : (localStorage.getItem('futmatch_active_pelada') || null);

      const event = {
        timestamp: formatBRT(),
        created_at_ts: Date.now() / 1000,
        pelada_code: peladaCode,
        session_id: getSessionId(),
        category: category,
        action: action,
        target: target || null,
        status: metadata.status || 'success',
        duration_ms: metadata.duration_ms || 0,
        metadata: metadata
      };

      queue.push(event);

      if (queue.length >= MAX_BATCH_SIZE) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushEvents();
      } else {
        scheduleFlush();
      }
    } catch (e) {
      console.warn("Erro ao registrar auditoria:", e);
    }
  }

  // Intercepta descarregamento da página para não perder logs pendentes
  window.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') {
      flushEvents();
    }
  });

  window.addEventListener('pagehide', function() {
    flushEvents();
  });

  // Listener global de delegação para capturar qualquer elemento interativo relevante
  document.addEventListener('click', function(e) {
    try {
      const btn = e.target.closest('button, a[role="button"], [data-audit]');
      if (!btn) return;

      const auditAction = btn.getAttribute('data-audit');
      const targetId = btn.id || btn.name || btn.className.split(' ')[0] || btn.innerText.trim().slice(0, 30);

      // Se tiver anotação explícita ou for um botão comum
      if (auditAction) {
        trackEvent(auditAction, targetId, 'action');
      } else if (btn.id) {
        // Mapeia botões padrão do FutMatch
        trackEvent(`click_${btn.id}`, btn.id, 'action', { text: btn.innerText.trim().slice(0, 30) });
      }
    } catch (err) {}
  }, true);

  // Expõe no escopo global
  window.auditTracker = {
    track: trackEvent,
    flush: flushEvents,
    getSessionId: getSessionId
  };
})();
