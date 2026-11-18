// Service Worker: macht Rackbook installierbar und hält den zuletzt geladenen Stand zum Lesen ohne Verbindung bereit.
// Strategie überall „erst Netz, dann Zwischenspeicher“ – online ist also immer der aktuelle Stand zu sehen.
const CACHE = 'rackbook-v1';
// Nur lesende Abfragen, die die App zum Anzeigen braucht
const API = /^\/api\/(auth\/state|docs|folders|meta|synced|assets|assets\/ip-overview|templates)$/;
const STATIC = /^\/(js|css|fonts|vendor|icons)\/|^\/(favicon\.svg|manifest\.webmanifest|mermaid-frame\.html)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));
// Beim Abmelden alles Gespeicherte verwerfen
self.addEventListener('message', e => { if (e.data === 'clear') e.waitUntil(caches.delete(CACHE)); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const nav = req.mode === 'navigate' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/') && url.pathname !== '/share' && url.pathname !== '/mcp';
  const file = url.pathname.startsWith('/files/') && !url.searchParams.has('download') && !url.searchParams.has('s');
  if (!nav && !file && !API.test(url.pathname) && !STATIC.test(url.pathname)) return;
  // Die App-Hülle ist für alle Adressen dieselbe
  const key = nav ? '/' : req;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Angemeldeten Zustand und Inhalte merken; eine abgelaufene Sitzung (401) oder Fehler nicht
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)).catch(() => {}));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(key, { ignoreVary: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
