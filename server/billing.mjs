import { randomUUID } from "node:crypto";
import { fail, get, mutate, sha } from "./data.mjs";

export const plans = [
  { id: "free", title: "Черновик", limit: 1, versions: 0, month: 0, year: 0 },
  { id: "author", title: "Автор", limit: 20, versions: 5, month: 299, year: 2990 },
  { id: "studio", title: "Мастерская", limit: 100, versions: 25, month: 599, year: 5990 }
];
const day = 86400000;
const periods = { month: 30, year: 365 };
const validId = (value) => typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const accountPattern = /^[\da-f]{64}$/;
const paidStatus = (o) => o.status === "succeeded" || o.status === "partially_refunded";
const key = (account) => "billing/" + account;

export function billingStatus(env = {}) {
  const mode = env.BILLING_MODE;
  const configured = (mode === "test" || mode === "live") &&
    /^\d+$/.test(env.YOOKASSA_SHOP_ID || "") && !!env.YOOKASSA_SECRET_KEY &&
    (env.RECEIPT_MODE === "manual_npd" ||
      (env.RECEIPT_MODE === "provider" && /^(?:[1-9]|1[0-2])$/.test(env.RECEIPT_VAT_CODE || "")));
  return { enabled: configured, mode: configured ? mode : "off" };
}

function purchaseTerms(ledger) {
  const paid = Object.values(ledger || {}).filter(o => o.mode === "live" && paidStatus(o))
    .sort((a, b) => a.paidAt - b.paidAt || a.id.localeCompare(b.id));
  const ends = {}, byOrder = {};
  for (const order of paid) {
    const start = Math.max(ends[order.plan] || 0, order.paidAt, order.afterTrial || 0);
    byOrder[order.id] = ends[order.plan] = start + periods[order.period] * day;
  }
  return { ends, byOrder };
}

export async function entitlement(store, user, now = Date.now()) {
  if (user?.role === "owner") return { plan: "studio", until: null, bookLimit: null };
  const ledger = user?.id ? await get(store, key(sha(user.id))) : null;
  const { ends } = purchaseTerms(ledger);
  if (Number.isFinite(user?.trialUntil))
    ends.author = Math.max(ends.author || 0, user.trialUntil);
  const grant = user?.grant;
  if (["studio", "author"].includes(grant?.plan)) {
    if (grant.until === null) ends[grant.plan] = Infinity;
    else if (Number.isFinite(grant.until)) ends[grant.plan] = Math.max(ends[grant.plan] || 0, grant.until);
  }
  for (const plan of [plans[2], plans[1]]) {
    if (ends[plan.id] > now)
      return { plan: plan.id, until: Number.isFinite(ends[plan.id]) ? ends[plan.id] : null, bookLimit: plan.limit };
  }
  return { plan: "free", until: null, bookLimit: 1 };
}

function showOrder(o, byOrder) {
  return { id: o.id, plan: o.plan, period: o.period, amount: o.amount, status: o.status,
    createdAt: o.createdAt, test: o.mode === "test", until: byOrder[o.id] || null,
    ...(o.status === "pending" && o.url ? { url: o.url } : {}) };
}

export async function receiptOrders(store, operator, accountId) {
  if (operator?.role !== "owner") fail(403, "Доступ к чекам есть только у владельца.");
  if (typeof accountId !== "string" || !accountId) fail(400, "Укажите аккаунт.");
  const ledger = await get(store, key(sha(accountId)));
  const { byOrder } = purchaseTerms(ledger);
  return Object.values(ledger || {}).filter(o => o.mode === "live" && o.paidAt)
    .sort((a, b) => b.paidAt - a.paidAt)
    .map(o => ({ ...showOrder(o, byOrder), receiptEmail: o.email, providerId: o.remoteId,
      paidAt: o.paidAt, refundedRub: (o.refundedCents || 0) / 100, receiptMode: o.receiptMode,
      acceptedAt: o.acceptedAt, offer: o.offer, privacy: o.privacy }));
}

async function provider(ctx, path, options = {}) {
  const headers = { Authorization: "Basic " + Buffer.from(ctx.env.YOOKASSA_SHOP_ID + ":" + ctx.env.YOOKASSA_SECRET_KEY).toString("base64"),
    "Content-Type": "application/json" };
  if (options.idempotence) headers["Idempotence-Key"] = options.idempotence;
  try {
    const response = await ctx.fetcher("https://api.yookassa.ru/v3/" + path, {
      method: options.payload ? "POST" : "GET", headers, redirect: "error",
      signal: AbortSignal.timeout(8000), ...(options.payload ? { body: JSON.stringify(options.payload) } : {})
    });
    if (response.ok) return await response.json();
    if (response.status === 404 && !options.payload) return null;
  } catch { /* Network errors and invalid JSON leave the saved order available for reconciliation. */ }
  fail(503, "ЮKassa не подтвердила операцию. Статус можно проверить в кабинете.");
}

function cents(amount) {
  if (amount?.currency !== "RUB" || typeof amount.value !== "string" || !/^\d{1,10}\.\d{2}$/.test(amount.value)) return NaN;
  return Number(amount.value.replace(".", ""));
}

function checkoutUrl(raw) {
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === "https:" && !url.username && !url.password &&
    /(^|\.)(yoomoney|yookassa)\.ru$/.test(url.hostname) ? url.href : null;
}

function sameShop(order, ctx) {
  return order.mode === ctx.mode && order.shop === String(ctx.env.YOOKASSA_SHOP_ID);
}

function confirmedOrder(order, account, remote, refund, ctx) {
  const metadata = remote?.metadata;
  if (!validId(remote?.id) || (order.remoteId && order.remoteId !== remote.id) ||
      metadata?.karetka_account !== account || metadata.karetka_order !== order.id ||
      !sameShop(order, ctx) || remote.test !== (order.mode === "test") ||
      String(remote.recipient?.account_id) !== order.shop || cents(remote.amount) !== order.amount * 100 ||
      !["pending", "waiting_for_capture", "succeeded", "canceled"].includes(remote.status)) {
    fail(502, "Реквизиты подтверждения ЮKassa не совпали с заказом.");
  }
  const update = { ...order, remoteId: remote.id };
  if (remote.status === "succeeded") {
    if (!remote.paid) fail(502, "Оплата заказа пока не подтверждена.");
    const reported = remote.refunded_amount ? cents(remote.refunded_amount) : 0;
    if (!Number.isFinite(reported) || reported > order.amount * 100) fail(502, "ЮKassa прислала некорректную сумму возврата.");
    let refunds = order.refunds || {};
    if (refund) {
      const amount = cents(refund.amount);
      if (refund.payment_id !== remote.id || refund.status !== "succeeded" || !Number.isFinite(amount) ||
          !amount || amount > order.amount * 100 || (refunds[refund.id] && refunds[refund.id] !== amount))
        fail(502, "Возврат не соответствует заказу.");
      refunds = { ...refunds, [refund.id]: amount };
    }
    const refunded = Math.max(order.refundedCents || 0, reported, Object.values(refunds).reduce((a,b) => a+b, 0));
    if (refunded > order.amount * 100) fail(502, "Сумма возвратов превысила стоимость заказа.");
    update.refundedCents = refunded;
    if (refund) update.refunds = refunds;
    update.status = refunded === order.amount * 100 ? "refunded" : refunded ? "partially_refunded" : "succeeded";
    update.paidAt = order.paidAt || Date.parse(remote.captured_at) || ctx.now;
    delete update.url;
  } else if (!order.paidAt && order.status !== "canceled") {
    update.status = remote.status === "canceled" ? "canceled" : "pending";
    if (update.status === "canceled") delete update.url;
    else {
      const url = checkoutUrl(remote.confirmation?.confirmation_url);
      if (url) update.url = url;
    }
  }
  return update;
}

async function applyPayment(ctx, account, id, remote, refund = null) {
  const updated = await mutate(ctx.store, key(account), ledger => {
    if (!ledger?.[id]) fail(404, "Заказ не найден.");
    const next = confirmedOrder(ledger[id], account, remote, refund, ctx);
    return JSON.stringify(ledger[id]) === JSON.stringify(next) ? ledger : { ...ledger, [id]: next };
  });
  return updated[id];
}

function newOrder(ctx, id, plan, period, email, method) {
  let url;
  try { url = new URL("/", ctx.origin); } catch { fail(503, "Для оплаты нужен адрес сайта."); }
  if (url.protocol !== "https:" && !(ctx.mode === "test" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    fail(503, "Для оплаты нужен HTTPS-адрес сайта.");
  url.searchParams.set("payment", id);
  url.hash = "account";
  return { id, plan: plan.id, period, email, method, amount: plan[period], status: "pending",
    createdAt: ctx.now, acceptedAt: ctx.now, offer: ctx.env.OFFER_URL || null, privacy: ctx.env.PRIVACY_URL || null,
    ...(plan.id === "author" && Number.isFinite(ctx.trialUntil) && ctx.trialUntil > ctx.now ? { afterTrial: ctx.trialUntil } : {}),
    mode: ctx.mode, shop: String(ctx.env.YOOKASSA_SHOP_ID), receiptMode: ctx.env.RECEIPT_MODE,
    ...(ctx.env.RECEIPT_MODE === "provider" ? { vat: Number(ctx.env.RECEIPT_VAT_CODE) } : {}),
    returnUrl: url.href, idempotence: randomUUID() };
}

function paymentPayload(account, order) {
  const name = plans.find(p => p.id === order.plan).title;
  const description = "Каретка — " + name + ", доступ на " + periods[order.period] + " дней";
  const amount = { value: order.amount.toFixed(2), currency: "RUB" };
  return { amount, capture: true, confirmation: { type: "redirect", return_url: order.returnUrl },
    description, metadata: { karetka_account: account, karetka_order: order.id },
    ...(order.method === "yoo_money" ? { payment_method_data: { type: "yoo_money" } } : {}),
    ...(order.receiptMode === "provider" ? { receipt: { customer: { email: order.email },
      items: [{ description, amount, quantity: "1.00", vat_code: order.vat, payment_mode: "full_payment", payment_subject: "service" }] } } : {}) };
}

async function checkout(ctx, account, body) {
  if (ctx.mode === "off") fail(503, "Приём оплаты пока не подключён.");
  const plan = plans.find(p => p.id === body.plan && p.id !== "free");
  const { period, requestId: id } = body;
  const method = body.method === "yoomoney" ? "yoo_money" : body.method ?? "auto";
  if (!["auto", "yoo_money"].includes(method)) fail(400, "Выберите способ оплаты.");
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!plan || !Object.hasOwn(periods, period) || !validId(id)) fail(400, "Проверьте тариф, срок и номер заказа.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Укажите электронную почту для чека.");
  const ledger = await mutate(ctx.store, key(account), previous => {
    if (previous?.[id]) {
      const old = previous[id];
      if (old.plan !== plan.id || old.period !== period || old.email !== email || (old.method || "auto") !== method || !sameShop(old, ctx))
        fail(409, "Этот номер уже связан с другим заказом.");
      return previous;
    }
    if (Object.values(previous || {}).filter(o => o.createdAt > ctx.now - 3600000).length >= 12)
      fail(429, "Слишком много новых заказов. Откройте недавний заказ в кабинете.");
    return { ...previous, [id]: newOrder(ctx, id, plan, period, email, method) };
  });
  let order = ledger[id];
  if (order.status === "pending" && !order.url) {
    let payment;
    if (order.remoteId) payment = await provider(ctx, "payments/" + order.remoteId);
    else {
      if (ctx.now - order.createdAt >= day)
        fail(409, "Срок запроса истёк. Проверьте заказ в кабинете и при необходимости создайте новый.");
      payment = await provider(ctx, "payments", { idempotence: order.idempotence, payload: paymentPayload(account, order) });
    }
    if (!payment) fail(503, "Не удалось найти платёж в ЮKassa.");
    order = await applyPayment(ctx, account, id, payment);
  }
  if (order.status === "pending" && !order.url) fail(503, "Ссылка на оплату ещё не готова. Проверьте заказ позднее.");
  return { url: order.status === "pending" ? order.url : order.returnUrl, orderId: id };
}

async function refresh(ctx, account, order) {
  if (order.remoteId && sameShop(order, ctx) && ctx.mode !== "off") {
    const payment = await provider(ctx, "payments/" + order.remoteId);
    if (payment) await applyPayment(ctx, account, order.id, payment);
  }
}

async function webhook(ctx, body) {
  if (ctx.mode === "off") fail(503, "Приём оплаты приостановлен.");
  if (body.type !== "notification" || !validId(body.object?.id)) fail(400, "Некорректное уведомление.");
  let refund, payment;
  if (body.event === "refund.succeeded") {
    refund = await provider(ctx, "refunds/" + body.object.id);
    if (!refund || refund.id !== body.object.id || refund.status !== "succeeded" || !validId(refund.payment_id))
      return { received: true };
    payment = await provider(ctx, "payments/" + refund.payment_id);
  } else if (["payment.succeeded", "payment.canceled", "payment.waiting_for_capture"].includes(body.event)) {
    const claimed = body.object.metadata;
    if (!accountPattern.test(claimed?.karetka_account || "") || !validId(claimed?.karetka_order)) return { received: true };
    const ledger = await get(ctx.store, key(claimed.karetka_account));
    if (!ledger?.[claimed.karetka_order]) return { received: true };
    payment = await provider(ctx, "payments/" + body.object.id);
  } else return { received: true };
  if (!payment) return { received: true };
  if (payment.id !== (refund?.payment_id || body.object.id)) fail(502, "ЮKassa вернула другой идентификатор платежа.");
  const account = payment.metadata?.karetka_account, id = payment.metadata?.karetka_order;
  if (!accountPattern.test(account || "") || !validId(id)) return { received: true };
  if ((await get(ctx.store, key(account)))?.[id]) await applyPayment(ctx, account, id, payment, refund);
  return { received: true };
}

export async function billingAction({ op, body = {}, request, user, store, env = {}, origin, now = Date.now(), fetcher = fetch }) {
  const { mode } = billingStatus(env);
  const ctx = { store, env, origin, now, fetcher, mode, trialUntil: user?.trialUntil };
  if (request.method !== (op === "orders" ? "GET" : "POST")) fail(405, "Метод запроса недоступен.");
  if (op === "webhook") return webhook(ctx, body || {});
  if (!user?.id) fail(401, "Для оплаты войдите в аккаунт.");
  const account = sha(user.id);
  if (op === "checkout") return checkout(ctx, account, body || {});
  let ledger = (await get(store, key(account))) || {};
  if (op === "order") {
    const id = body?.orderId;
    if (!validId(id) || !ledger[id]) fail(404, "Заказ не найден.");
    await refresh(ctx, account, ledger[id]);
    ledger = (await get(store, key(account))) || {};
    return { order: showOrder(ledger[id], purchaseTerms(ledger).byOrder) };
  }
  if (op !== "orders") fail(404, "Операция не найдена.");
  const recent = Object.values(ledger).filter(o => o.status === "pending" && o.remoteId && sameShop(o, ctx))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 3);
  if (recent.length && mode !== "off") {
    await Promise.allSettled(recent.map(o => refresh(ctx, account, o)));
    ledger = (await get(store, key(account))) || {};
  }
  const { byOrder } = purchaseTerms(ledger);
  return { orders: Object.values(ledger).sort((a, b) => b.createdAt - a.createdAt).map(o => showOrder(o, byOrder)) };
}
