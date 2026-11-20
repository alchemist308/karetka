import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve, sep, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openStores } from "./sqlite-store.mjs";

const types = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".woff2": "font/woff2"
};
const requestLimit = 512_000;
const staticDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
const headers = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'"
};

function reject(status) { throw Object.assign(new Error(), { status }); }

function configuredOrigin(env) {
  const url = new URL(env.PUBLIC_ORIGIN || "http://localhost:8080");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Укажите PUBLIC_ORIGIN в формате https://ваш-домен. Для localhost доступен HTTP.");
  }
  return url.origin;
}

function requestPath(target) {
  const raw = target.split("?")[0];
  let path;
  try { path = decodeURIComponent(raw); } catch { reject(400); }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x1f]/.test(path) ||
      path.split("/").some(part => part.startsWith("."))) reject(400);
  return path;
}

async function body(incoming) {
  if (Number(incoming.headers["content-length"] || 0) > requestLimit) reject(413);
  let length = 0;
  const chunks = [];
  for await (const part of incoming.iterator({ destroyOnReturn: false })) {
    length += part.length;
    if (length > requestLimit) reject(413);
    chunks.push(part);
  }
  return Buffer.concat(chunks, length);
}

async function serveFile(incoming, outgoing, root, path, url) {
  if (!["GET", "HEAD"].includes(incoming.method)) reject(405);
  const target = join(root, path === "/" ? "index.html" : path);
  let file, info;
  try {
    file = await realpath(target);
    if (!file.startsWith(root + sep)) reject(404);
    info = await stat(file);
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") reject(404);
    throw e;
  }
  if (!info.isFile()) reject(404);
  const tag = 'W/"' + info.size.toString(16) + "-" + Math.floor(info.mtimeMs).toString(16) + '"';
  outgoing.setHeader("ETag", tag);
  outgoing.setHeader("Cache-Control", url.searchParams.has("v") && path !== "/sw.js"
    ? "public, max-age=31536000, immutable" : "no-cache");
  if (path === "/sw.js") outgoing.setHeader("Service-Worker-Allowed", "/");
  if (incoming.headers["if-none-match"] === tag) {
    outgoing.writeHead(304).end();
    return;
  }
  outgoing.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
  outgoing.setHeader("Content-Length", info.size);
  if (incoming.method === "HEAD") outgoing.end();
  else await pipeline(createReadStream(file), outgoing);
}

export async function createAppServer({ route, stores, env = process.env, publicDirectory = staticDirectory }) {
  const root = await realpath(publicDirectory);
  const origin = configuredOrigin(env);
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, async (incoming, outgoing) => {
    for (const [key, value] of Object.entries(headers)) outgoing.setHeader(key, value);
    try {
      const path = requestPath(incoming.url || "/");
      const url = new URL(incoming.url, origin);
      if (!path.startsWith("/api/")) return await serveFile(incoming, outgoing, root, path, url);
      const method = incoming.method;
      const data = method === "GET" || method === "HEAD" ? undefined : await body(incoming);
      const requestHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") requestHeaders.set(name, value);
        else if (Array.isArray(value)) value.forEach(item => requestHeaders.append(name, item));
      }
      const request = new Request(url, { method, headers: requestHeaders, body: data });
      const forwarded = incoming.headers["x-karetka-client-ip"];
      const ip = env.TRUST_CADDY_PROXY === "1" && typeof forwarded === "string" && isIP(forwarded)
        ? forwarded : incoming.socket.remoteAddress;
      const result = await route(request, { legacy: stores.legacy, commerce: stores.commerce, env, ip });
      for (const [key, value] of result.headers) {
        if (key !== "set-cookie") outgoing.setHeader(key, value);
      }
      const cookies = result.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
      outgoing.setHeader("Cache-Control", "no-store");
      outgoing.writeHead(result.status);
      if (result.body && method !== "HEAD") await pipeline(Readable.fromWeb(result.body), outgoing);
      else outgoing.end();
    } catch (error) {
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      incoming.resume();
      const status = [400, 404, 405, 413].includes(error.status) ? error.status : 500;
      const message = {400:"Некорректный запрос.",404:"Страница не найдена.",405:"Метод недоступен.",413:"Запрос слишком велик.",500:"Сервис временно недоступен."}[status];
      outgoing.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      outgoing.end(JSON.stringify({ error: message }));
    }
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  const { route } = await import("./router.mjs");
  const stores = openStores();
  const server = await createAppServer({ route, stores });
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || "0.0.0.0", () => {
    console.log("Каретка запущена на порту", server.address().port);
  });
  const stop = () => server.close(() => { stores.close(); });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
