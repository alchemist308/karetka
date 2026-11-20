import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openStores, backupDatabase, restoreDatabase, verifyDatabase } from "../server/sqlite-store.mjs";
import { createAppServer } from "../server/http.mjs";

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), "karetka-selfhost-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("SQLite persists both namespaces, metadata and conditional writes", async t => {
  const dir = await workspace(t), path = join(dir, "live.sqlite");
  const first = openStores(path), second = openStores(path);
  try {
    const initial = await first.legacy.setJSON("v1/key", { n: 1 }, { onlyIfNew: true, metadata: { active: 1 } });
    assert.ok(initial.modified);
    assert.equal((await second.legacy.setJSON("v1/key", { n: 2 }, { onlyIfNew: true })).modified, false);
    assert.equal(await second.commerce.get("v1/key", { type: "json" }), null);
    const writes = await Promise.all([first.legacy, second.legacy].map((s, i) => s.setJSON("v1/key", { n: i + 3 }, { onlyIfMatch: initial.etag })));
    assert.equal(writes.filter(x => x.modified).length, 1);
    assert.deepEqual((await second.legacy.getWithMetadata("v1/key", { type: "json" })).data, { n:3 });
    await first.commerce.setJSON("v1/key", { n: 5 }, { metadata: { marker: true } });
    assert.deepEqual((await second.commerce.getMetadata("v1/key")).metadata, { marker: true });
    assert.equal((await second.legacy.list({ prefix: "v1/" })).blobs[0].etag, writes[0].etag);
    assert.deepEqual((await second.legacy.list({ prefix: "v12/" })).blobs, []);
    await first.legacy.delete("v1/key");
    assert.equal(await second.legacy.get("v1/key"), null);
    assert.equal(await second.commerce.get("v1/key"), '{"n":5}');
  } finally { first.close(); second.close(); }
});

test("a live WAL snapshot restores the exact data and etags without overwriting an occupied database", async t => {
  const dir = await workspace(t), live = join(dir, "live.sqlite"), backup = join(dir, "copy.sqlite"), target = join(dir, "restored.sqlite");
  const stores = openStores(live);
  try {
    const first = await stores.legacy.setJSON("manuscript", { version: "first" });
    await stores.commerce.setJSON("account", { role: "owner" });
    backupDatabase(live, backup);
    await stores.legacy.setJSON("manuscript", { version: "second" }, { onlyIfMatch: first.etag });
    verifyDatabase(backup);
    assert.throws(() => backupDatabase(live, backup), /уже используется/);
    restoreDatabase(backup, target);
    assert.throws(() => restoreDatabase(backup, live), /уже используется/);
    const recovered = openStores(target);
    try {
      assert.equal((await recovered.legacy.getMetadata("manuscript")).etag, first.etag);
      assert.equal((await recovered.legacy.get("manuscript", { type: "json" })).version, "first");
      assert.equal((await recovered.commerce.get("account", { type: "json" })).role, "owner");
    } finally { recovered.close(); }
    const invalid = join(dir, "broken"); await writeFile(invalid, "incomplete");
    assert.throws(() => restoreDatabase(invalid, join(dir, "unpublished.sqlite")));
  } finally { stores.close(); }
});

test("backup and restore commands support binary pipes used in Docker", async t => {
  const dir = await workspace(t), source = join(dir, "source.sqlite"), target = join(dir, "restored.sqlite");
  const script = fileURLToPath(new URL("../server/sqlite-store.mjs", import.meta.url));
  const cli = (op, db, input) => spawnSync(process.execPath, [script, op, "-"], {
    env: { ...process.env, KARETKA_DB_PATH: db }, input, maxBuffer: 4 * 1024 * 1024
  });
  const stores = openStores(source);
  try { await stores.commerce.setJSON("order", { status:"paid" }); } finally { stores.close(); }
  const archived = cli("backup", source);
  assert.equal(archived.status, 0, archived.stderr.toString());
  assert.equal(archived.stdout.subarray(0,16).toString(), "SQLite format 3\u0000");
  assert.equal(cli("verify", target, archived.stdout).status, 0);
  assert.equal(cli("restore", target, archived.stdout).status, 0);
  assert.notEqual(cli("restore", target, archived.stdout).status, 0);
  const restored = openStores(target);
  try { assert.deepEqual(await restored.commerce.get("order", { type: "json" }), { status:"paid" }); }
  finally { restored.close(); }
});

test("HTTP serves the PWA and passes the canonical origin, client address, data, cookies and no-store to the API", async t => {
  const dir = await workspace(t);
  await writeFile(join(dir, "index.html"), "<html lang=ru>Каретка</html>");
  await writeFile(join(dir, "sw.js"), "test");
  const stores = openStores(":memory:");
  const observations = [];
  const route = async (request, context) => {
    observations.push({ url:request.url, ip:context.ip, body:await request.text() });
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("Set-Cookie", "a=1; HttpOnly"); headers.append("Set-Cookie", "b=2; HttpOnly");
    return new Response('{"ok":true}', { headers });
  };
  const server = await createAppServer({ route, stores, publicDirectory:dir, env:{ PUBLIC_ORIGIN:"https://write.example.org", TRUST_CADDY_PROXY:"1" } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise(resolve => server.close(resolve)); stores.close(); });
  const origin = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(origin); assert.match(await page.text(), /Каретка/); assert.equal(page.headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(origin, { headers:{ "If-None-Match":page.headers.get("etag") } })).status, 304);
  const sw = await fetch(origin + "/sw.js", {method:"HEAD"}); assert.equal(sw.headers.get("service-worker-allowed"), "/"); assert.equal(await sw.text(), "");
  assert.equal((await fetch(origin + "/missing")).status, 404);
  const result = await fetch(origin + "/api/account", { method:"POST", headers:{ "X-Karetka-Client-IP":"192.0.2.45" }, body:"{}" });
  assert.equal(result.headers.getSetCookie().length, 2); assert.equal(result.headers.get("cache-control"), "no-store"); assert.deepEqual(await result.json(), { ok:true });
  assert.deepEqual(observations[0], { url:"https://write.example.org/api/account", ip:"192.0.2.45", body:"{}" });
  assert.equal((await fetch(origin + "/api/large", { method:"POST", body:"a".repeat(520000) })).status, 413);
  assert.equal(observations.length, 1);
});
