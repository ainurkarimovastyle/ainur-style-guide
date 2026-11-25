import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

test('Tribute purchase grants access once and a matching refund revokes it', async () => {
  const access = [];
  const messages = [];
  let handler;
  const db = {
    from(table) {
      if (table === 'events') return { insert: async () => ({ error: null }) };
      if (table === 'users') return {
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === 'access') return {
        insert: async (row) => {
          if (access.some((a) => a.source === row.source && a.payment_ref === row.payment_ref)) {
            return { error: { code: '23505' } };
          }
          access.push({ ...row, revoked: false });
          return { error: null };
        },
        update: (values) => {
          const filters = {};
          const chain = {
            eq(key, value) { filters[key] = value; return chain; },
            async select() {
              const rows = access.filter((a) => Object.entries(filters).every(([k, v]) => a[k] === v));
              rows.forEach((a) => Object.assign(a, values));
              return { data: rows.map((_, id) => ({ id })) };
            },
          };
          return chain;
        },
      };
      throw Error(`unexpected table: ${table}`);
    },
  };
  const env = {
    TRIBUTE_API_KEY: 'test-secret', TRIBUTE_PRODUCTS: '123',
    MAIN_BOT_TOKEN: 'main-token', BOT_TOKEN: 'payment-token', ADMIN_IDS: '99',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  };
  const source = readFileSync(new URL('../supabase/functions/tribute-webhook/index.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\s*/m, '');
  vm.runInNewContext(stripTypeScriptTypes(source), {
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } },
    createClient: () => db, crypto: webcrypto, TextEncoder, Response, console, btoa,
    fetch: async (url, options) => {
      messages.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: true }) };
    },
  });
  async function send(name, productId = 123, signature = true) {
    const body = JSON.stringify({ name, payload: {
      product_id: productId, purchase_id: 777, telegram_user_id: 42,
      product_name: 'Shopping Guide', amount: 100000, currency: 'rub',
    } });
    const signed = createHmac('sha256', env.TRIBUTE_API_KEY).update(body).digest('hex');
    return handler(new Request('https://example.com/webhook', {
      method: 'POST', body,
      headers: { 'trbt-signature': signature ? signed : 'invalid' },
    }));
  }
  assert.equal((await send('new_digital_product', 123, false)).status, 401);
  assert.equal(access.length, 0);
  assert.equal((await send('new_digital_product', 999)).status, 200);
  assert.equal(access.length, 0);
  assert.equal((await send('new_digital_product')).status, 200);
  assert.equal(access.length, 1);
  assert.ok(messages.some((m) => m.url.includes('/botpayment-token/sendMessage') && m.body.chat_id === 42
    && m.body.reply_markup.inline_keyboard[0][0].url === 'https://t.me/ainurkarimova_bot?start=guide'));
  assert.equal((await send('new_digital_product')).status, 200);
  assert.equal(access.length, 1);
  assert.equal((await send('digital_product_refunded')).status, 200);
  assert.equal(access[0].revoked, true);
});

