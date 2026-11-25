import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

const load = (path, db, env, fetch) => {
  let handler;
  const source = readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*;\s*/m, '');
  vm.runInNewContext(stripTypeScriptTypes(source), {
    Deno: { env: { get: (key) => env[key] }, serve: (fn) => { handler = fn; } },
    createClient: () => db, crypto: webcrypto, TextEncoder, Response, console, fetch,
  });
  return handler;
};

test('Kaspi bot requests phone and creates one ApiPay invoice with order idempotency', async () => {
  const env = { BOT_TOKEN: 'pay-token', MAIN_BOT_TOKEN: 'main-token', APIPAY_API_KEY: 'api-key',
    APIPAY_WEBHOOK_SECRET: 'hook-secret', SUPABASE_URL: 'https://example.com', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  const orders = [];
  const messages = [];
  const invoices = [];
  const result = (data = null, error = null) => ({ data, error });
  const db = { from(table) {
    if (table === 'events') return { insert: async () => result() };
    if (table === 'users') return { upsert: async () => result() };
    if (table === 'access') return { select: () => ({ eq() { return this; }, then(resolve) { return Promise.resolve(resolve(result([]))); } }) };
    if (table !== 'apipay_orders') throw Error(table);
    return {
      select: () => ({ eq: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({
        maybeSingle: async () => result(orders.find((o) => ['awaiting_phone','creating','processing','pending'].includes(o.status)) ?? null),
      }) }) }) }) }) }),
      insert: async (row) => { orders.push({ ...row }); return result(); },
      update: (values) => ({ eq: (key, value) => ({ eq: (statusKey, statusValue) => {
        const apply = () => {
          const o = orders.find((x) => x[key] === value && x[statusKey] === statusValue);
          if (o) Object.assign(o, values);
          return result(o ? { order_ref: o.order_ref } : null);
        };
        return { select: () => ({ maybeSingle: async () => apply() }), then: (resolve) => Promise.resolve(resolve(apply())) };
      } }) }),
    };
  } };
  const handler = load('../supabase/functions/guide-bot/index.ts', db, env, async (url, options) => {
    if (url.includes('/getMe')) return { json: async () => ({ result: { username: 'ainurkarimova_bot' } }) };
    if (url.includes('api.apipay.kz')) {
      assert.equal(options.headers['X-API-Key'], 'api-key');
      invoices.push(JSON.parse(options.body));
      return { status: 201, json: async () => ({ id: 55, status: 'processing' }) };
    }
    messages.push({ url, body: JSON.parse(options.body) });
    return { json: async () => ({ ok: true }) };
  });
  const secret = createHmac('sha256', env.BOT_TOKEN).update('guide-bot-webhook').digest('hex');
  const send = (update) => handler(new Request('https://example.com/guide-bot', { method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) }));
  const user = { id: 42, is_bot: false };
  await send({ callback_query: { id: 'cb-1', data: 'apipay_start', from: user,
    message: { chat: { id: 42, type: 'private' }, from: { is_bot: true } } } });
  assert.equal(orders[0].status, 'awaiting_phone');
  assert.ok(messages.some((m) => m.body.reply_markup?.keyboard?.[0]?.[0]?.request_contact));
  await send({ message: { chat: { id: 42, type: 'private' }, from: user,
    contact: { user_id: 42, phone_number: '+7 777 123 45 67' } } });
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].phone_number, '87771234567');
  assert.equal(invoices[0].amount, 14000);
  assert.equal(invoices[0].external_order_id, orders[0].order_ref);
  assert.equal(invoices[0].external_order_id_idempotency, orders[0].order_ref);
  assert.equal(orders[0].invoice_id, 55);
  await send({ message: { chat: { id: 42, type: 'private' }, from: user,
    contact: { user_id: 42, phone_number: '+7 777 123 45 67' } } });
  assert.equal(invoices.length, 1);
});

test('ApiPay accepts only signed matching payment and revokes after full refund', async () => {
  const ref = 'b3a8d123-3434-4ed2-b8f7-16f8309a1234';
  const env = { APIPAY_WEBHOOK_SECRET: 'hook-secret', BOT_TOKEN: 'pay-token', MAIN_BOT_TOKEN: 'main-token',
    APIPAY_SANDBOX_MODE: 'false', SUPABASE_URL: 'https://example.com', SUPABASE_SERVICE_ROLE_KEY: 'key' };
  const order = { tg_id: 42, amount_kzt: 14000, invoice_id: 55, status: 'processing' };
  const calls = [];
  const notifications = [];
  const db = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: order }) }) }) }),
    rpc: async (_name, args) => {
      calls.push(args);
      if (args.p_event === 'refunded') { order.status = 'refunded'; return { data: 'revoked' }; }
      if (order.status === 'refunded') return { data: 'ignored' };
      if (args.p_status === 'paid') { order.status = 'paid'; return { data: calls.filter((c) => c.p_status === 'paid').length === 1 ? 'granted' : 'ok' }; }
      return { data: 'updated' };
    },
  };
  const handler = load('../supabase/functions/apipay-webhook/index.ts', db, env, async (url, options) => {
    notifications.push({ url, body: JSON.parse(options.body) }); return { json: async () => ({ ok: true }) };
  });
  const base = { event: 'invoice.status_changed', is_sandbox: false,
    invoice: { id: 55, external_order_id: ref, amount: '14000.00', status: 'paid', is_sandbox: false } };
  const send = (event, valid = true) => {
    const body = JSON.stringify(event);
    const sig = createHmac('sha256', env.APIPAY_WEBHOOK_SECRET).update(body).digest('hex');
    return handler(new Request('https://example.com/apipay-webhook', { method: 'POST', body,
      headers: { 'x-webhook-signature': 'sha256=' + (valid ? sig : '0'.repeat(64)) } }));
  };
  assert.equal((await send(base, false)).status, 401);
  assert.equal(calls.length, 0);
  await send({ ...base, is_sandbox: true, invoice: { ...base.invoice, is_sandbox: true } });
  await send({ ...base, invoice: { ...base.invoice, amount: '13000.00' } });
  assert.equal(calls.length, 0);
  assert.equal((await send(base)).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_is_sandbox, false);
  assert.ok(notifications.some((n) => n.url.includes('/botpay-token/sendMessage') && n.body.chat_id === 42));
  await send(base);
  assert.equal(calls.length, 2);
  await send({ event: 'invoice.refunded', is_sandbox: false,
    refund: { status: 'completed' }, invoice: { ...base.invoice, is_fully_refunded: false } });
  assert.equal(calls.length, 2);
  await send({ event: 'invoice.refunded', is_sandbox: false,
    refund: { status: 'completed' }, invoice: { ...base.invoice, is_fully_refunded: true } });
  assert.equal(order.status, 'refunded');
  await send(base);
  assert.equal(order.status, 'refunded');
});
