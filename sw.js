const cacheName = "track-race-scoring-shell-v3";
const shell = new URL("./", self.registration.scope).href;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.add(shell)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("track-race-scoring-shell-") && key !== cacheName).map(key => caches.delete(key))))
  ]));
});

self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate" || !event.request.url.startsWith(shell)) return;
  event.respondWith(fetch(event.request).then(async response => {
    if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
      const cache = await caches.open(cacheName);
      await cache.put(shell, response.clone());
    }
    return response;
  }).catch(() => caches.match(shell).then(response => response || Response.error())));
});
