import { randomBytes, randomUUID, scrypt as hashPassword } from "node:crypto";
import { promisify } from "node:util";
import { fail, get, mutate, sha, sameDigest } from "./data.mjs";

const scrypt = promisify(hashPassword);
const lifetime = 30 * 86400000;
const digestPattern = /^[a-f0-9]{64}$/;
const accountKey = (id) => "users/" + id;
export const userRecord = (store, id) => get(store, accountKey(id));
export function loginName(value) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(name)) fail(400, "Логин должен содержать от 3 до 32 латинских букв, цифр, дефисов или подчёркиваний.");
  return name;
}
function checkPassword(value, creating) {
  if (typeof value !== "string" || value.length < (creating ? 12 : 1) || value.length > 256)
    fail(400, "Пароль должен содержать от 12 до 256 символов.");
  return value;
}
async function passwordDigest(value, salt) {
  const bytes = await scrypt(value, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return bytes.toString("hex");
}
async function newPassword(value) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: await passwordDigest(checkPassword(value, true), salt) };
}
function protectedKeys(body) {
  const valid = (v, len) => typeof v === "string" && v.length === len && /^[a-zA-Z0-9_-]+$/.test(v);
  function wrap(value) {
    if (!valid(value?.salt, 22) || !valid(value?.iv, 16) || !valid(value?.data, 54))
      fail(400, "Не удалось проверить ключ личной библиотеки.");
    return { salt: value.salt, iv: value.iv, data: value.data };
  }
  if (typeof body.recoveryHash !== "string" || typeof body.accessHash !== "string" ||
      !digestPattern.test(body.recoveryHash) || !digestPattern.test(body.accessHash))
    fail(400, "Не удалось проверить ключи аккаунта.");
  return { recoveryHash: body.recoveryHash, accessHash: body.accessHash,
    keys: { password: wrap(body.keys?.password), recovery: wrap(body.keys?.recovery) } };
}
export async function ownerLogin(store, env) {
  const existing = await get(store, "system/owner");
  if (existing) return existing.login;
  const login = loginName(env.KARETKA_OWNER_LOGIN || "alchemist308");
  if (env.KARETKA_MANAGED_BLOBS === "netlify" && !env.KARETKA_OWNER_SETUP_HASH) {
    const activationCode = randomBytes(32).toString("hex");
    // Only the project operator can read this private blob in the Netlify dashboard.
    await store.setJSON("operator/owner-setup", { login, activationCode, hash: sha(activationCode) }, { onlyIfNew: true });
  }
  return (await mutate(store, "system/owner", (prior) => prior || { login, role: "owner" })).login;
}
async function canActivate(store, env, code) {
  if (typeof code !== "string" || code.length < 32 || code.length > 256) return false;
  const expected = env.KARETKA_OWNER_SETUP_HASH || (await get(store, "operator/owner-setup"))?.hash;
  return sameDigest(sha(code.trim()), expected);
}
export function cookieFor(request) {
  const url = new URL(request.url);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return local ? "karetka_dev" : "__Host-karetka_session";
}
function cookieHeader(request, value, age) {
  const name = cookieFor(request);
  return name + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + age +
    (name.startsWith("__Host-") ? "; Secure" : "");
}
export async function authenticate(request, store, now) {
  const cookie = (request.headers.get("cookie") || "").split(";").map((v) => v.trim())
    .find((v) => v.startsWith(cookieFor(request) + "="))?.split("=")[1];
  const parts = /^([a-f0-9]{64})\.([A-Za-z0-9_-]{43})$/.exec(cookie || "");
  if (!parts) return null;
  const user = await userRecord(store, parts[1]);
  const hash = sha(parts[2]);
  const session = user?.sessions.find((s) => s.expires > now && sameDigest(s.hash, hash));
  return session ? { user, session } : null;
}
function newSession(now) {
  const secret = randomBytes(32).toString("base64url");
  return { secret, record: { hash: sha(secret), tag: randomUUID(), expires: now + lifetime } };
}
function loggedIn(request, user, fresh) {
  return { user, sessionTag: fresh.record.tag, cookie: cookieHeader(request, user.id + "." + fresh.secret, lifetime / 1000) };
}

export async function register({ request, store, body, env, now }) {
  const login = loginName(body.login), id = sha(login);
  const owner = login === await ownerLogin(store, env);
  if (owner && !await canActivate(store, env, body.setupCode))
    fail(403, "Этот логин зарезервирован за владельцем. Для первого входа нужен код активации.");
  if (!owner && body.setupCode) fail(400, "Используйте зарезервированный логин владельца.");
  const protections = protectedKeys(body);
  if (await userRecord(store, id)) fail(409, "Этот логин уже занят.");
  const password = await newPassword(body.password);
  const fresh = newSession(now);
  const user = { id, login, role: owner ? "owner" : "writer", password, ...protections,
    createdAt: now, sessions: [fresh.record], grant: null };
  if (!(await store.setJSON(accountKey(id), user, { onlyIfNew: true })).modified)
    fail(409, "Этот логин уже занят.");
  if (owner && !env.KARETKA_OWNER_SETUP_HASH) {
    // Credentials are already claimed atomically by creation of the reserved user.
    await store.setJSON("operator/owner-setup", { activatedAt: now, login }).catch(() => {});
  }
  return loggedIn(request, user, fresh);
}
export async function signIn({ request, store, body, now }) {
  const id = sha(loginName(body.login)), existing = await userRecord(store, id);
  const pass = checkPassword(body.password, false);
  // Equal derivation cost even if the name does not exist.
  const calculated = await passwordDigest(pass, existing?.password.salt || "70886ba73c861605dbfe639c6ccafbbb");
  if (!sameDigest(calculated, existing?.password.hash)) fail(401, "Неверный логин или пароль.");
  const fresh = newSession(now);
  const user = await mutate(store, accountKey(id), (old) => {
    if (!sameDigest(old?.password.hash, calculated)) fail(401, "Войдите с действующим паролем.");
    return { ...old, sessions: [...old.sessions.filter((s) => s.expires > now).slice(-11), fresh.record] };
  });
  return loggedIn(request, user, fresh);
}
function validateRecovery(user, value) {
  const normalized = typeof value === "string" ? value.replace(/[\s-]/g, "").toLowerCase() : "";
  if (!/^[0-9a-f]{48}$/.test(normalized) || !sameDigest(sha(normalized), user?.recoveryHash))
    fail(401, "Неверный логин или резервный код.");
}
export async function recover({ request, store, body, now }, final) {
  const id = sha(loginName(body.login)), existing = await userRecord(store, id);
  validateRecovery(existing, body.recovery);
  if (!final) return { wrapped: existing.keys.recovery };
  const protections = protectedKeys(body);
  if (!sameDigest(protections.accessHash, existing.accessHash))
    fail(400, "Ключ библиотеки не совпадает с исходным.");
  const password = await newPassword(body.password), fresh = newSession(now);
  const user = await mutate(store, accountKey(id), (old) => {
    validateRecovery(old, body.recovery);
    return { ...old, password, ...protections, sessions: [fresh.record] };
  });
  return loggedIn(request, user, fresh);
}
export async function signOut({ request, store, body }, auth) {
  if (auth) {
    if (body.expectedUser && body.expectedUser !== auth.user.id ||
        body.expectedSession && body.expectedSession !== auth.session.tag)
      return { ignored: true };
    await mutate(store, accountKey(auth.user.id), (old) => old && ({
      ...old, sessions: old.sessions.filter((s) => s.tag !== auth.session.tag)
    }));
  }
  return { cookie: cookieHeader(request, "", 0) };
}
export async function throttle(store, key, max, now, duration = 600000) {
  await mutate(store, "limits/" + sha(key), (entry) => {
    if (!entry || entry.until <= now) return { count: 1, until: now + duration };
    if (entry.count >= max) fail(429, "Слишком много попыток. Попробуйте позже.");
    return { ...entry, count: entry.count + 1 };
  });
}
