// Service worker — notifications + an offline fallback.
//
// Notifications are the main reason this file must exist: Android Chrome
// refuses `new Notification()` from a page, so they have to come from a
// registration's showNotification(). See js/notify.js.
//
// Caching is network-first and opportunistic. There is no hardcoded app-shell
// list (the old one was pinned at ?v=15 while the app had moved on to v26 — a
// list like that silently rots every release). Every successful same-origin GET
// of an app asset is copied in, and the cache is only ever read when the network
// fails. An online client therefore always gets fresh code, which is also what
// keeps js/update.js honest: it detects releases by fetching the deployed
// index.html, and must never be handed a stale copy.
// Bump this whenever the cache KEY scheme changes (not per release — the keys
// are release-independent by design). A rename is what clears entries written
// under the old scheme; activate() deletes every cache that isn't this one.
const CACHE_NAME = 'timer-runtime-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
  await self.clients.claim();
})()));

// Cache entries are keyed by path with the query stripped, so `style.css?v=27`
// replaces `style.css?v=26` instead of piling up next to it — one entry per
// file, forever. (Without this, every ?v= bump and every cache-busted
// index.html?_=<now> poll from update.js would leave a new entry behind.)
const CACHEABLE = /\.(?:html|css|js|json|png|svg|ico|webmanifest)$/;
function cacheKey(url) {
  const path = url.pathname === '/' || url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  return new Request(url.origin + path);
}
function isCacheable(url) {
  return url.pathname === '/' || url.pathname.endsWith('/') || CACHEABLE.test(url.pathname);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // Firebase & friends: untouched
  if (!isCacheable(url)) return;

  e.respondWith((async () => {
    const key = cacheKey(url);
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(key, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key);
      if (hit) return hit;
      // A navigation to a URL we've never cached still gets the app shell.
      // Resolved against the registration scope, not the origin root — Pages
      // serves this app from a subpath (/houronly-timer/).
      if (req.mode === 'navigate') {
        const shell = await caches.match(new Request(new URL('index.html', self.registration.scope).href));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

// Tapping a notification focuses the app rather than opening a second copy.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of open) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
