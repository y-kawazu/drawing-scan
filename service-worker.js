'use strict';
// Bump VERSION whenever any app file changes. No images selected by users enter this cache.
const VERSION = 'kawazunext-drawing-scan-v12';
const FILES = ['./', 'index.html', 'style.css', 'style.css?v=12', 'app.js', 'app.js?v=12', 'processor.js', 'processor.js?v=12', 'manifest.webmanifest', 'manifest.webmanifest?v=12', 'assets/opencv.js', 'icons/icon.svg', 'icons/icon.svg?v=12', 'icons/icon-192.png', 'icons/icon-192.png?v=12', 'icons/icon-512.png', 'icons/icon-512.png?v=12', 'icons/apple-touch-icon.png', 'icons/apple-touch-icon.png?v=12'];
self.addEventListener('install', event => { event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(FILES))); });
// Do not skipWaiting: preserve the running editor until all old tabs are closed.
self.addEventListener('activate', event => { event.waitUntil((async () => { for (const key of await caches.keys()) if (key.startsWith('kawazunext-drawing-scan-') && key !== VERSION) await caches.delete(key); await self.clients.claim(); })()); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const known = FILES.some(path => new URL(path, self.registration.scope).href === url.href);
  if (!known) return;
  event.respondWith(caches.open(VERSION).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
});
