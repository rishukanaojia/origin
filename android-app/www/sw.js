/*
 * RemoteLink service worker.
 *
 * NETWORK-FIRST for the app shell: always try the network so code updates land
 * immediately; fall back to cache only when offline. (A cache-first worker
 * would keep serving an old app.js after every deploy — which broke login.)
 * It never touches the signaling WebSocket or WebRTC media.
 */
'use strict';

const CACHE = 'remotelink-v2';   // bump this whenever cached assets change
const SHELL = [
  '/app.html', '/app.js', '/config.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // ignore cross-origin (STUN/TURN/etc.)

  // Network-first: fresh when online, cached copy only as an offline fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/app.html')))
  );
});
