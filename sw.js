// Bump CACHE_NAME whenever any cached asset below changes (mirrors the
// ?v= bump on index.html assets) so old clients don't get stuck on stale files.
const CACHE_NAME = 'timer-cache-v15';
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=15',
  './manifest.json',
  './js/constants.js?v=15',
  './js/model.js?v=15',
  './js/storage.js?v=15',
  './js/study.js?v=15',
  './js/timer.js?v=15',
  './js/dashboard.js?v=15',
  './js/sessions.js?v=15',
  './js/sync.js?v=15',
  './js/notes.js?v=15',
  './js/pwa.js?v=15',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin requests so users get fresh code when online,
// falling back to the cached app shell when offline.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
