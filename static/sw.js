const CACHE_NAME = 'futmatch-v19';
const STATIC_ASSETS = [
  '/',
  '/static/index.html',
  '/static/app.js',
  '/static/handlers.js',
  '/static/audio.js',
  '/static/audit.js',
  '/static/css/tailwind.css',
  '/static/lib/fonts.css',
  '/static/lib/fonts/outfit-latin-400-normal.woff2',
  '/static/lib/fonts/outfit-latin-700-normal.woff2',
  '/static/lib/lucide.min.js',
  '/static/lib/chart.umd.min.js',
  '/static/lib/confetti.browser.min.js',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/favicon.svg',
  '/static/icons/apple-touch-icon.png',
  '/static/bg-pitch.jpg',
  '/static/img/hero-pitch.jpg',
  '/static/html2canvas.min.js',
  '/static/jspdf.umd.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('FutMatch SW: Falha ao pré-cachear alguns assets', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Ignora requisições de API para não travar dados em tempo real
  if (event.request.url.includes('/api/')) {
    return;
  }

  // Network-First com fallback para cache
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
