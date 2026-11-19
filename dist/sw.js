"use strict";
const CACHE = "karetka-shell-v1.2.1";
const SHELL = [
  "./",
  "./index.html",
  "./style.css?v=1.2.1",
  "./fonts/tt2020-e.woff2",
  "./grain.png",
  "./mark.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
  "./formats.js",
  "./storage.js",
  "./sync.js",
  "./sound.js?v=1.2",
  "./app.js?v=1.2",
  "./assistants.js"
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
