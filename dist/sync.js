"use strict";
function KaretkaSync({
  books,
  store,
  uid,
  touch,
  flush,
  storageReady,
  hasError,
  refresh,
  notify,
  status
}) {
  const url = "./api/vault",
    encoder = new TextEncoder(),
    decoder = new TextDecoder();
  let keys = null,
    secret = store.readPref("vaultKey", ""),
    running = null,
    timer,
    timerAt = 0,
    retry = 5000,
    lastOK = 0,
    problem = "",
    syncState = "idle";
  function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 16384)
      s += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function un64(s) {
    const q = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(q, (ch) => ch.charCodeAt(0));
  }
  function normalize(s) {
    return s
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "");
  }
  function display(s) {
    return (s.match(/.{1,6}/g) || []).join("-");
  }
  async function derive(code) {
    if (!/^[0-9a-f]{48}$/.test(code))
      throw new Error(
        "В коде должно быть 48 шестнадцатеричных знаков. Скопируйте его с первого устройства."
      );
    const bytes = Uint8Array.from(code.match(/../g), (p) => parseInt(p, 16));
    const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, [
      "deriveBits",
      "deriveKey"
    ]);
    const param = (purpose) => ({
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("karetka-vault-v1"),
      info: encoder.encode(purpose)
    });
    const token = b64(
      new Uint8Array(await crypto.subtle.deriveBits(param("access"), material, 256))
    );
    const key = await crypto.subtle.deriveKey(
      param("manuscripts"),
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return { token, key };
  }
  async function call(k, method, query = "", payload) {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const r = await fetch(url + query, {
        method,
        headers: {
          Authorization: "Bearer " + k.token,
          ...(payload ? { "Content-Type": "application/json" } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined,
        cache: "no-store",
        signal: controller.signal
      });
      if (!(r.headers.get("content-type") || "").includes("application/json"))
        throw new Error(
          "Сервер синхронизации недоступен на этом адресе. Локальная копия сохранена."
        );
      const reply = await r.json();
      if (!r.ok) {
        const err = new Error(reply.error || "Сервер временно недоступен.");
        err.status = r.status;
        throw err;
      }
      return reply;
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError)
        throw new Error("Нет связи с хранилищем. Изменения остаются на устройстве.");
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  const claim = (b, etag, version) => ({ space: keys.token, etag, version });
  const base = (b) => (b.cloud?.space === keys.token ? b.cloud : null);
  const aad = (id, version) => encoder.encode("karetka/v1/" + id + "/" + version);
  function pack(b) {
    return {
      id: b.id,
      version: b.version,
      title: b.title,
      kind: b.kind,
      sections: b.sections,
      cards: b.cards || [],
      created: b.created,
      updated: b.updated
    };
  }
  async function send(b) {
    const snap = pack(b),
      baseETag = base(b)?.etag || null,
      iv = crypto.getRandomValues(new Uint8Array(12));
    let plain = encoder.encode(JSON.stringify(snap));
    let codec = "raw";
    if (
      plain.length > 65536 &&
      typeof CompressionStream === "function" &&
      typeof DecompressionStream === "function"
    ) {
      const zipped = new Uint8Array(
        await new Response(
          new Blob([plain]).stream().pipeThrough(new CompressionStream("gzip"))
        ).arrayBuffer()
      );
      if (zipped.length < plain.length) {
        plain = zipped;
        codec = "gzip";
      }
    }
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad(b.id, snap.version) },
        keys.key,
        plain
      )
    );
    const data = b64(cipher),
      limit = 480000;
    // A new upload ID keeps a retried or interrupted multi-part upload isolated.
    const envelope = { version: snap.version, iv: b64(iv), codec },
      id = b.id;
    if (data.length <= limit) envelope.data = data;
    else {
      const upload = uid(),
        parts = Math.ceil(data.length / limit);
      if (parts > 512)
        throw new Error(
          "Рукопись превышает предел облачной копии. Экспортируйте её или разделите на тома."
        );
      for (let i = 0; i < parts; i++)
        await call(keys, "PUT", "?id=" + id + "&upload=" + upload + "&part=" + i, {
          data: data.slice(i * limit, (i + 1) * limit)
        });
      envelope.upload = upload;
      envelope.parts = parts;
    }
    const remote = await call(keys, "PUT", "?id=" + id, { base: baseETag, head: envelope });
    b.cloud = claim(b, remote.etag, snap.version);
    touch(b, false);
  }
  async function receive(id) {
    const head = await call(keys, "GET", "?id=" + id);
    let data = head.data;
    if (!data) {
      const chunks = [];
      for (let i = 0; i < head.parts; i++) {
        const part = await call(keys, "GET", "?id=" + id + "&upload=" + head.upload + "&part=" + i);
        chunks.push(part.data);
      }
      data = chunks.join("");
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: un64(head.iv), additionalData: aad(id, head.version) },
      keys.key,
      un64(data)
    );
    const decoded =
      head.codec === "gzip"
        ? await new Response(
            new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))
          ).arrayBuffer()
        : plain;
    const b = JSON.parse(decoder.decode(decoded));
    if (
      b.id !== id ||
      b.version !== head.version ||
      !Array.isArray(b.sections) ||
      !b.sections.length
    )
      throw new Error("Не удалось проверить облачную копию.");
    validateCloudBook(b);
    return { book: b, etag: head.etag };
  }
  function validateCloudBook(b) {
    const check = (s) =>
      s && typeof s.id === "string" && typeof s.title === "string" && typeof s.text === "string";
    if (
      typeof b.title !== "string" ||
      !["single", "chapters", "scenes"].includes(b.kind) ||
      !b.sections.every((s) => check(s) && Array.isArray(s.scenes) && s.scenes.every(check))
    )
      throw new Error("Неизвестный формат облачной рукописи.");
  }
  function conflictCopy(local) {
    const copy = structuredClone(local);
    copy.id = uid();
    copy.version = uid();
    copy.rev = 0;
    copy.cloud = null;
    copy.updated = Date.now();
    copy.title += " (параллельная версия)";
    books.set(copy.id, copy);
    touch(copy, false);
    notify("Обе редакции сохранены. В «Рукописях» появилась параллельная версия.");
    return copy;
  }
  async function syncBook(id, remoteETag) {
    let local = books.get(id);
    if (!remoteETag) {
      if (local && !local.demo) await send(local);
      return;
    }
    if (local?.demo) return;
    if (local && base(local)?.etag === remoteETag) {
      if (local.version !== base(local).version) await send(local);
      return;
    }
    const incoming = await receive(id);
    local = books.get(id);
    if (local && local.version === incoming.book.version) {
      local.cloud = claim(local, incoming.etag, local.version);
      touch(local, false);
      return;
    }
    const copy =
      local && (!base(local) || local.version !== base(local).version) ? conflictCopy(local) : null;
    const b = {
      ...incoming.book,
      rev: local?.rev || 0,
      demo: false,
      cloud: claim(null, incoming.etag, incoming.book.version)
    };
    const prev = local?.version;
    books.set(id, b);
    touch(b, false);
    refresh(b, prev, copy);
  }
  function pendingBooks() {
    return [...books.values()].some((b) => !b.demo && (!base(b) || base(b).version !== b.version));
  }
  async function pass() {
    if (!secret || !storageReady()) return;
    if (!navigator.onLine) {
      problem = "Офлайн. Отправим изменения после подключения.";
      status();
      return;
    }
    if (!keys) keys = await derive(secret);
    syncState = "busy";
    problem = "";
    status();
    try {
      await flush();
      if ([...books.values()].some((b) => hasError(b.id)))
        throw new Error("Сначала требуется восстановить локальное сохранение.");
      const list = await call(keys, "GET"),
        heads = new Map(list.items.map((h) => [h.id, h.etag]));
      const ids = new Set([
        ...heads.keys(),
        ...[...books.values()].filter((b) => !b.demo).map((b) => b.id)
      ]);
      for (const id of ids) {
        try {
          await syncBook(id, heads.get(id));
        } catch (e) {
          if (e.status !== 409) throw e;
          const row = await call(keys, "GET", "?id=" + id);
          await syncBook(id, row.etag);
        }
      }
      await flush();
      lastOK = Date.now();
      problem = "";
      retry = 5000;
    } catch (e) {
      problem = e.message || "Нет связи с хранилищем.";
      throw e;
    } finally {
      syncState = "idle";
      status();
    }
  }
  function schedule(delay = 1400) {
    if (!secret || running || !navigator.onLine) return;
    // Do not postpone an already scheduled upload during continuous writing.
    const due = Date.now() + delay;
    if (timer && timerAt <= due) return;
    if (timer) clearTimeout(timer);
    timerAt = due;
    timer = setTimeout(() => {
      timer = null;
      void now().catch(() => {});
    }, delay);
  }
  function now() {
    if (running) return running;
    if (!secret) return Promise.resolve();
    if (!navigator.onLine) {
      status();
      return Promise.reject(new Error("Устройство сейчас офлайн."));
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    running = pass().finally(() => {
      running = null;
      if (!navigator.onLine) return;
      if (problem) {
        schedule(retry);
        retry = Math.min(120000, retry * 2);
      } else schedule(pendingBooks() ? 900 : 35000);
    });
    return running;
  }
  async function connect(value) {
    if (!storageReady())
      throw new Error("Хранилище браузера недоступно. Сначала сохраните рукопись в файл.");
    if (!window.isSecureContext || !crypto.subtle)
      throw new Error("Для синхронизации откройте опубликованное приложение по HTTPS.");
    if (!navigator.onLine) throw new Error("Первое подключение устройства требует интернета.");
    const creating = !value,
      code = creating
        ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) =>
            b.toString(16).padStart(2, "0")
          ).join("")
        : normalize(value);
    const pair = await derive(code);
    await call(pair, creating ? "POST" : "GET");
    store.writePref("vaultKey", code);
    if (store.readPref("vaultKey", "") !== code)
      throw new Error("Браузер не смог сохранить код. Освободите место и повторите.");
    secret = code;
    keys = pair;
    status();
    await now();
  }
  function badge(b) {
    if (!navigator.onLine) return "Офлайн · сохранено на устройстве";
    if (problem) return "Сохранено локально · ожидает связи";
    if (!keys || !base(b) || base(b).version !== b.version)
      return syncState === "busy" ? "Синхронизация…" : "Сохранено локально · в очереди";
    return "Сохранено в сети и на устройстве";
  }
  function info() {
    return !navigator.onLine
      ? "Офлайн. Изменения отправятся, когда приложение откроется с интернетом."
      : problem ||
          (syncState === "busy"
            ? "Идёт синхронизация…"
            : lastOK
              ? "Последняя синхронизация в " +
                new Date(lastOK).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit"
                }) +
                "."
              : "Устройство подключено.");
  }
  window.addEventListener("online", () => {
    void now().catch(() => {});
    status();
  });
  window.addEventListener("offline", status);
  window.addEventListener("focus", () => {
    if (secret && Date.now() - lastOK > 8000) void now().catch(() => {});
  });
  return {
    get connected() {
      return !!secret;
    },
    connect,
    now,
    schedule,
    code: () => display(secret),
    badge,
    info
  };
}
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaSync;
