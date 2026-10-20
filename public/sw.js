/* Cache only same-origin public assets. Authenticated API/media always use the network. */
const CACHE_NAME = 'minattoflix-static-v3';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(['/', '/index.html', '/manifest.json'])));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('minattoflix-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')
    || request.headers.has('Authorization') || request.headers.has('Range') || url.searchParams.has('session')) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch { return await caches.match('/index.html') || new Response('Sem conexão.', { status: 503 }); }
    })());
    return;
  }
  if (!['script','style','image','font','manifest'].includes(request.destination)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && !/private|no-store/i.test(response.headers.get('Cache-Control') || '')) {
      event.waitUntil((async () => {
        await cache.put(request, response.clone());
        const keys = await cache.keys();
        await Promise.all(keys.slice(0, Math.max(0, keys.length - 150)).filter(key => new URL(key.url).pathname.startsWith('/assets/')).map(key => cache.delete(key)));
      })());
    }
    return response;
  })());
});
self.addEventListener('message', event => { if (event.data === 'skipWaiting') self.skipWaiting(); });
