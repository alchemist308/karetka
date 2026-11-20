"use strict";
const CACHE = "karetka-shell-v2.0.0-r1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css?v=2.0",
  "./fonts/tt2020-e.woff2",
  "./grain.png",
  "./paper-fibers.webp",
  "./mark.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
  "./formats.js",
  "./storage.js?v=2.0",
  "./sync.js?v=2.0",
  "./sound.js?v=1.2",
  "./app.js?v=2.0",
  "./assistants.js",
  "./account.css?v=2.0",
  "./typefaces.css?v=2.0",
  "./paper-motion.css?v=2.0",
  "./typewriter-input.js?v=2.0",
  "./paper-motion.js?v=2.0",
  "./account-keys.js?v=2.0",
  "./private-files.js?v=2.0",
  "./account-ui.js?v=2.0",
  "./fonts/tt2020-base.woff2",
  "./fonts/pt-mono.woff2",
  "./fonts/old-standard.woff2"
];
self.addEventListener("install", (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const path of SHELL) {
        const req = new Request(new URL(path, self.registration.scope), { cache: "reload" });
        const res = await fetch(req);
        if (!res.ok) throw new Error("Shell unavailable");
        await cache.put(req, res);
      }
      await self.skipWaiting();
    })
  );
});
self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    (async () => {
      for (const k of await caches.keys())
        if (k.startsWith("karetka-shell-") && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })()
  );
});
self.addEventListener("fetch", (ev) => {
  const req = ev.request,
    url = new URL(req.url),
    scope = self.registration.scope;
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.includes("/.netlify/") ||
    url.pathname.includes("/api/")
  )
    return;
  const files = SHELL.map((p) => new URL(p, scope).href);
  if (
    req.mode === "navigate" &&
    (url.pathname === new URL(scope).pathname ||
      url.pathname === new URL("index.html", scope).pathname)
  ) {
    ev.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match(new URL("index.html", scope).href))
        .then((r) => r || fetch(req))
    );
    return;
  }
  if (files.includes(url.href))
    ev.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match(req))
        .then((r) => r || fetch(req))
    );
});
