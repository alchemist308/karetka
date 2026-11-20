"use strict";

const KaretkaStore = (() => {
  const profileKey = "karetka.workspace.v1";
  const logoutKey = "karetka.workspace.logout.v1";
  const idPattern = /^[0-9a-f]{64}$/;

  function validProfile(profile) {
    return !!profile && typeof profile.id === "string" && idPattern.test(profile.id) &&
      typeof profile.login === "string" && profile.login.length > 0 && profile.login.length <= 200;
  }
  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); }
    catch { return null; }
  }
  function write(key, value) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }
  function forProfile(profile) {
    if (profile != null && !validProfile(profile)) throw new Error("Не удалось определить профиль.");
    // Guest names are the exact names used by the original offline editor.
    const prefix = profile ? "karetka.account.v1." + profile.id + "." : "karetka.v1.";
    const dbName = profile ? "karetka-account-v1-" + profile.id : "karetka-writing-v1";
    const listPrefix = prefix + "book.";
    let database, backend, secret = "", keyMaterial;
    const journalWork = new Map();
    const text = new TextEncoder(), decode = new TextDecoder();
    const sealName = "karetka-local-v1";
    const secretName = prefix + "session-key";
    const stampName = prefix + "device-stamp";
    function as64(bytes) {
      const a = new Uint8Array(bytes);
      let out = "";
      for (let i = 0; i < a.length; i += 16384) out += String.fromCharCode(...a.subarray(i, i + 16384));
      return btoa(out);
    }
    function from64(value) { return Uint8Array.from(atob(value), ch => ch.charCodeAt(0)); }
    async function deviceRecord(mode, operation) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("karetka-device-keys-v1", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("trusted");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("Хранилище ключей занято."));
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("trusted", mode), req = operation(tx.objectStore("trusted"));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = tx.onabort = () => reject(tx.error || new Error("Ключ устройства недоступен."));
        });
      } finally { db.close(); }
    }
    function clearTabSecret() { try { sessionStorage.removeItem(secretName); } catch {} }
    async function setVaultKey(value) {
      if (!profile || !/^[0-9a-f]{48}$/.test(value)) throw new Error("Нужен ключ личного профиля.");
      const stamp = as64(crypto.getRandomValues(new Uint8Array(24)));
      try {
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text.encode(profile.id + stamp) }, key, text.encode(value));
        await deviceRecord("readwrite", os => os.put({ key, iv, cipher }, profile.id));
        clearTabSecret();
      } catch {
        // Browsers without usable IndexedDB can keep an unlocked key for this tab's session.
        sessionStorage.setItem(secretName, JSON.stringify({ key: value, stamp }));
      }
      localStorage.setItem(stampName, stamp);
      localStorage.removeItem(prefix + "vaultKey");
      secret = value;
      keyMaterial = null;
    }
    async function restoreVaultKey() {
      if (!profile || secret) return secret;
      const stamp = localStorage.getItem(stampName);
      if (stamp) {
        try {
          const entry = await deviceRecord("readonly", os => os.get(profile.id));
          if (entry) {
            const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: entry.iv, additionalData: text.encode(profile.id + stamp) }, entry.key, entry.cipher);
            secret = decode.decode(bytes);
          }
        } catch {}
        if (!secret) {
          try {
            const temp = JSON.parse(sessionStorage.getItem(secretName));
            if (temp?.stamp === stamp) secret = temp.key;
          } catch {}
        }
      }
      if (!/^[0-9a-f]{48}$/.test(secret)) {
        secret = "";
        const legacy = read(prefix + "vaultKey");
        if (/^[0-9a-f]{48}$/.test(legacy || "")) await setVaultKey(legacy);
      }
      return secret;
    }
    async function forgetVaultKey() {
      if (!profile) return;
      secret = ""; keyMaterial = null;
      clearTabSecret();
      localStorage.removeItem(stampName);
      localStorage.removeItem(prefix + "vaultKey");
      try { await deviceRecord("readwrite", os => os.delete(profile.id)); } catch {}
    }
    async function localKey() {
      if (!secret) throw new Error("Личная библиотека закрыта. Войдите с паролем для расшифровки.");
      if (!keyMaterial) {
        const seed = Uint8Array.from(secret.match(/../g), x => parseInt(x, 16));
        keyMaterial = crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveKey"]).then(base =>
          crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: text.encode(sealName), info: text.encode(profile.id) },
            base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
      }
      return keyMaterial;
    }
    function parameters(kind, envelope) {
      return { name: "AES-GCM", iv: from64(envelope.iv),
        additionalData: text.encode([sealName, profile.id, kind, envelope.id, envelope.rev, envelope.version].join("/")) };
    }
    async function seal(kind, book, bytes) {
      const env = { sealed: sealName, id: book.id, rev: book.rev || 0, version: book.version,
        iv: as64(crypto.getRandomValues(new Uint8Array(12))) };
      const cipher = await crypto.subtle.encrypt(parameters(kind, env), await localKey(), bytes);
      env.cipher = as64(cipher); return env;
    }
    async function unseal(kind, value) {
      const plain = await crypto.subtle.decrypt(parameters(kind, value), await localKey(), from64(value.cipher));
      return JSON.parse(decode.decode(plain));
    }
    function openDatabase() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("books", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("Хранилище занято другой вкладкой."));
      });
    }
    function prefKeys(startsWith) {
      const names = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix + startsWith)) names.push(k.slice(prefix.length));
      }
      return names;
    }
    function rawBooks() {
      if (backend === "local") {
        return Promise.resolve(prefKeys("book.").map((name) => JSON.parse(localStorage.getItem(prefix + name))));
      }
      return new Promise((resolve, reject) => {
        const req = database.transaction("books").objectStore("books").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function readAll() {
      const rows = await rawBooks();
      if (!profile) return rows;
      await localKey();
      const opened = [];
      for (const row of rows) {
        if (row.sealed === sealName) opened.push(await unseal("book", row));
        else {
          // Upgrade the same revision conditionally so another tab's edits win.
          const replaced = await writeBook(await seal("book", row, text.encode(JSON.stringify(row))), row.rev);
          if (!replaced) return readAll();
          opened.push(row);
        }
      }
      return opened;
    }
    async function open() {
      if (profile) await restoreVaultKey();
      if (backend) return readAll();
      let preferred;
      try { preferred = localStorage.getItem(prefix + "backend"); } catch {}
      if (preferred !== "local") {
        try {
          database = await openDatabase();
          backend = "db";
        } catch (e) {
          if (preferred === "db") throw e;
        }
      }
      if (!backend) {
        localStorage.setItem(prefix + "probe", "1");
        localStorage.removeItem(prefix + "probe");
        backend = "local";
      }
      try { localStorage.setItem(prefix + "backend", backend); } catch {}
      return readAll();
    }
    async function save(book, expected) {
      const row = profile ? await seal("book", book, text.encode(JSON.stringify(book))) : book;
      return writeBook(row, expected);
    }
    function writeBook(book, expected) {
      if (backend === "local") {
        const key = listPrefix + book.id,
          old = localStorage.getItem(key);
        if (old && JSON.parse(old).rev !== expected) return Promise.resolve(false);
        localStorage.setItem(key, JSON.stringify(book));
        return Promise.resolve(true);
      }
      return new Promise((resolve, reject) => {
        const tx = database.transaction("books", "readwrite"),
          store = tx.objectStore("books");
        let matches = true;
        const req = store.get(book.id);
        req.onsuccess = () => {
          const old = req.result;
          if (old && old.rev !== expected) { matches = false; return; }
          store.put(book);
        };
        tx.oncomplete = () => resolve(matches);
        tx.onabort = tx.onerror = () =>
          reject(tx.error || new Error("Не удалось сохранить рукопись."));
      });
    }
    async function writeJournal(id, entry) {
      const name = "journal." + id;
      if (!profile) { write(prefix + name, entry); return; }
      const old = journalWork.get(id);
      if (old?.version === entry.book.version) return old.done;
      const job = { version: entry.book.version };
      journalWork.set(id, job);
      job.done = seal("journal", entry.book, text.encode(JSON.stringify(entry))).then(envelope => {
        if (journalWork.get(id) === job) write(prefix + name, envelope);
      }).finally(() => {
        if (journalWork.get(id) === job) journalWork.delete(id);
      });
      return job.done;
    }
    async function readJournal(name) {
      const value = read(prefix + name);
      if (!profile || !value) return value;
      if (value.sealed === sealName) return unseal("journal", value);
      if (value.book) await writeJournal(value.book.id, value);
      return value;
    }
    function clearJournal(name, version) {
      const id = name.slice("journal.".length);
      if (journalWork.get(id)?.version === version) journalWork.delete(id);
      const value = read(prefix + name);
      if (value && (value.version || value.book?.version) === version) localStorage.removeItem(prefix + name);
    }
    function readPref(key, fallback) {
      if (profile && key === "vaultKey") return secret || fallback;
      const value = read(prefix + key);
      return value === null ? fallback : value;
    }
    function writePref(key, value) {
      if (profile && (key === "vaultKey" || key.startsWith("journal.") || key.startsWith("book.")))
        throw new Error("Личные рукописи и ключи сохраняются через защищённое хранилище.");
      try { write(prefix + key, value); } catch {}
    }
    return {
      open, readAll, save, readPref, writePref, prefKeys, writeJournal, readJournal, clearJournal,
      setVaultKey, restoreVaultKey, forgetVaultKey, clearTabSecret,
      isCloudSetting: (key) => key === prefix + "cloudEnabled",
      close: () => { database?.close(); database = null; backend = null; }
    };
  }

  return {
    profileKey, validProfile, forProfile,
    currentProfile() {
      const profile = read(profileKey);
      return validProfile(profile) ? profile : null;
    },
    setProfile(profile) {
      if (profile != null && !validProfile(profile)) throw new Error("Не удалось определить профиль.");
      write(profileKey, profile);
    },
    pendingLogout: () => read(logoutKey),
    setPendingLogout: (value) => write(logoutKey, value)
  };
})();

// Each open page holds one immutable storage scope. Changing it starts a fresh editor.
function KaretkaLocalWorkspace({ profile, store, beforeChange, cancelChange, reload, copyBook }) {
  let changing = false, sessionCheck, logoutCheck;
  const sameId = (a, b) => (a?.id || null) === (b?.id || null);
  const sameSession = (a, b) => !!a && a.id === b?.id && a.sessionTag === b?.sessionTag;
  const active = () => !changing && sameId(profile, KaretkaStore.currentProfile());

  async function move(change) {
    if (changing) throw new Error("Идёт смена рабочего пространства.");
    changing = true;
    try {
      await beforeChange();
      await change();
      reload();
    } catch (e) {
      changing = false;
      cancelChange();
      throw e;
    }
  }
  async function followProfile() {
    if (!changing && !sameId(profile, KaretkaStore.currentProfile())) await move(() => store.clearTabSecret());
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      return await fetch("./api/account/" + path, {
        credentials: "same-origin", cache: "no-store", ...options, signal: controller.signal
      });
    } finally { clearTimeout(timer); }
  }
  async function session() {
    try {
      const res = await request("session");
      if (res.status === 401 || res.status === 403) return { user: null };
      if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return null;
      const info = await res.json();
      if (info?.user === null || KaretkaStore.validProfile(info?.user)) return info;
    } catch {}
    return null;
  }
  async function clearOldKey() {
    if (profile) await store.forgetVaultKey();
  }
  function verify() {
    if (sessionCheck) return sessionCheck;
    sessionCheck = (async () => {
      if (!active()) { await followProfile(); return false; }
      if (!profile) return true;
      if (!navigator.onLine) return false;
      const result = await session();
      if (!result || !active()) { await followProfile(); return false; }
      if (!sameId(profile, result.user)) {
        await move(async () => {
          if (sameId(profile, KaretkaStore.currentProfile())) {
            KaretkaStore.setProfile(null);
            await clearOldKey();
          }
        });
        return false;
      }
      if (typeof result.sessionTag === "string" && profile.sessionTag !== result.sessionTag) {
        profile.sessionTag = result.sessionTag;
        KaretkaStore.setProfile(profile);
      }
      return true;
    })().finally(() => { sessionCheck = null; });
    return sessionCheck;
  }
  function finishLogout() {
    if (logoutCheck) return logoutCheck;
    logoutCheck = (async () => {
      const pending = KaretkaStore.pendingLogout();
      if (!pending?.sessionTag || !navigator.onLine) return;
      const current = await session();
      if (!current || !sameSession(pending, KaretkaStore.pendingLogout())) return;
      if (sameSession(pending, { id: current.user?.id, sessionTag: current.sessionTag })) {
        try {
          const res = await request("logout", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Karetka-Request": "1" },
            body: JSON.stringify({ expectedUser: pending.id, expectedSession: pending.sessionTag })
          });
          if (!res.ok && ![401, 409].includes(res.status)) return;
        } catch { return; }
      }
      if (sameSession(pending, KaretkaStore.pendingLogout())) KaretkaStore.setPendingLogout(null);
    })().finally(() => { logoutCheck = null; });
    return logoutCheck;
  }
  async function switchTo(user, vaultKey) {
    if (!KaretkaStore.validProfile(user)) throw new Error("Недействительный профиль.");
    if (vaultKey != null && !/^[0-9a-f]{48}$/.test(vaultKey))
      throw new Error("Сервер вернул недействительный ключ хранилища.");
    const next = { id: user.id, login: user.login };
    if (typeof user.sessionTag === "string") next.sessionTag = user.sessionTag;
    await move(async () => {
      if (vaultKey != null) {
        const target = KaretkaStore.forProfile(next);
        await target.setVaultKey(vaultKey);
        if (target.readPref("vaultKey", "") !== vaultKey)
          throw new Error("Не удалось сохранить ключ профиля на устройстве.");
      }
      KaretkaStore.setPendingLogout(null);
      if (profile && !sameId(profile, next)) await clearOldKey();
      KaretkaStore.setProfile(next);
    });
  }
  async function leave() {
    if (!profile) return;
    await move(async () => {
      if (!sameId(profile, KaretkaStore.currentProfile())) return;
      const current = KaretkaStore.currentProfile();
      if (current?.sessionTag) {
        KaretkaStore.setPendingLogout({ id: profile.id, sessionTag: current.sessionTag });
      }
      KaretkaStore.setProfile(null);
      await clearOldKey();
      await finishLogout();
    });
  }
  async function guestRows() {
    if (!profile || !active()) throw new Error("Сначала войдите в свой профиль.");
    const guest = KaretkaStore.forProfile(null);
    try { return (await guest.open()).filter(b => !b.demo); }
    finally { guest.close(); }
  }
  async function importGuest(id) {
    const source = (await guestRows()).find(b => b.id === id);
    if (!source || !active()) throw new Error("Гостевая рукопись не найдена.");
    // The same revision imported twice, including on two tabs, has one destination.
    const material = new TextEncoder().encode([profile.id, source.id, source.version].join("/"));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
    const copyId = Array.from(hash.subarray(0, 16), b => b.toString(16).padStart(2, "0")).join("");
    if (!active()) throw new Error("Рабочее пространство изменилось.");
    return copyBook({ ...source, id: copyId, rev: 0, cloud: null, demo: false });
  }
  return {
    profile: () => profile && { ...profile },
    switchTo, leave, importGuest,
    guestBooks: async () => (await guestRows()).map(({ id, title }) => ({ id, title })),
    active, followProfile, verify, finishLogout,
    lock: () => move(() => { if (sameId(profile, KaretkaStore.currentProfile())) KaretkaStore.setProfile(null); })
  };
}
