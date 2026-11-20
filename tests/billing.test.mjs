import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { billingAction, billingStatus, entitlement, plans, receiptOrders } from "../server/billing.mjs";
import { openStores } from "../server/sqlite-store.mjs";

const DAY = 86400000;
const clock = Date.UTC(2026, 0, 20, 10);
const env = {
  BILLING_MODE: "live", YOOKASSA_SHOP_ID: "12345", YOOKASSA_SECRET_KEY: "fixture",
  RECEIPT_MODE: "manual_npd", OFFER_URL: "https://example.org/offer/1", PRIVACY_URL: "https://example.org/privacy/1"
};
function fixture(t, settings = env) {
  const db = openStores(":memory:");
  t.after(db.close);
  const user = { id: randomUUID(), role: "user" };
  const payments = new Map(), refunds = new Map(), attempts = new Map(), posted = [];
  const client = { now: clock, loseNext: false };
  async function fetcher(url, options) {
    assert.equal(new URL(url).origin, "https://api.yookassa.ru");
    assert.match(options.headers.Authorization, /^Basic /);
    assert.equal(options.redirect, "error");
    const [, , kind, id] = new URL(url).pathname.split("/");
    if (options.method === "POST") {
      assert.equal(kind, "payments");
      const key = options.headers["Idempotence-Key"], body = JSON.parse(options.body);
      posted.push({ key, body });
      if (attempts.has(key)) assert.deepEqual(body, attempts.get(key).body);
      else {
        const id = randomUUID();
        const payment = { id, status: "pending", paid: false, test: settings.BILLING_MODE === "test",
          amount: body.amount, metadata: body.metadata, recipient: { account_id: settings.YOOKASSA_SHOP_ID },
          confirmation: { confirmation_url: "https://yoomoney.ru/checkout/" + id } };
        attempts.set(key, { id, body });
        payments.set(id, payment);
      }
      if (client.loseNext) {
        client.loseNext = false;
        throw new TypeError("Response lost after the provider recorded the order.");
      }
      return Response.json(payments.get(attempts.get(key).id));
    }
    const object = (kind === "refunds" ? refunds : payments).get(id);
    return object ? Response.json(object) : new Response(null, { status: 404 });
  }
  async function act(op, body = {}, actor = user, overrides = {}) {
    const request = new Request("https://desk.example/api/account", { method: op === "orders" ? "GET" : "POST" });
    return billingAction({ op, body, request, user: actor, store: db.commerce, env: settings,
      origin: "https://desk.example", now: client.now, fetcher, ...overrides });
  }
  const order = (changes = {}) => ({ requestId: randomUUID(), plan: "author", period: "month", email: "writer@example.org", ...changes });
  const notify = (payment, event = "payment.succeeded") => act("webhook", { type: "notification", event, object: payment }, null);
  const succeed = (payment) => Object.assign(payment, {
    status: "succeeded", paid: true, captured_at: new Date(client.now).toISOString()
  });
  async function buy(plan = "author", period = "month") {
    const result = await act("checkout", order({ plan, period }));
    const payment = [...payments.values()].find(o => o.metadata.karetka_order === result.orderId);
    succeed(payment);
    await notify(payment);
    return payment;
  }
  return { client, user, store: db.commerce, payments, refunds, posted, order, act, succeed, notify, buy };
}
const withStatus = (status) => e => e.status === status;

test("checkout is disabled until the merchant and receipt handling are configured", async (t) => {
  assert.deepEqual(plans.map(p => [p.id, p.limit, p.versions, p.month, p.year]), [
    ["free", 1, 0, 0, 0], ["author", 20, 5, 299, 2990], ["studio", 100, 25, 599, 5990]
  ]);
  for (const config of [{}, { ...env, YOOKASSA_SECRET_KEY: "" }, { ...env, RECEIPT_MODE: "provider" }, { ...env, BILLING_MODE: "other" }])
    assert.deepEqual(billingStatus(config), { enabled: false, mode: "off" });
  const f = fixture(t, {});
  await assert.rejects(f.act("checkout", f.order()), withStatus(503));
  assert.equal(f.posted.length, 0);
});

test("hosted checkout fixes the price, records a receipt and retries the same operation under concurrent requests", async t => {
  const f = fixture(t, { ...env, RECEIPT_MODE: "provider", RECEIPT_VAT_CODE: "1" });
  const input = f.order({ period: "year", amount: 1 });
  const [a, b] = await Promise.all([f.act("checkout", input), f.act("checkout", input)]);
  assert.deepEqual(a, b);
  assert.equal(f.payments.size, 1);
  assert.equal(new Set(f.posted.map(item => item.key)).size, 1);
  const p = f.posted[0].body;
  assert.deepEqual(p.amount, { value: "2990.00", currency: "RUB" });
  assert.equal(p.receipt.customer.email, input.email);
  assert.deepEqual(p.receipt.items[0].amount, p.amount);
  assert.equal(p.receipt.items[0].vat_code, 1);
  assert.equal(p.capture, true);
  assert.equal(p.confirmation.return_url, "https://desk.example/?payment=" + input.requestId + "#account");
  assert.equal(Object.hasOwn(p, "save_payment_method"), false);
  assert.equal(JSON.stringify(p.metadata).includes(input.email), false);
  assert.equal(p.payment_method_data, undefined);
  await assert.rejects(f.act("checkout", { ...input, method: "yoo_money" }), withStatus(409));
  await assert.rejects(f.act("checkout", f.order({ method: "arbitrary" })), withStatus(400));
  await f.act("checkout", f.order({ method: "yoo_money" }));
  assert.deepEqual(f.posted.at(-1).body.payment_method_data, { type: "yoo_money" });
  await assert.rejects(f.act("checkout", { ...input, plan: "studio" }), withStatus(409));
  await assert.rejects(f.act("checkout", f.order({ plan: "free" })), withStatus(400));
  await assert.rejects(f.act("checkout", f.order({ period: "toString" })), withStatus(400));
  await assert.rejects(f.act("checkout", f.order({ email: "нет адреса" })), withStatus(400));
  await assert.rejects(f.act("order", { orderId: a.orderId }, { id: randomUUID() }), withStatus(404));
  await assert.rejects(f.act("orders", {}, null), withStatus(401));
});

test("verified payment grants one term through notification and account reconciliation, keeping test payments isolated", async t => {
  for (const mode of ["live", "test"]) {
    const f = fixture(t, { ...env, BILLING_MODE: mode });
    const input = f.order();
    await f.act("checkout", input);
    const p = [...f.payments.values()][0];
    await f.notify({ ...p, paid: true, status: "succeeded" });
    assert.equal((await entitlement(f.store, f.user, clock)).plan, "free");
    f.succeed(p);
    await Promise.all([f.notify(p), f.act("order", { orderId: input.requestId }), f.act("orders")]);
    await f.notify(p);
    const { orders } = await f.act("orders");
    assert.equal(orders.length, 1);
    assert.deepEqual([orders[0].status, orders[0].test, orders[0].until],
      ["succeeded", mode === "test", mode === "live" ? clock + 30 * DAY : null]);
    assert.equal(orders[0].receiptEmail, undefined);
    assert.equal((await entitlement(f.store, f.user, clock)).plan, mode === "live" ? "author" : "free");
    assert.equal((await entitlement(f.store, f.user, clock + 30 * DAY)).plan, "free");
    await assert.rejects(receiptOrders(f.store, f.user, f.user.id), withStatus(403));
    const checks = await receiptOrders(f.store, { role: "owner" }, f.user.id);
    if (mode === "test") assert.equal(checks.length, 0);
    else {
      assert.equal(checks[0].providerId, p.id);
      assert.equal(checks[0].receiptEmail, input.email);
      assert.equal(checks[0].acceptedAt, clock);
      assert.equal(checks[0].offer, env.OFFER_URL);
    }
  }
});

test("unknown results are retried with the recorded order within the provider idempotency window", async t => {
  const f = fixture(t);
  const input = f.order();
  f.client.loseNext = true;
  await assert.rejects(f.act("checkout", input), withStatus(503));
  await f.act("checkout", input);
  assert.equal(f.posted.length, 2);
  assert.equal(f.posted[0].key, f.posted[1].key);
  assert.equal(f.payments.size, 1);
  const stale = f.order();
  f.client.loseNext = true;
  await assert.rejects(f.act("checkout", stale), withStatus(503));
  f.client.now += DAY;
  await assert.rejects(f.act("checkout", stale), withStatus(409));
  assert.equal(f.payments.size, 2);
  const p = [...f.payments.values()][1];
  f.succeed(p);
  await f.notify(p);
  assert.equal((await f.act("order", { orderId: stale.requestId })).order.status, "succeeded");
});

test("a mismatched amount, currency, test mode, shop, order or account cannot activate an entitlement", async t => {
  const f = fixture(t);
  const result = await f.act("checkout", f.order());
  const p = [...f.payments.values()][0];
  f.succeed(p);
  const correct = structuredClone(p);
  for (const change of [
    { amount: { value: "1.00", currency: "RUB" } },
    { amount: { value: "299.00", currency: "USD" } }, { test: true }, { paid: false },
    { recipient: { account_id: "another" } }, { metadata: { ...correct.metadata, karetka_order: randomUUID() } },
    { metadata: { ...correct.metadata, karetka_account: "1".repeat(64) } }
  ]) {
    Object.assign(p, correct, change);
    await assert.rejects(f.act("order", { orderId: result.orderId }), withStatus(502));
    assert.equal((await entitlement(f.store, f.user, clock)).plan, "free");
  }
  Object.assign(p, correct, { status: "canceled", paid: false });
  await f.notify(p, "payment.canceled");
  assert.equal((await f.act("orders")).orders[0].status, "canceled");
});

test("terms of the same tier stack, refunds reconcile once, and paid or owner access survives independent changes", async t => {
  const f = fixture(t);
  const first = await f.buy();
  const second = await f.buy();
  assert.equal((await entitlement(f.store, f.user, clock)).until, clock + 60 * DAY);
  const studio = await f.buy("studio", "year");
  assert.deepEqual(await entitlement(f.store, f.user, clock), { plan: "studio", until: clock + 365 * DAY, bookLimit: 100 });
  async function refund(p, rub) {
    const r = { id: randomUUID(), payment_id: p.id, status: "succeeded", amount: { currency: "RUB", value: rub.toFixed(2) } };
    f.refunds.set(r.id, r);
    await Promise.all([f.notify(r, "refund.succeeded"), f.notify(r, "refund.succeeded")]);
  }
  await refund(second, 99);
  assert.equal((await entitlement(f.store, f.user, clock)).plan, "studio");
  assert.equal((await f.act("order", { orderId: second.metadata.karetka_order })).order.status, "partially_refunded");
  await refund(studio, 5990);
  assert.deepEqual(await entitlement(f.store, f.user, clock), { plan: "author", until: clock + 60 * DAY, bookLimit: 20 });
  await refund(second, 200);
  await f.notify(first);
  assert.equal((await entitlement(f.store, f.user, clock)).until, clock + 30 * DAY);
  assert.deepEqual(await entitlement(f.store, { ...f.user, role: "owner" }, clock + 400 * DAY),
    { plan: "studio", until: null, bookLimit: null });
  assert.equal((await entitlement(f.store, { ...f.user, grant: { plan: "studio", until: clock + 5 * DAY } }, clock)).plan, "studio");
  assert.equal((await entitlement(f.store, { ...f.user, grant: { plan: "studio", until: clock - DAY } }, clock)).plan, "author");
});

test("a server-issued author trial expires after fourteen days and never shortens a paid plan", async t => {
  const f = fixture(t);
  const trial = { ...f.user, trialUntil: clock + 14 * DAY };
  assert.deepEqual(await entitlement(f.store, trial, clock), { plan: "author", until: trial.trialUntil, bookLimit: 20 });
  assert.equal((await entitlement(f.store, trial, trial.trialUntil)).plan, "free");
  const checked = await f.act("checkout", f.order(), trial);
  const purchase = [...f.payments.values()].find(p => p.metadata.karetka_order === checked.orderId);
  await f.notify(f.succeed(purchase));
  assert.equal((await entitlement(f.store, trial, clock)).until, trial.trialUntil + 30 * DAY);
  await f.buy("studio", "month");
  assert.equal((await entitlement(f.store, trial, clock)).plan, "studio");
});
