import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, webcrypto, hkdfSync } from "node:crypto";
import { openStores } from "../server/sqlite-store.mjs";
import { route } from "../server/router.mjs";
import { sha, get } from "../server/data.mjs";
import privateFiles from "../dist/private-files.js";
const client = await readFile(new URL("../dist/account-keys.js",import.meta.url),"utf8");
const origin = "https://test.karetka.example";
const setup = randomBytes(32).toString("hex");
const pass = "тестовый пароль рукописи";
function install() {
  const stores=openStores(":memory:");
  let time=Date.now();
  const context={...stores,env:{PUBLIC_ORIGIN:origin,KARETKA_OWNER_LOGIN:"alchemist308",KARETKA_OWNER_SETUP_HASH:sha(setup)}, ip:"127.0.0.1",clock:()=>time};
  function device() {
    let cookie="";
    async function http(path,opts={}) {
      const headers=new Headers(opts.headers);
      if(cookie)headers.set("cookie",cookie);
      headers.set("origin",origin);
      const req=new Request(new URL(path,origin+"/"),{...opts,headers});
      const res=await route(req,context);
      if(res.headers.has("set-cookie")) cookie=res.headers.get("set-cookie").split(";")[0];
      return res;
    }
    const sandbox=vm.createContext({module:{exports:{}},crypto:webcrypto,TextEncoder,btoa,atob,fetch:http,Uint8Array});
    vm.runInContext(client,sandbox);
    return { app:sandbox.module.exports,http,get cookie(){return cookie;} };
  }
  return {context,device,advance:(days)=>time+=days*86400000};
}
test("account creation, independent sessions, key recovery, one-time owner activation and grants",async (t)=>{
  const f=install();t.after(()=>f.context.close());
  const a=f.device(), b=f.device(), boss=f.device();
  const reg=await a.app.register("writer_one",pass); assert.equal(reg.user.plan,"free");
  assert.equal((await a.app.session()).user.login,"writer_one");
  const saved=await get(f.context.commerce,"users/"+reg.user.id);
  assert.ok(!JSON.stringify(saved).includes(reg.vaultKey));assert.ok(!JSON.stringify(saved).includes(pass));
  assert.ok(!JSON.stringify(saved).includes(reg.recovery.replaceAll("-","")));
  assert.equal((await b.app.login("writer_one",pass)).vaultKey,reg.vaultKey);
  await assert.rejects(b.app.register("alchemist308",pass),{status:403});
  const owner=await boss.app.register("alchemist308",pass,setup);assert.equal(owner.user.role,"owner");assert.equal(owner.user.bookLimit,null);
  await assert.rejects(boss.app.register("alchemist308",pass,setup),{status:409});
  await assert.rejects(a.app.call("admin/users"),{status:403});
  const granted=await boss.app.call("admin/grant",{login:"writer_one",plan:"studio",days:7});assert.equal(granted.user.plan,"studio");
  assert.equal((await a.app.session()).user.bookLimit,100);
  await boss.app.call("admin/grant",{login:"writer_one",plan:"free",days:0});
  const trial=await a.app.call("account/trial",{});assert.equal(trial.user.plan,"author");
  f.advance(15);assert.equal((await a.app.session()).user.plan,"free");
  await assert.rejects(a.app.call("account/trial",{}),{status:409});
  const next=await b.app.recover("writer_one",reg.recovery,"другой очень длинный пароль");
  assert.equal(next.vaultKey,reg.vaultKey);assert.notEqual(next.recovery,reg.recovery);
  assert.equal((await a.app.session()).user,null);
  await assert.rejects(a.app.login("writer_one",pass),{status:401});
  await assert.rejects(a.app.recover("writer_one",reg.recovery,pass),{status:401});
  assert.equal((await b.app.session()).user.login,"writer_one");
});
test("online manuscript quotas, independent library keys and retained checkpoints after expiration",async(t)=>{
  const f=install();t.after(()=>f.context.close());const a=f.device(),other=f.device();
  const reg=await a.app.register("north_writer",pass);await other.app.register("east_writer",pass);
  const token=Buffer.from(hkdfSync("sha256",Buffer.from(reg.vaultKey,"hex"),Buffer.from("karetka-vault-v1"),Buffer.from("access"),32)).toString("base64url");
  const headers={authorization:"Bearer "+token,"content-type":"application/json"};
  const first=randomUUID(), second=randomUUID(), version=randomUUID(), iv=randomBytes(12).toString("base64url");
  const put=(d,id,ver,base=null)=>d.http("api/library?id="+id,{method:"PUT",headers,body:JSON.stringify({base,head:{iv,version:ver,data:"YWJjZA"}})});
  const initial=await put(a,first,version);assert.equal(initial.status,200);
  assert.equal((await put(a,second,randomUUID())).status,402);
  assert.equal((await other.http("api/library?id="+first,{headers})).status,403);
  await assert.rejects(a.app.call("versions/save",{bookId:first,version}),{status:402});
  await a.app.call("account/trial",{});
  assert.equal((await put(a,second,randomUUID())).status,200);
  await a.app.call("versions/save",{bookId:first,version});
  assert.equal((await a.app.call("versions/list?book="+first)).versions.length,1);
  await a.app.call("versions/save",{bookId:first,version});assert.equal((await a.app.call("versions/list?book="+first)).versions.length,1);
  f.advance(15);
  assert.equal((await a.app.call("versions/get?book="+first+"&id="+version)).data,"YWJjZA");
  assert.equal((await a.http("api/library?id="+second,{headers})).status,200);
  assert.equal((await put(a,second,randomUUID())).status,402);
  assert.equal((await other.app.call("versions/list?book="+first)).versions.length,0);
  assert.equal((await a.http("api/vault",{method:"POST",headers})).status,403);
});
test("portable manuscript files authenticate the contents and keep the title and text private",async()=>{
  const original='{"title":"Ледяной берег","sections":["Свет в окне"]}';
  const encrypted=await privateFiles.seal(original,pass);
  assert.ok(!Buffer.from(await encrypted.arrayBuffer()).includes(Buffer.from("Ледяной берег")));
  assert.equal(await privateFiles.unseal(encrypted,pass),original);
  await assert.rejects(privateFiles.unseal(encrypted,"неверный пароль рукописи"));
  const changed=Buffer.from(await encrypted.arrayBuffer());changed[changed.length-1]^=1;
  await assert.rejects(privateFiles.unseal(new Blob([changed]),pass));
});

test("a second device recovers the encrypted online draft after an offline edit and can open an older checkpoint", async (t) => {
  const f = install();
  t.after(() => f.context.close());
  const first = f.device(), second = f.device();
  const registered = await first.app.register("writer_offline", pass);
  await first.app.call("account/trial", {});
  const loggedIn = await second.app.login("writer_offline", pass);
  const [syncCode, formatCode, fileCode] = await Promise.all(
    ["sync.js", "formats.js", "private-files.js"].map(name => readFile(new URL("../dist/" + name, import.meta.url), "utf8"))
  );
  function signedDevice(accountDevice, access) {
    const books = new Map(), navigator = { onLine: true };
    const sandbox = vm.createContext({
      module: { exports: {} }, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, atob,
      structuredClone, CompressionStream, DecompressionStream, Blob, Response, AbortController, TypeError,
      navigator, window: { isSecureContext: true, addEventListener() {} },
      setTimeout: () => 1, clearTimeout() {}, fetch: accountDevice.http
    });
    vm.runInContext(syncCode, sandbox);
    const sync = sandbox.module.exports({
      account: true, books, store: { readPref: (key, fallback) => key === "vaultKey" ? access.vaultKey : fallback },
      checkSession: async () => (await accountDevice.app.session()).user?.id === access.user.id,
      uid: randomUUID, touch() {}, flush: async () => {}, storageReady: () => true,
      hasError: () => false, refresh() {}, notify() {}, status() {}
    });
    vm.runInContext(formatCode, sandbox);
    vm.runInContext(fileCode, sandbox);
    return { books, navigator, sync, files: sandbox.module.exports };
  }
  const pc = signedDevice(first, registered), tablet = signedDevice(second, loggedIn);
  const book = { id: randomUUID(), version: randomUUID(), rev: 1, created: 1, updated: 1, cards: [],
    title: "Письмо в пути", kind: "single",
    sections: [{ id: randomUUID(), title: "Письмо", text: "Первая строка.", plan: {}, scenes: [] }] };
  pc.books.set(book.id, book);
  await pc.sync.now();
  const checkpoint = book.version;
  await first.app.call("versions/save", { bookId: book.id, version: checkpoint });
  await tablet.sync.now();
  assert.equal(tablet.books.get(book.id).sections[0].text, "Первая строка.");
  pc.navigator.onLine = false;
  book.sections[0].text += " Написано в дороге без интернета.";
  book.version = randomUUID();
  await assert.rejects(pc.sync.now(), /офлайн/);
  pc.navigator.onLine = true;
  await pc.sync.now();
  await tablet.sync.now();
  assert.equal(tablet.books.get(book.id).sections[0].text, book.sections[0].text);
  f.advance(15);
  const head = await second.app.call("versions/get?book=" + book.id + "&id=" + checkpoint);
  const restored = await tablet.files.readSnapshot(loggedIn.vaultKey, book.id, head, head.data);
  assert.equal(restored.title, book.title);
  assert.equal(restored.sections[0].text, "Первая строка.");
});

test("managed Netlify bootstrap reserves a single owner code outside all public responses", async (t) => {
  const f = install();
  t.after(() => f.context.close());
  delete f.context.env.KARETKA_OWNER_SETUP_HASH;
  f.context.env.KARETKA_MANAGED_BLOBS = "netlify";
  const visitors = [f.device(), f.device()];
  const sessions = await Promise.all(visitors.map(device => device.app.session()));
  const operator = await get(f.context.commerce, "operator/owner-setup");
  assert.match(operator.activationCode, /^[0-9a-f]{64}$/);
  assert.equal(operator.hash, sha(operator.activationCode));
  for (const session of sessions) {
    assert.equal(session.ownerLogin, "alchemist308");
    assert.equal(session.user, null);
    assert.ok(!JSON.stringify(session).includes(operator.activationCode));
  }
  await assert.rejects(visitors[0].app.register("alchemist308", pass), { status: 403 });
  const activated = await visitors[1].app.register("alchemist308", pass, operator.activationCode);
  assert.equal(activated.user.role, "owner");
  assert.equal((await get(f.context.commerce, "operator/owner-setup")).activationCode, undefined);
  await visitors[0].app.session();
  assert.equal((await get(f.context.commerce, "operator/owner-setup")).activationCode, undefined);
});
