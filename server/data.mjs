import { createHash, timingSafeEqual } from "node:crypto";

export function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
export const sha = (value) => createHash("sha256").update(value).digest("hex");
export const get = (store, key) => store.get(key, { type: "json" });
export function sameDigest(a, b) {
  return typeof a === "string" && typeof b === "string" &&
    /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// A failed conditional write means another instance committed first.
export async function mutate(store, key, change) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const before = await store.getWithMetadata(key, { type: "json" });
    const next = await change(before?.data ?? null);
    if (JSON.stringify(before?.data ?? null) === JSON.stringify(next)) return next;
    const condition = before ? { onlyIfMatch: before.etag } : { onlyIfNew: true };
    const written = await store.setJSON(key, next, condition);
    if (written.modified) return next;
  }
  fail(503, "Одновременно пришли несколько изменений. Повторите действие.");
}

export async function readJSON(request, maximum = 32768) {
  if (!/^application\/json\b/i.test(request.headers.get("content-type") || ""))
    fail(415, "Ожидается запрос в формате JSON.");
  if (Number(request.headers.get("content-length")) > maximum) fail(413, "Слишком большой запрос.");
  const reader = request.body?.getReader();
  if (!reader) fail(400, "Пустой запрос.");
  let length = 0;
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      fail(413, "Слишком большой запрос.");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  fail(400, "Некорректные данные запроса.");
}
