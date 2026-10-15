/**
 * MinattoFlix Service Worker
 * Caches static assets and enables offline playback for HLS segments
 */

const CACHE_NAME = 'minattoflix-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

const CACHE_STRATEGIES = {
  // Cache first for static assets
  static: 'cache-first',
  // Network first for API calls
  api: 'network-first',
  // Stale while revalidate for HLS manifests
  hls: 'stale-while-revalidate',
  // Cache only for HLS segments (once downloaded, keep forever)
  hlsSegment: 'cache-only',
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

function getCacheStrategy(url: string): string {
  if (url.includes('/api/stream/hls/') && url.endsWith('.m3u8')) {
    return CACHE_STRATEGIES.hls;
  }
  if (url.includes('/api/stream/hls/') && url.endsWith('.m4s')) {
    return CACHE_STRATEGIES.hlsSegment;
  }
  if (url.includes('/api/')) {
    return CACHE_STRATEGIES.api;
  }
  return CACHE_STRATEGIES.static;
}

async function handleRequest(event: FetchEvent) {
  const url = new URL(event.request.url);
  const strategy = getCacheStrategy(event.request.url);
  const cache = await caches.open(CACHE_NAME);

  switch (strategy) {
    case 'cache-first': {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        return new Response('Offline', { status: 503 });
      }
    }

    case 'network-first': {
      try {
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(event.request);
        return cached || new Response('Offline', { status: 503 });
      }
    }

    case 'stale-while-revalidate': {
      const cached = await cache.match(event.request);
      const fetchPromise = fetch(event.request).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    }

    case 'cache-only': {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        return new Response('Offline', { status: 503 });
      }
    }

    default:
      return fetch(event.request);
  }
}

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  
  // Skip cross-origin requests that aren't our API
  const url = new URL(event.request.url);
  if (url.origin !== location.origin && !url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(handleRequest(event));
});

// Background sync for offline queue
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-playback-progress') {
    event.waitUntil(syncPlaybackProgress());
  }
});

async function syncPlaybackProgress() {
  const cache = await caches.open(CACHE_NAME);
  const requests = await cache.keys();
  const progressRequests = requests.filter((req) => 
    req.url.includes('/api/progress') && req.method === 'POST'
  );
  
  for (const req of progressRequests) {
    try {
      await fetch(req);
      await cache.delete(req);
    } catch {
      // Keep in queue for next sync
    }
  }
}

// Message handling for skip waiting
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});