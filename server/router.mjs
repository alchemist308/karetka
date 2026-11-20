import { register, signIn, recover, signOut, authenticate, ownerLogin, loginName, userRecord, throttle } from "./accounts.mjs";
import { plans, entitlement, billingStatus, billingAction, receiptOrders } from "./billing.mjs";
import { bookCount, personalLibrary, checkpoint } from "./library.mjs";
import { fail, mutate, readJSON, sha } from "./data.mjs";
import { vault } from "./vault.mjs";

const routes = new Map(Object.entries({
  "account/session":"GET", "account/register":"POST", "account/login":"POST", "account/logout":"POST",
  "account/recovery-key":"POST", "account/recover":"POST", "account/trial":"POST",
  "admin/users":"GET", "admin/user":"GET", "admin/grant":"POST",
  "pay/checkout":"POST", "pay/orders":"GET", "pay/order":"POST", "pay/webhook":"POST",
  "versions/list":"GET", "versions/get":"GET", "versions/part":"GET", "versions/save":"POST"
}));
const send = (status, data, cookie) => new Response(JSON.stringify(data), { status, headers: {
  "Content-Type":"application/json; charset=utf-8", "Cache-Control":"private, no-store",
  "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer", ...(cookie ? { "Set-Cookie":cookie } : {})
}});
const requireUser = (auth) => { if (!auth) fail(401, "Войдите в аккаунт."); return auth.user; };
function publicSeller(env) {
  function https(value) {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : ""; }
    catch { return ""; }
  }
  return { name: String(env.SELLER_NAME || "").trim(), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.SUPPORT_EMAIL || "") ? env.SUPPORT_EMAIL : "",
    offer: https(env.OFFER_URL), privacy: https(env.PRIVACY_URL) };
}
function originAllowed(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === url.origin || (origin === "https://karetka-alchemist308.netlify.app" && url.origin === "https://karetka.netlify.app");
}
async function card(store, user, now, admin = false) {
  const [rights, used] = await Promise.all([entitlement(store, user, now), bookCount(store, user.id, now)]);
  return { id: user.id, login: user.login, role: user.role, createdAt: user.createdAt, ...rights, used,
    trialUntil: user.trialUntil || null, trialAvailable: user.role !== "owner" && !user.trialUntil && rights.plan === "free",
    ...(admin ? { grant: user.grant || null } : {}) };
}
async function adminAction({ store, body, url, op, now }, operator) {
  if (operator.role !== "owner") fail(403, "Этот раздел доступен владельцу сервиса.");
  if (op === "users") {
    const cursor = url.searchParams.get("cursor") || "";
    if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) fail(400, "Некорректная страница.");
    const list = await store.list({ prefix: "users/" });
    const ids = list.blobs.map((b) => b.key.slice(6)).filter((id) => id > cursor).sort();
    const page = ids.slice(0, 20);
    const users = await Promise.all(page.map(async (id) => card(store, await userRecord(store, id), now, true)));
    return { users, next: ids.length > page.length ? page.at(-1) : null };
  }
  const id = sha(loginName(body?.login || url.searchParams.get("login")));
  const target = await userRecord(store, id);
  if (!target) fail(404, "Пользователь не найден.");
  if (op === "user") return { user: await card(store, target, now, true), orders: await receiptOrders(store, operator, id) };
  if (target.role === "owner") fail(409, "У владельца уже есть постоянный доступ ко всем функциям.");
  if (!plans.some((p) => p.id === body.plan)) fail(400, "Неизвестный тариф.");
  if (body.plan !== "free" && (!Number.isInteger(body.days) || body.days < 1 || body.days > 3650)) fail(400, "Срок доступа — от 1 до 3650 дней.");
  const grant = body.plan === "free" ? null : { plan: body.plan, until: now + body.days * 86400000 };
  const changed = await mutate(store, "users/" + id, (old) => ({ ...old, grant,
    grantHistory: [...(old.grantHistory || []).slice(-39), { at: now, by: operator.id, grant }] }));
  return { user: await card(store, changed, now, true) };
}
export async function route(request, { commerce: store, legacy, env = {}, ip = "local", clock = Date.now, fetcher = fetch }) {
  const url = new URL(request.url), path = url.pathname.replace(/^\/api\//, ""), now = clock();
  try {
    if (path === "health" && request.method === "GET") return send(200, { ok: true, version: "2.2.0" });
    if (!url.pathname.startsWith("/api/")) fail(404, "Страница не найдена.");
    if (path === "vault") return vault(request, legacy, { allowCreate: false });
    if (path !== "pay/webhook" && !originAllowed(request, url)) fail(403, "Недопустимый источник запроса.");
    if (path === "library") {
      const user = requireUser(await authenticate(request, store, now));
      return await personalLibrary(request, store, user, await entitlement(store, user, now), now);
    }
    if (!routes.has(path)) fail(404, "Действие не найдено.");
    if (routes.get(path) !== request.method) fail(405, "Метод недоступен.");
    if (request.method === "POST" && path !== "pay/webhook" && request.headers.get("x-karetka-request") !== "1" && !request.headers.get("origin"))
      fail(403, "Не удалось проверить источник запроса.");
    const body = request.method === "POST" ? await readJSON(request, path === "pay/webhook" ? 96000 : 16384) : {};
    const op = path.split("/")[1];
    const seller = publicSeller(env), billing = billingStatus(env);
    if (billing.mode === "live" && Object.values(seller).some((v) => !v)) billing.enabled = false;
    const ctx = { request, body, store, env, op, url, now, origin: env.PUBLIC_ORIGIN || env.URL || url.origin, fetcher };
    if (path === "pay/webhook") return send(200, await billingAction({ ...ctx, user: null }));
    if (["account/register", "account/login", "account/recovery-key", "account/recover"].includes(path)) {
      await throttle(store, "auth/ip/" + ip, 50, now);
      if (op === "register") await throttle(store, "signup/" + ip, 10, now, 3600000);
      else await throttle(store, "auth/name/" + sha(loginName(body.login)) + "/" + ip, 15, now);
      const result = op === "register" ? await register(ctx) : op === "login" ? await signIn(ctx) : await recover(ctx, op === "recover");
      if (!result.user) return send(200, result);
      return send(op === "register" ? 201 : 200, { user: await card(store, result.user, now), sessionTag: result.sessionTag,
        ...(op === "login" ? { wrapped: result.user.keys.password } : {}) }, result.cookie);
    }
    const auth = await authenticate(request, store, now);
    if (path === "account/session") return send(200, { user: auth ? await card(store, auth.user, now) : null, sessionTag: auth?.session.tag || null,
      ownerLogin: await ownerLogin(store, env), plans, billing, seller });
    if (path === "account/logout") {
      const result = await signOut(ctx, auth);
      return send(200, { ok: true, ignored: !!result.ignored }, result.cookie);
    }
    const user = requireUser(auth);
    if (path === "account/trial") {
      if (user.role === "owner" || (await entitlement(store, user, now)).plan !== "free") fail(409, "Пробный доступ уже не требуется.");
      const changed = await mutate(store, "users/" + user.id, (old) => {
        if (old.trialUntil) fail(409, "Пробный период уже использован.");
        return { ...old, trialUntil: now + 14 * 86400000 };
      });
      return send(200, { user: await card(store, changed, now) });
    }
    if (path.startsWith("admin/")) return send(200, await adminAction(ctx, user));
    if (path.startsWith("versions/")) return send(200, await checkpoint({ ...ctx, user, plans, rights: await entitlement(store, user, now) }));
    if (path === "pay/checkout") {
      if (!billing.enabled) fail(503, "Приём оплаты пока не подключён.");
      if (user.role === "owner") fail(409, "У владельца уже открыт полный доступ.");
      if (body.accepted !== true) fail(400, "Подтвердите условия покупки.");
      await throttle(store, "checkout/" + user.id, 12, now);
    }
    return send(200, await billingAction({ ...ctx, user }));
  } catch (err) {
    const known = Number.isInteger(err.status) && err.status >= 400 && err.status < 600;
    return send(known ? err.status : 503, { error: known ? err.message : "Сервис временно недоступен. Рукопись остаётся на устройстве." });
  }
}
