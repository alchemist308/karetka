import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const [storageSource, syncSource] = await Promise.all(["storage.js", "sync.js"].map(
  name => readFile(new URL("../dist/" + name, import.meta.url), "utf8")
));
const a = { id: "a".repeat(64), login: "alice", sessionTag: "session-a" };
const b = { id: "b".repeat(64), login: "boris", sessionTag: "session-b" };
const rawKey = "12".repeat(24);
function context() {
  const data = new Map(), requests = [];
  const localStorage = {
    get length() { return data.size; },
    key: i => [...data.keys()][i],
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k)
  };
  const tabData = new Map(), sessionStorage = {
    getItem: k => tabData.get(k) ?? null, setItem: (k, v) => tabData.set(k, String(v)), removeItem: k => tabData.delete(k)
  };
  const state = { current: null, tag: null };
  const env = vm.createContext({
    localStorage, sessionStorage, navigator: { onLine: true }, TextEncoder, TextDecoder, btoa, atob, AbortController, JSON,
    setTimeout: () => 1, clearTimeout() {}, crypto: webcrypto,
    fetch: async (path, opts) => {
      requests.push({ path, opts });
      if (path.endsWith("/logout")) {
        const guard = JSON.parse(opts.body);
        assert.equal(guard.expectedUser, state.current?.id);
        assert.equal(guard.expectedSession, state.tag);
        assert.equal(opts.headers["X-Karetka-Request"], "1");
        state.current = null; state.tag = null;
        return Response.json({ ok: true });
      }
      return Response.json({ user: state.current, sessionTag: state.tag });
    }
  });
  vm.runInContext(storageSource, env);
  const { Store, Workspace } = vm.runInContext("({Store: KaretkaStore, Workspace: KaretkaLocalWorkspace})", env);
  function page() {
    const profile = Store.currentProfile(), store = Store.forProfile(profile), copied = [];
    let count = 0, saves = 0;
    return {
      store, copied, reloads: () => count, saves: () => saves,
      api: Workspace({ profile, store, beforeChange: async () => { saves++; },
        cancelChange() {}, reload() { count++; }, copyBook: async book => { copied.push(book); return book.id; } })
    };
  }
  return { env, data, requests, state, Store, page };
}
const manuscript = (title, text = title) => ({
  id: randomUUID(), version: randomUUID(), rev: 1, title, kind: "single", sections: [
    { id: randomUUID(), title, text, scenes: [], plan: {} }], cards: [], created: 1, updated: 2
});

test("guest storage and journals survive profile changes, and explicit imports are idempotent", async () => {
  const c = context(), guest = c.page(), old = manuscript("Гостевой текст");
  await guest.store.open();
  await guest.store.save(old, 0);
  guest.store.writePref("journal.legacy", { book: old });
  guest.store.writePref("vaultKey", "00".repeat(24));
  assert.ok(c.data.has("karetka.v1.book." + old.id));
  const stale = c.page();
  await guest.api.switchTo(a, rawKey);
  assert.equal(guest.saves(), 1);
  assert.equal((await stale.store.open()).length, 1);
  assert.equal(stale.api.active(), false);
  await stale.api.followProfile();
  assert.equal(stale.reloads(), 1);

  const alice = c.page();
  assert.equal((await alice.store.open()).length, 0);
  assert.equal(alice.store.readPref("vaultKey", ""), rawKey);
  assert.equal(alice.store.prefKeys("journal.").length, 0);
  assert.equal((await alice.api.guestBooks())[0].title, old.title);
  assert.equal(await alice.api.importGuest(old.id), await alice.api.importGuest(old.id));
  assert.notEqual(alice.copied[0].id, old.id);
  assert.equal(alice.copied[0].sections[0].text, old.title);
  assert.equal(alice.copied[0].cloud, null);
  const privateBook = manuscript("Личная рукопись");
  await alice.store.save(privateBook, 0);
  await alice.api.switchTo(b, "45".repeat(24));
  const boris = c.page();
  assert.equal((await boris.store.open()).length, 0);
  assert.equal(alice.store.readPref("vaultKey", ""), "");
  await assert.rejects(alice.store.readAll(), /закрыта/);
  await alice.store.setVaultKey(rawKey);
  assert.equal((await alice.store.readAll())[0].title, privateBook.title);
  assert.equal(guest.store.readPref("vaultKey", ""), "00".repeat(24));
  assert.equal(guest.store.prefKeys("journal.").length, 1);
});

test("offline logout keeps account drafts and never closes a newer session of the same login", async () => {
  const c = context();
  c.Store.setProfile(a);
  const p = c.page(), book = manuscript("Личный черновик");
  await p.store.setVaultKey(rawKey); await p.store.open(); await p.store.save(book, 0);
  c.env.navigator.onLine = false;
  await p.api.leave();
  assert.equal(c.Store.currentProfile(), null);
  assert.equal(c.Store.pendingLogout().sessionTag, a.sessionTag);
  assert.equal(p.store.readPref("vaultKey", ""), "");
  await assert.rejects(p.store.readAll(), /закрыта/);
  assert.ok([...c.data.keys()].some(k => k.endsWith("book." + book.id)));
  const guest = c.page();
  assert.equal((await guest.store.open()).length, 0);
  c.env.navigator.onLine = true;
  c.state.current = a; c.state.tag = "new-session-of-alice";
  await guest.api.finishLogout();
  assert.equal(c.Store.pendingLogout(), null);
  assert.equal(c.state.tag, "new-session-of-alice");
  assert.equal(c.requests.filter(x => x.path.endsWith("/logout")).length, 0);

  c.Store.setPendingLogout({ id: a.id, sessionTag: c.state.tag });
  await guest.api.finishLogout();
  assert.equal(c.state.current, null);
  assert.equal(c.requests.filter(x => x.path.endsWith("/logout")).length, 1);
});

test("an authoritative different session leaves the active workspace before another account can sync", async () => {
  const c = context(); c.Store.setProfile(a);
  const p = c.page(); await p.store.setVaultKey(rawKey);
  c.env.navigator.onLine = false;
  assert.equal(await p.api.verify(), false);
  assert.equal(p.api.active(), true);
  c.state.current = b; c.state.tag = b.sessionTag; c.env.navigator.onLine = true;
  assert.equal(await p.api.verify(), false);
  assert.equal(p.reloads(), 1);
  assert.equal(p.saves(), 1);
  assert.equal(c.Store.currentProfile(), null);
  assert.equal(c.state.current.id, b.id);
  assert.ok(c.requests.every(x => x.path.endsWith("/session")));
});

test("quota on one manuscript leaves it local and continues syncing others using the personal API", async () => {
  const denied = manuscript("Занятое место"), allowed = manuscript("Книга в облаке");
  const books = new Map([denied, allowed].map(x => [x.id, x]));
  const writes = [], saved = new Map();
  let paid = false, isCurrent = true, enabled = false;
  const env = vm.createContext({
    module: { exports: {} }, TextEncoder, TextDecoder, btoa, atob, crypto: webcrypto, Uint8Array,
    Response, Blob, TypeError, AbortController, navigator: { onLine: true },
    window: { isSecureContext: true, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {},
    fetch: async (path, opts) => {
      const u = new URL(path, "https://example.test/");
      assert.equal(u.pathname, "/api/library");
      assert.match(opts.headers.Authorization, /^Bearer [\w-]{43}$/);
      assert.equal(opts.credentials, "same-origin");
      if (opts.method === "GET") return Response.json({ items: [...saved].map(([id, etag]) => ({ id, etag })) });
      const id = u.searchParams.get("id"); writes.push(id);
      if (id === denied.id && !paid) return Response.json({ error: "Лимит тарифа." }, { status: 402 });
      const etag = "v" + writes.length; saved.set(id, etag); return Response.json({ etag });
    }
  });
  vm.runInContext(syncSource, env);
  const sync = env.module.exports({
    account: true, enabled: () => enabled, isActive: () => isCurrent, checkSession: async () => true, books,
    store: { readPref: () => rawKey }, uid: randomUUID, touch() {}, flush: async () => {},
    storageReady: () => true, hasError: () => false, refresh() {}, notify() {}, status() {}
  });
  await sync.now(true);
  assert.equal(sync.connected, false);
  assert.equal(writes.length, 0);
  enabled = true;
  await sync.now();
  assert.deepEqual(writes, [denied.id, allowed.id]);
  assert.equal(allowed.cloud.version, allowed.version);
  assert.equal(denied.cloud, undefined);
  assert.match(sync.badge(denied), /лимит/);
  allowed.version = randomUUID();
  await sync.now();
  assert.deepEqual(writes, [denied.id, allowed.id, allowed.id]);
  isCurrent = false; paid = true;
  await sync.now(true); assert.equal(writes.length, 3);
  isCurrent = true; await sync.now(true);
  assert.equal(denied.cloud.version, denied.version);
  enabled = false; sync.pause();
  allowed.version = randomUUID();
  await sync.now(true); assert.equal(writes.length, 4);
  enabled = true; await sync.now(true);
  assert.equal(allowed.cloud.version, allowed.version);
});

test("local account books and crash journal are authenticated ciphertext, including migrated legacy entries", async () => {
  const c = context(); c.Store.setProfile(a);
  const s = c.page().store, legacy = manuscript("Невидимый заголовок", "Закрытая фраза");
  const prefix = "karetka.account.v1." + a.id + ".", journalKey = "journal." + legacy.id;
  c.data.set(prefix + "book." + legacy.id, JSON.stringify(legacy));
  c.data.set(prefix + journalKey, JSON.stringify({ book: legacy, base: 0 }));
  c.data.set(prefix + "vaultKey", JSON.stringify(rawKey));
  assert.equal((await s.open())[0].title, legacy.title);
  assert.equal((await s.readJournal(journalKey)).book.sections[0].text, "Закрытая фраза");
  assert.equal(c.data.has(prefix + "vaultKey"), false);
  assert.ok(!JSON.stringify([...c.data]).includes(rawKey));
  for (const k of ["book." + legacy.id, journalKey]) {
    const stored = c.data.get(prefix + k);
    assert.equal(JSON.parse(stored).sealed, "karetka-local-v1");
    assert.ok(!stored.includes("Невидимый заголовок") && !stored.includes("Закрытая фраза"));
  }
  const edited = { ...legacy, title: "Новая редакция", rev: 2, version: randomUUID() };
  await s.writeJournal(legacy.id, { book: edited, base: 1 });
  s.clearJournal(journalKey, legacy.version);
  assert.equal((await s.readJournal(journalKey)).book.title, edited.title);
  await s.save(edited, 1); s.clearJournal(journalKey, edited.version);
  assert.equal(await s.readJournal(journalKey), null);
  const fresh = c.page().store;
  assert.equal((await fresh.open())[0].title, "Новая редакция");
  const rowKey = prefix + "book." + legacy.id;
  const row = JSON.parse(c.data.get(rowKey)); row.rev++;
  c.data.set(rowKey, JSON.stringify(row));
  await assert.rejects(fresh.readAll());
});

test("IndexedDB stores sealed account rows and a non-extractable device key, then locks on logout", async () => {
  const c = context(), databases = new Map();
  // Model IndexedDB structured cloning and requests queued inside a transaction's callbacks.
  c.env.indexedDB = { open(name) {
    const req = {};
    queueMicrotask(() => {
      const first = !databases.has(name);
      if (first) databases.set(name, new Map());
      const stores = databases.get(name);
      req.result = {
        close() {},
        createObjectStore: label => stores.set(label, new Map()),
        transaction(label) {
          const records = stores.get(label);
          let pending = 0;
          const tx = { objectStore() {
            function issue(fn) {
              pending++;
              const r = {};
              queueMicrotask(() => {
                r.result = structuredClone(fn());
                r.onsuccess?.();
                if (!--pending) queueMicrotask(() => tx.oncomplete?.());
              });
              return r;
            }
            return { put: (v, k) => issue(() => { records.set(k || v.id, structuredClone(v)); return k || v.id; }),
              get: k => issue(() => records.get(k)), getAll: () => issue(() => [...records.values()]),
              delete: k => issue(() => { records.delete(k); }) };
          }};
          return tx;
        }
      };
      if (first) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  }};
  c.Store.setProfile(a);
  const page = c.page(), book = manuscript("Личная книга", "Видно только после входа");
  await page.store.setVaultKey(rawKey); await page.store.open(); await page.store.save(book, 0);
  const device = databases.get("karetka-device-keys-v1").get("trusted").get(a.id);
  assert.equal(device.key.extractable, false);
  const rows = databases.get("karetka-account-v1-" + a.id).get("books");
  assert.equal(rows.get(book.id).sealed, "karetka-local-v1");
  assert.ok(!JSON.stringify(rows.get(book.id)).includes(book.title));
  const fresh = c.page(); assert.equal((await fresh.store.open())[0].title, book.title);
  c.env.navigator.onLine = false; await fresh.api.leave();
  assert.equal(databases.get("karetka-device-keys-v1").get("trusted").size, 0);
  assert.equal(rows.size, 1);
  const locked = c.Store.forProfile(a);
  await assert.rejects(locked.open(), /закрыта/);
  await locked.setVaultKey(rawKey);
  assert.equal((await locked.open())[0].sections[0].text, book.sections[0].text);
});
