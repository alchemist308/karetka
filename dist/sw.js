"use strict";
const CACHE = "karetka-shell-v2.1.0-r1";
const SHELL = [
  "./",
  "./index.html",
  "./drafts.html",
  "./style.css?v=2.1",
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
  "./app.js?v=2.1",
  "./assistants.js",
  "./account.css?v=2.0",
  "./stationery.css?v=2.1",
  "./typefaces.css?v=2.0",
  "./paper-motion.css?v=2.1",
  "./typewriter-input.js?v=2.0",
  "./paper-motion.js?v=2.0",
  "./account-keys.js?v=2.0",
  "./private-files.js?v=2.1",
  "./account-ui.js?v=2.1",
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
        // Navigation requests cannot replay a response that followed a hosting redirect.
        const asset = res.redirected ? new Response(res.body, {
          status: res.status, statusText: res.statusText, headers: res.headers
        }) : res;
        await cache.put(req, asset);
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
  if (req.mode === "navigate") {
    const pages = new Map([
      [new URL(scope).pathname, "index.html"],
      [new URL("index.html", scope).pathname, "index.html"],
      [new URL("drafts", scope).pathname, "drafts.html"],
      [new URL("drafts.html", scope).pathname, "drafts.html"]
    ]);
    const page = pages.get(url.pathname);
    if (page) {
      ev.respondWith(
        caches.open(CACHE)
          .then((cache) => cache.match(new URL(page, scope).href))
          .then((response) => response || fetch(req))
      );
      return;
    }
  }
  if (files.includes(url.href))
    ev.respondWith(
      caches
        .open(CACHE)
        .then((c) => c.match(req))
        .then((r) => r || fetch(req))
    );
});
