const VERSION = '__RELEASE__';
const APP_PREFIX = `walk-advisor:${self.registration.scope}:`;
const CACHE_NAME = `${APP_PREFIX}${VERSION}`;
const FILES = __PRECACHE__;
const absolute = path => new URL(path, self.registration.scope).href;
const FILE_URLS = new Set(FILES.map(absolute));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await Promise.all(FILES.map(async path => {
        const url = absolute(path);
        const freshUrl = new URL(url);
        freshUrl.searchParams.set('release', VERSION);
        const response = await fetch(freshUrl, { cache: 'reload' });
        if (!response.ok) throw new Error(`Could not install ${path}`);
        await cache.put(url, response);
      }));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Preserve old hashed assets for open windows. A fresh visit with no older
    // windows can safely discard old releases; never touch another app's caches.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const appWindows = windows.filter(client => client.url.startsWith(self.registration.scope));
    if (appWindows.length === 0) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith(APP_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (event.request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  // Recovery must always reach the network, independently of the app shell.
  if (url.pathname === new URL('update.html', scope).pathname || url.pathname === new URL('sw.js', scope).pathname || url.pathname === new URL('release.json', scope).pathname) return;
  if (event.request.mode === 'navigate') {
    if (url.pathname !== scope.pathname && url.pathname !== new URL('index.html', scope).pathname) return;
    event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(absolute('index.html'))).then(cached => cached || fetch(event.request)));
    return;
  }
  event.respondWith((async () => {
    const canonical = new URL(url);
    canonical.search = '';
    if (FILE_URLS.has(canonical.href)) {
      const cached = await (await caches.open(CACHE_NAME)).match(canonical.href);
      if (cached) return cached;
    }
    // Exact old hashed URLs remain usable when another window accepts an update.
    const names = (await caches.keys()).filter(name => name.startsWith(APP_PREFIX));
    for (const name of names) {
      const cached = await (await caches.open(name)).match(url.href);
      if (cached) return cached;
    }
    return fetch(event.request);
  })());
});
