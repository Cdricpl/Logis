// Service worker Logis — mode hors ligne
const CACHE = "logis-v1";
const PRECACHE = [
  "/",
  "/api/logis",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
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

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Stratégie : network-first pour HTML (pour récupérer les MAJ), cache-first sinon.
  const isHTML =
    req.mode === "navigate" ||
    req.headers.get("accept")?.includes("text/html") ||
    url.pathname === "/api/logis" ||
    url.pathname === "/";

  if (isHTML) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/api/logis", fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match("/api/logis")) ||
            (await cache.match("/")) ||
            new Response("Hors ligne", { status: 503 })
          );
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        return new Response("", { status: 504 });
      }
    })()
  );
});

// Clic sur une notification : ouvre/active l'app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/api/logis");
    })()
  );
});
