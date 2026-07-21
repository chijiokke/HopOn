// HopOn Service Worker — works locally & on GitHub Pages
const CACHE = 'hopon-v20';

// Determine base path dynamically (handles both / and /HopOn/ on GitHub Pages)
const BASE = self.location.pathname.replace(/sw\.js$/, '');

const ASSETS = [
  BASE + 'index.html',
  BASE + 'index.css?v=20',
  BASE + 'manifest.json',
  'https://fonts.googleapis.com/css2?family=Fredoka:wght@300..700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  
  // Only handle http/https requests to avoid cracking chrome-extension or other schemes
  const url = new URL(e.request.url);
  if (!url.protocol.startsWith('http')) return;

  const isHtml = url.pathname.endsWith('.html') || url.pathname === BASE || url.pathname === BASE + 'index.html';

  if (isHtml) {
    // Network-First strategy for HTML files to ensure instant updates when online
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-First (Stale-While-Revalidate) for other static assets (images, CSS, fonts)
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
