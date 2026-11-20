import { createHash } from "node:crypto";
const json = (code, value) =>
  new Response(JSON.stringify(value), {
    status: code,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }
  });
const goodId = (s) =>
  typeof s === "string" &&
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(s);
const encoded = (s) =>
  typeof s === "string" && s.length > 0 && s.length <= 480000 && /^[A-Za-z0-9_-]+$/.test(s);
async function readBody(req) {
  if (Number(req.headers.get("content-length") || 0) > 500000) throw new RangeError();
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError();
  const pieces = [];
  let total = 0;
  while (true) {
    const piece = await reader.read();
    if (piece.done) break;
    total += piece.value.length;
    if (total > 500000) {
      await reader.cancel();
      throw new RangeError();
    }
    pieces.push(Buffer.from(piece.value));
  }
  return JSON.parse(Buffer.concat(pieces).toString("utf8"));
}
export async function vault(req, store, access = {}) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") || "")?.[1];
  if (!token) return json(401, { error: "Требуется код подключения устройства." });
  const origin = req.headers.get("origin"),
    url = new URL(req.url);
  // The former address is a same-team reverse proxy to this exact production site.
  const previousAddress = origin === "https://karetka-alchemist308.netlify.app" &&
    url.origin === "https://karetka.netlify.app";
  if (origin && origin !== url.origin && !previousAddress)
    return json(403, { error: "Недопустимый источник запроса." });
  const ns = createHash("sha256").update(token).digest("hex"),
    root = access.root || "v1/" + ns + "/";
  const id = url.searchParams.get("id"),
    upload = url.searchParams.get("upload"),
    part = url.searchParams.get("part"),
    chunk = upload !== null || part !== null;
  if (
    (id !== null && !goodId(id)) ||
    (chunk && (!id || !goodId(upload) || !/^\d{1,3}$/.test(part || "") || +part >= 512))
  )
    return json(400, { error: "Некорректный адрес рукописи." });
  try {
    if (req.method === "POST" && !id) {
      if (access.root) return json(200, { created: true });
      if (access.allowCreate === false)
        return json(403, { error: "Для нового облачного хранилища откройте «Кабинет». Прежние коды продолжают работать." });
      const created = await store.setJSON(root + "vault", { schema: 1 }, { onlyIfNew: true });
      return created.modified
        ? json(201, { created: true })
        : json(409, { error: "Это хранилище уже существует." });
    }
    if (!access.root && !(await store.getMetadata(root + "vault")))
      return json(404, { error: "Хранилище не найдено. Проверьте код с первого устройства." });
    if (req.method === "GET" && !id) {
      const prefix = root + "heads/";
      const { blobs } = await store.list({ prefix });
      const items = blobs.map((b) => ({ id: b.key.slice(prefix.length), etag: b.etag }));
      return json(200, { items });
    }
    if (!id) return json(405, { error: "Недоступная операция." });
    const path = chunk ? root + "chunks/" + id + "/" + upload + "/" + part : root + "heads/" + id;
    if (req.method === "GET") {
      const result = await store.getWithMetadata(path, { type: "json" });
      if (!result) return json(404, { error: "Облачная копия ещё не найдена." });
      return json(200, chunk ? result.data : { ...result.data, etag: result.etag });
    }
    if (req.method !== "PUT") return json(405, { error: "Недоступная операция." });
    const data = await readBody(req);
    if (chunk) {
      if (!encoded(data?.data)) return json(400, { error: "Некорректная часть копии." });
      await access.beforeWrite?.(id, { upload, part: +part });
      const result = await store.setJSON(path, { data: data.data }, { onlyIfNew: true });
      if (!result.modified) {
        const old = await store.get(path, { type: "json" });
        if (old?.data !== data.data) return json(409, { error: "Версия части уже существует." });
      }
      return json(200, { saved: true });
    }
    const h = data?.head;
    if (
      !h ||
      !goodId(h.version) ||
      typeof h.iv !== "string" ||
      !/^[A-Za-z0-9_-]{16}$/.test(h.iv) ||
      !(
        data.base === null ||
        (typeof data.base === "string" && data.base.length > 0 && data.base.length < 200)
      )
    )
      return json(400, { error: "Некорректная версия копии." });
    if (h.codec !== undefined && !["raw", "gzip"].includes(h.codec))
      return json(400, { error: "Неизвестный формат копии." });
    let head = { iv: h.iv, version: h.version, codec: h.codec || "raw" };
    if (encoded(h.data)) {
      head.data = h.data;
    } else if (goodId(h.upload) && Number.isInteger(h.parts) && h.parts > 1 && h.parts <= 512) {
      const prefix = root + "chunks/" + id + "/" + h.upload + "/";
      const { blobs } = await store.list({ prefix });
      const unique = new Set(blobs.map((b) => b.key.slice(prefix.length)));
      if (Array.from({ length: h.parts }, (_, i) => String(i)).some((i) => !unique.has(i)))
        return json(422, { error: "Часть копии ещё не загружена." });
      head = { ...head, upload: h.upload, parts: h.parts };
    } else return json(400, { error: "Некорректные данные копии." });
    await access.beforeWrite?.(id, { head });
    const previous = data.base === null ? null : await store.getMetadata(path);
    const currentGroup = head.upload ? { upload: head.upload, parts: head.parts } : null;
    const priorGroup = previous?.metadata?.active || null;
    const changed = await store.setJSON(path, head, {
      ...(data.base === null ? { onlyIfNew: true } : { onlyIfMatch: data.base }),
      metadata: { active: currentGroup, previous: priorGroup }
    });
    if (!changed.modified) return json(409, { error: "На другом устройстве есть новая редакция." });
    await access.committed?.(id, head);
    // Keep the previous complete group available to readers already downloading it.
    const retired = previous?.metadata?.previous;
    if (
      retired &&
      retired.upload !== currentGroup?.upload &&
      retired.upload !== priorGroup?.upload
    ) {
      const keys = Array.from(
        { length: retired.parts },
        (_, i) => root + "chunks/" + id + "/" + retired.upload + "/" + i
      );
      for (let i = 0; i < keys.length; i += 16) {
        await Promise.allSettled(keys.slice(i, i + 16).map((key) => store.delete(key)));
      }
    }
    return json(200, { etag: changed.etag });
  } catch (e) {
    if (e.status >= 400 && e.status < 600) return json(e.status, { error: e.message });
    if (e instanceof RangeError) return json(413, { error: "Часть копии слишком велика." });
    if (e instanceof SyntaxError) return json(400, { error: "Некорректный JSON." });
    return json(503, {
      error: "Облачное хранилище временно недоступно. Рукопись остаётся на устройстве."
    });
  }
}
