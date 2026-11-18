const cacheName = "track-race-scoring-shell-v8";
const shell = new URL("./", self.registration.scope).href;
const importer = new URL("photo-import.js?v=20261118-5", shell).href;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([shell, importer].map(url => new Request(url, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("track-race-scoring-shell-") && key !== cacheName).map(key => caches.delete(key))))
  ]));
});
self.addEventListener("fetch", event => {
  const navigation = event.request.mode === "navigate" && event.request.url.startsWith(shell);
  if (!navigation && event.request.url !== importer) return;
  const cacheKey = navigation ? shell : importer;
  event.respondWith(fetch(event.request, { cache: "no-cache" }).then(async response => {
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  }).catch(() => caches.match(cacheKey).then(response => response || Response.error())));
});
