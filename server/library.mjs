import { fail, get, mutate, sameDigest, sha } from "./data.mjs";
import { vault } from "./vault.mjs";

const day = 86400000;
const keyFor = (id) => "quota/" + id;
export const rootFor = (id) => "library/" + id + "/";
export const objectId = (id) => typeof id === "string" && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id);
const active = (items, now) => (items || []).filter((item) => item.saved || item.until > now);
export async function bookCount(store, id, now) {
  return active(await get(store, keyFor(id)), now).length;
}
export async function personalLibrary(request, store, user, rights, now) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") || "")?.[1];
  if (!bearer || !sameDigest(sha(bearer), user.accessHash)) fail(403, "Нужен ключ личной библиотеки этого аккаунта.");
  const root = rootFor(user.id);
  async function reserve(id) {
    await mutate(store, keyFor(user.id), async (prior) => {
      const books = [];
      for (const slot of prior || []) {
        if (slot.saved || slot.until > now) books.push(slot);
        else if (await store.getMetadata(root + "heads/" + slot.id)) books.push({ id: slot.id, saved: true });
      }
      const index = books.findIndex((slot) => slot.id === id);
      if (rights.bookLimit !== null && (index < 0 ? books.length : index) >= rights.bookLimit)
        fail(402, "Эта рукопись превышает лимит облака. Текст сохранён на устройстве. Тарифы доступны в кабинете.");
      if (index < 0) books.push({ id, until: now + day });
      return books;
    });
  }
  async function beforeWrite(id, data) {
    if (data.part >= 64 || data.head?.parts > 64) fail(413, "Для облака разделите эту большую рукопись на тома.");
    await reserve(id);
    if (!data.upload) return;
    const key = root + "uploads/" + id;
    // Bound interrupted uploads. Keep groups for current and previous published heads.
    let expired = [];
    await mutate(store, key, (groups) => {
      groups ||= [];
      expired = groups.filter((g) => g.until <= now);
      const open = groups.filter((g) => g.until > now);
      if (open.some((g) => g.id === data.upload)) return open;
      if (open.length >= 4) fail(429, "У рукописи несколько незавершённых загрузок. Повторите синхронизацию позднее.");
      return [...open, { id: data.upload, until: now + 3600000 }];
    });
    if (expired.length) {
      const meta = await store.getMetadata(root + "heads/" + id);
      for (const group of expired) {
        if ([data.upload, meta?.metadata?.active?.upload, meta?.metadata?.previous?.upload].includes(group.id)) continue;
        const old = await store.list({ prefix: root + "chunks/" + id + "/" + group.id + "/" });
        await Promise.all(old.blobs.map((b) => store.delete(b.key)));
      }
    }
  }
  async function committed(id, head) {
    await mutate(store, keyFor(user.id), (rows) => (rows || []).map((r) => r.id === id ? { id, saved: true } : r));
    if (head.upload) await mutate(store, root + "uploads/" + id, (rows) => (rows || []).filter((g) => g.id !== head.upload));
  }
  return vault(request, store, { root, beforeWrite, committed });
}

// Each checkpoint owns immutable copies of the ciphertext and chunks of one committed revision.
export async function checkpoint({ op, store, user, rights, plans, body, url, now }) {
  const book = body?.bookId || url.searchParams.get("book");
  if (!objectId(book)) fail(400, "Выберите рукопись.");
  const root = "versions/" + user.id + "/" + book + "/";
  const limit = user.role === "owner" ? null : plans.find((p) => p.id === rights.plan).versions;
  const indexKey = root + "index";
  const records = await get(store, indexKey) || [];
  if (op === "list") return { versions: records, limit };
  const id = body?.version || url.searchParams.get("id");
  if (!objectId(id)) fail(400, "Укажите редакцию рукописи.");
  const prefix = root + id + "/";
  if (op === "get" || op === "part") {
    const saved = records.find((r) => r.id === id);
    if (!saved) fail(404, "Контрольная версия не найдена.");
    let path = prefix + "head";
    if (op === "part") {
      const part = url.searchParams.get("n");
      if (!/^\d{1,2}$/.test(part || "") || Number(part) >= saved.parts) fail(400, "Некорректная часть версии.");
      path = prefix + part;
    }
    const value = await get(store, path);
    if (!value) fail(409, "Список версий изменился. Откройте его снова.");
    return value;
  }
  if (op !== "save") fail(404, "Действие не найдено.");
  if (limit === 0) fail(402, "Контрольные версии доступны на тарифах «Автор» и «Мастерская».");
  if (records.some((row) => row.id === id)) return { saved: true };
  if (limit !== null && records.length > limit)
    fail(402, "Архив предыдущего тарифа доступен для чтения. Для новых версий восстановите прежний тариф.");
  const libraryRoot = rootFor(user.id);
  const head = await get(store, libraryRoot + "heads/" + book);
  if (!head || head.version !== id) fail(409, "Дождитесь сохранения текущей редакции в личном облаке.");
  for (let i = 0; i < (head.parts || 0); i += 6) {
    await Promise.all(Array.from({ length: Math.min(6, head.parts - i) }, async (_, j) => {
      const part = i + j;
      const fragment = await get(store, libraryRoot + "chunks/" + book + "/" + head.upload + "/" + part);
      if (!fragment) fail(409, "Рукопись изменилась во время сохранения. Повторите.");
      await store.setJSON(prefix + part, fragment, { onlyIfNew: true });
    }));
  }
  await store.setJSON(prefix + "head", head, { onlyIfNew: true });
  let retired = [];
  await mutate(store, indexKey, (old) => {
    const rows = old || [];
    retired = [];
    if (rows.some((row) => row.id === id)) return rows;
    if (limit !== null && rows.length > limit)
      fail(402, "Архив предыдущего тарифа доступен для чтения. Для новых версий восстановите прежний тариф.");
    const next = [{ id, at: now, parts: head.parts || 0 }, ...rows];
    if (limit !== null) retired = next.splice(limit);
    return next;
  });
  for (const row of retired) {
    const stale = root + row.id + "/";
    await Promise.all([store.delete(stale + "head"), ...Array.from({ length: row.parts }, (_, i) => store.delete(stale + i))]);
  }
  return { saved: true };
}
