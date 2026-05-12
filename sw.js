/* ═══════════════════════════════════════════════════
   LOVE GALLERY — Service Worker  (PWA Offline Support)
   Cache-first untuk aset statis, network-first untuk
   data dinamis. Galeri tetap bisa dibuka tanpa internet.
═══════════════════════════════════════════════════ */

const CACHE_NAME    = 'lovegallery-v2';
const CACHE_TIMEOUT = 3000; // 3 detik timeout untuk fetch

// Aset inti yang selalu di-cache saat install
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './db.js',
  './sw.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=DM+Sans:wght@300;400;500&display=swap',
];

/* ── Install: pre-cache aset inti ───────────────── */
self.addEventListener('install', event => {
  console.log('[SW] Installing Love Gallery Service Worker...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Tambahkan satu-satu, ignore error (misal: font offline)
      return Promise.allSettled(
        CORE_ASSETS.map(url => cache.add(url).catch(err => {
          console.warn('[SW] Gagal cache:', url, err.message);
        }))
      );
    }).then(() => {
      console.log('[SW] Core assets cached ✅');
      return self.skipWaiting(); // aktif segera
    })
  );
});

/* ── Activate: hapus cache lama ─────────────────── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => { console.log('[SW] Hapus cache lama:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim()) // ambil alih halaman yang sudah terbuka
  );
});

/* ── Fetch: strategi per tipe request ───────────── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Abaikan request non-GET
  if (event.request.method !== 'GET') return;

  // Abaikan chrome-extension dan dev tools
  if (!url.protocol.startsWith('http')) return;

  // Fonts Google: cache-first dengan fallback
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Aset lokal (html, css, js): cache-first (stale-while-revalidate)
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Lainnya: network-first dengan fallback ke cache
  event.respondWith(networkFirst(event.request));
});

/* ── Strategi: Cache First ───────────────────────── */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

/* ── Strategi: Stale While Revalidate ───────────── */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || new Response('Offline', { status: 503 });
}

/* ── Strategi: Network First ────────────────────── */
async function networkFirst(request) {
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CACHE_TIMEOUT)),
    ]);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ── Background Sync (opsional) ──────────────────── */
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_NAME });
  }
});