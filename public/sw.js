// yAI as an installed app (2026-10-20). The pages and their files come from the network first (so an update shows
// at once) and from this cache when offline; the API is never cached. Offline, a page that was never opened shows
// a short note instead.
const CACHE = "yai-v2";
const SHELL = ["/", "/styles.css", "/extras.css", "/md.js", "/data.js", "/canvas.js", "/voice.js", "/extras.js", "/mobile.js", "/mobile.css", "/logo.svg", "/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => (await caches.match(e.request, { ignoreSearch: e.request.mode === "navigate" })) ||
        (e.request.mode === "navigate" && (await caches.match("/"))) ||
        new Response("<!doctype html><meta name=viewport content='width=device-width'><body style='font:16px system-ui;padding:40px;text-align:center'>You're offline. yAI needs the internet to answer.</body>", { headers: { "Content-Type": "text/html" } }))
  );
});
