import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomUUID, webcrypto, randomBytes } from "node:crypto";
import { vault } from "../server/vault.mjs";
const client = await readFile(new URL("../dist/sync.js", import.meta.url), "utf8");
class MemoryBlobs {
  entries = new Map();
  count = 0;
  async get(key) {
    return this.entries.get(key)?.data || null;
  }
  async getMetadata(key) {
    const old = this.entries.get(key);
    return old ? { etag: old.etag, metadata: old.metadata } : null;
  }
  async getWithMetadata(key) {
    return this.entries.get(key) || null;
  }
  async delete(key) {
    this.entries.delete(key);
  }
  async list({ prefix }) {
    return {
      blobs: [...this.entries]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, v]) => ({ key, etag: v.etag }))
    };
  }
  async setJSON(key, data, { onlyIfNew, onlyIfMatch, metadata }) {
    const old = this.entries.get(key);
    if ((onlyIfNew && old) || (onlyIfMatch && old?.etag !== onlyIfMatch))
      return { modified: false };
    const etag = '"v' + ++this.count + '"';
    this.entries.set(key, { data: structuredClone(data), etag, metadata });
    return { modified: true, etag };
  }
}
function device(blobs, prefs = new Map(), books = new Map()) {
  const navigator = { onLine: true },
    listeners = {};
  let writable = true;
  const net = async (path, { method, headers, body }) => {
    if (!writable) throw new TypeError("offline");
    return vault(
      new Request(new URL(path, "https://karetka.test/"), { method, headers, body }),
      blobs
    );
  };
  const env = vm.createContext({
    module: { exports: {} },
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    crypto: webcrypto,
    Uint8Array,
    Response,
    Blob,
    CompressionStream,
    DecompressionStream,
    TypeError,
    AbortController,
    structuredClone,
    navigator,
    window: { isSecureContext: true, addEventListener: (key, fn) => (listeners[key] = fn) },
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: net
  });
  vm.runInContext(client, env);
  const sync = env.module.exports({
    books,
    store: { readPref: (k, f) => prefs.get(k) ?? f, writePref: (k, v) => prefs.set(k, v) },
    uid: randomUUID,
    touch: () => {},
    flush: async () => {},
    storageReady: () => true,
    hasError: () => false,
    refresh: () => {},
    notify: () => {},
    status: () => {}
  });
  return {
    sync,
    books,
    prefs,
    navigator,
    disconnect() {
      writable = false;
      navigator.onLine = false;
    },
    connect() {
      writable = true;
      navigator.onLine = true;
    }
  };
}
function book(text) {
  return {
    id: randomUUID(),
    title: "Книга",
    version: randomUUID(),
    kind: "single",
    created: 1,
    updated: 1,
    cards: [],
    sections: [{ id: randomUUID(), title: "Глава", text, scenes: [], plan: {} }]
  };
}
const edit = (b, text) => {
  b.sections[0].text = text;
  b.version = randomUUID();
};
test("two devices, offline reopening, private vaults, conflict copies and retry", async () => {
  const blobs = new MemoryBlobs(),
    pc = device(blobs),
    b = book("Начало истории");
  pc.books.set(b.id, b);
  await pc.sync.connect(null);
  const code = pc.sync.code();
  const tablet = device(blobs);
  await tablet.sync.connect(code);
  assert.equal(tablet.books.get(b.id).sections[0].text, "Начало истории");
  pc.disconnect();
  edit(b, "Версия с ПК после работы офлайн");
  await assert.rejects(pc.sync.now(), /офлайн/);
  edit(tablet.books.get(b.id), "Редакция с планшета");
  await tablet.sync.now();
  // Restart with the durable local contents, then reconcile the new remote head.
  const restarted = device(blobs, pc.prefs, pc.books);
  await restarted.sync.now();
  await restarted.sync.now();
  await tablet.sync.now();
  assert.deepEqual(
    [...tablet.books.values()].map((x) => x.sections[0].text).sort(),
    ["Версия с ПК после работы офлайн", "Редакция с планшета"].sort()
  );
  await restarted.sync.now();
  assert.equal(restarted.books.size, 2);
  const other = device(blobs);
  await other.sync.connect(null);
  assert.equal(other.books.size, 0);
  assert.ok(!JSON.stringify([...blobs.entries]).includes("Редакция с планшета"));
  const bad = device(blobs);
  await assert.rejects(bad.sync.connect("0".repeat(48)), /не найдено/);
});
test("large manuscript round trips across immutable chunks and after an interrupted upload", async () => {
  const blobs = new MemoryBlobs(),
    a = device(blobs),
    b = book(randomBytes(610000).toString("base64"));
  a.books.set(b.id, b);
  const save = blobs.setJSON.bind(blobs);
  let fail = true;
  blobs.setJSON = async (k, v, o) => {
    if (fail && k.includes("/chunks/") && k.endsWith("/1")) {
      fail = false;
      throw Error("interruption");
    }
    return save(k, v, o);
  };
  await assert.rejects(a.sync.connect(null));
  assert.equal(
    [...blobs.entries.keys()].some((k) => k.includes("/heads/")),
    false
  );
  await a.sync.now();
  const second = device(blobs);
  await second.sync.connect(a.sync.code());
  assert.equal(second.books.get(b.id).sections[0].text, b.sections[0].text);
});
test("replaced manuscript chunks are reclaimed after readers have a full revision to finish", async () => {
  const blobs = new MemoryBlobs(),
    a = device(blobs),
    b = book(randomBytes(480000).toString("base64"));
  a.books.set(b.id, b);
  await a.sync.connect(null);
  const first = [...blobs.entries.keys()].filter((k) => k.includes("/chunks/"));
  assert.ok(first.length >= 2);
  edit(b, "Короткая редакция.");
  await a.sync.now();
  assert.ok(first.every((k) => blobs.entries.has(k)));
  edit(b, "Следующая редакция.");
  await a.sync.now();
  assert.ok(first.every((k) => !blobs.entries.has(k)));
});
test("lost HTTP response after a committed write does not duplicate a manuscript", async () => {
  const blobs = new MemoryBlobs(),
    a = device(blobs),
    b = book("Раз, два.");
  a.books.set(b.id, b);
  const save = blobs.setJSON.bind(blobs);
  let fail = true;
  blobs.setJSON = async (k, v, o) => {
    const ret = await save(k, v, o);
    if (fail && k.includes("/heads/")) {
      fail = false;
      throw Error("response lost");
    }
    return ret;
  };
  await assert.rejects(a.sync.connect(null));
  await a.sync.now();
  assert.equal(a.books.size, 1);
  assert.equal(b.cloud.version, b.version);
});
test("unauthorized and cross-origin requests rejected; unpublished chunks stay invisible", async () => {
  const store = new MemoryBlobs(),
    origin = "https://karetka.test",
    endpoint = origin + "/.netlify/functions/vault",
    auth = { Authorization: "Bearer " + "x".repeat(43) };
  assert.equal((await vault(new Request(endpoint), store)).status, 401);
  assert.equal(
    (
      await vault(
        new Request(endpoint, {
          method: "POST",
          headers: { ...auth, Origin: "https://elsewhere.test" }
        }),
        store
      )
    ).status,
    403
  );
  await vault(new Request(endpoint, { method: "POST", headers: auth }), store);
  const id = randomUUID();
  const res = await vault(
    new Request(endpoint + "?id=" + id, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        base: null,
        head: { version: randomUUID(), iv: "y".repeat(16), upload: randomUUID(), parts: 2 }
      })
    }),
    store
  );
  assert.equal(res.status, 422);
  assert.deepEqual(
    (await (await vault(new Request(endpoint, { headers: auth }), store)).json()).items,
    []
  );
});
