"use strict";
const KaretkaAccount = (() => {
  const utf8 = new TextEncoder();
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const bytes = (s) => Uint8Array.from(s.match(/../g), (p) => parseInt(p, 16));
  const b64 = (data) => btoa(String.fromCharCode(...new Uint8Array(data))).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const un64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const normalize = (s) => s.trim().toLowerCase().replace(/[\s-]/g, "");
  const random = (len) => crypto.getRandomValues(new Uint8Array(len));
  function cryptoReady() {
    if (!globalThis.crypto?.subtle) throw new Error("Чтобы открыть личную библиотеку, используйте HTTPS.");
  }
  async function wrappingKey(value, salt) {
    const base = await crypto.subtle.importKey("raw", utf8.encode(value), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function wrap(secret, credential) {
    const salt = random(16), iv = random(12);
    const key = await wrappingKey(credential, salt);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode("karetka-account-key-v1") }, key, bytes(secret));
    return { salt: b64(salt), iv: b64(iv), data: b64(data) };
  }
  async function unwrap(envelope, credential) {
    try {
      const key = await wrappingKey(credential, un64(envelope.salt));
      const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un64(envelope.iv), additionalData: utf8.encode("karetka-account-key-v1") }, key, un64(envelope.data));
      return hex(new Uint8Array(raw));
    } catch {
      throw new Error("Не удалось открыть ключ библиотеки. Проверьте пароль или резервный код.");
    }
  }
  async function sha(value) {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(value))));
  }
  async function protections(secret, password, recovery) {
    const material = await crypto.subtle.importKey("raw", bytes(secret), "HKDF", false, ["deriveBits"]);
    const token = b64(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("karetka-vault-v1"), info: utf8.encode("access") }, material, 256));
    const [pw, backup, recoveryHash, accessHash] = await Promise.all([wrap(secret, password), wrap(secret, recovery), sha(recovery), sha(token)]);
    return { keys: { password: pw, recovery: backup }, accessHash, recoveryHash };
  }
  async function call(path, body) {
    const options = { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
      headers: { "X-Karetka-Request": "1" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try { response = await fetch("./api/" + path, options); }
    catch { throw new Error("Нет связи с сервером. Текст сохраняется на этом устройстве."); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "Сервис временно недоступен."), { status: response.status });
    return data;
  }
  async function issue(login, password, vaultKey, op, extra) {
    const recovery = hex(random(24));
    const payload = await protections(vaultKey, password, recovery);
    const result = await call("account/" + op, { ...extra, ...payload, login, password });
    return { user: result.user, sessionTag: result.sessionTag, vaultKey, recovery: recovery.match(/.{6}/g).join("-") };
  }
  return {
    call,
    session: () => call("account/session"),
    logout: () => call("account/logout", {}),
    async register(login, password, setupCode) {
      cryptoReady();
      return issue(login, password, hex(random(24)), "register", { setupCode });
    },
    async login(login, password) {
      cryptoReady();
      const result = await call("account/login", { login, password });
      return { user: result.user, sessionTag: result.sessionTag, vaultKey: await unwrap(result.wrapped, password) };
    },
    async recover(login, value, password) {
      cryptoReady();
      const recovery = normalize(value);
      if (!/^[a-f0-9]{48}$/.test(recovery)) throw new Error("Проверьте резервный код из 48 знаков.");
      const first = await call("account/recovery-key", { login, recovery });
      const vaultKey = await unwrap(first.wrapped, recovery);
      return issue(login, password, vaultKey, "recover", { recovery });
    }
  };
})();
if (typeof window !== "undefined") window.KaretkaAccount = KaretkaAccount;
if (typeof module !== "undefined" && module.exports) module.exports = KaretkaAccount;
