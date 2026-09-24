// Service worker Logis — hébergement statique de index.html (Firebase Hosting,
// GitHub Pages). Version allégée : pas de /api/logis, chemins relatifs.
// v26.3 : nom de cache incrémenté pour purger les anciennes icônes.
// v27 : les notifications push (réception, clic) vivent dans sw-push.js.
importScripts("./sw-push.js");

const CACHE = "logis-gh-v3";
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest",
  "./icon-32.png", "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Le serveur de notifications ne doit jamais être servi depuis le cache.
  if (LOGIS_PUSH_API && req.url.startsWith(LOGIS_PUSH_API)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || new Response("", { status: 504 }))
      )
  );
});
