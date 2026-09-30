// A driver's phone opens "My trips" with no signal (ADR 0009, audit thin #5): this service worker keeps the page itself (its HTML, script,
// style and icons) and answers with them when the network does not. Network first, so a new version is used as soon as there is signal;
// /api is never touched (the page keeps its last trips and the taps waiting to send in its own storage). Browsers run a service worker only
// on a secure address (https, or this computer itself), so over plain Wi-Fi sharing the page works offline only while it stays open.
const CACHE = 'sy-crew-v1';
const SHELL = [
  '/crew',
  '/crew.js',
  '/crew.css',
  '/crew-queue.js',
  '/crew.webmanifest',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('sy-crew-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request,
    url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname).then((hit) => hit ?? Response.error())),
  );
});
