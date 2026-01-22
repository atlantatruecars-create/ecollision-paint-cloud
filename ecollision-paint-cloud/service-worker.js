const CACHE_NAME = 'paint-inventory-cloud-cache-v1';
const ASSETS = ['./','./index.html','./manifest.json','./service-worker.js','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon-180.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k === CACHE_NAME ? null : caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});