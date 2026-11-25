import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac, webcrypto } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

test('payment bot shows configured Kaspi and Tribute methods, then points paid buyers to the main bot', async () => {
  const messages = [];
  const savedUsers = [];
  let handler;
  let paid = false;
  const env = {
    BOT_TOKEN: 'payment-token', MAIN_BOT_TOKEN: 'main-token', APIPAY_API_KEY: 'api-key', APIPAY_WEBHOOK_SECRET: 'hook-secret',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  };
  const db = {
    from(table) {
      if (table === 'events') return { insert: async () => ({ error: null }) };
      if (table === 'users') return { upsert: async (row) => { savedUsers.push(row); return { error: null }; } };
      if (table === 'access') return {
        select: () => ({ eq() { return this; }, then(resolve) { return Promise.resolve(resolve({ data: paid ? [{ expires_at: null }] : [] })); } }),
      };
      throw Error(`unexpected table: ${table}`);
    },
  };
  const source = readFileSync(new URL('../supabase/functions/guide-bot/index.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\s*/m, '');
  vm.runInNewContext(stripTypeScriptTypes(source), {
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } },
    createClient: () => db, crypto: webcrypto, TextEncoder, Response, console,
    fetch: async (url, options) => {
      if (url.includes('/getMe')) return { json: async () => ({ ok: true, result: { username: 'ainurkarimova_bot' } }) };
      messages.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: true }) };
    },
  });
  const secret = createHmac('sha256', env.BOT_TOKEN).update('guide-bot-webhook').digest('hex');
  async function start() {
    return handler(new Request('https://example.com/guide-bot', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ message: {
        text: '/start guide_winter_2627', chat: { id: 42, type: 'private' },
        from: { id: 42, is_bot: false },
      } }),
    }));
  }
  assert.equal((await start()).status, 200);
  assert.equal(savedUsers[0].tg_id, 42);
  assert.equal(savedUsers[0].started_at, undefined);
  let sent = messages.at(-1);
  assert.ok(sent.url.includes('/botpayment-token/sendMessage'));
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].callback_data, 'apipay_start');
  assert.equal(sent.body.reply_markup.inline_keyboard.length, 2);
  env.TRIBUTE_PRODUCTS = '123';
  assert.equal((await start()).status, 200);
  sent = messages.at(-1);
  assert.equal(sent.body.reply_markup.inline_keyboard[1][0].url, 'https://t.me/tribute/app?startapp=p123');
  paid = true;
  assert.equal((await start()).status, 200);
  sent = messages.at(-1);
  assert.equal(sent.body.reply_markup.inline_keyboard[0][0].url, 'https://t.me/ainurkarimova_bot?start=guide');
  assert.ok(!JSON.stringify(sent.body).includes('apipay_start'));
  assert.ok(!JSON.stringify(sent.body).includes('startapp=p123'));
});

test('main bot sends buyers to the payment bot', async () => {
  const messages = [];
  let handler;
  const env = { BOT_TOKEN: 'payment-token', MAIN_BOT_TOKEN: 'main-token',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };
  const db = { from(table) {
    if (table === 'events') return { insert: async () => ({ error: null }) };
    if (table === 'users') return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      upsert: async () => ({ error: null }),
    };
    if (table === 'access') return { select: () => ({ eq() { return this; }, then(resolve) { return Promise.resolve(resolve({ data: [{ expires_at: null }] })); } }) };
    throw Error(`unexpected table: ${table}`);
  } };
  const source = readFileSync(new URL('../supabase/functions/guide-bot/index.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\s*/m, '');
  vm.runInNewContext(stripTypeScriptTypes(source), {
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } },
    createClient: () => db, crypto: webcrypto, TextEncoder, Response, console,
    fetch: async (url, options) => {
      messages.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: true }) };
    },
  });
  const secret = createHmac('sha256', env.MAIN_BOT_TOKEN).update('guide-bot-webhook').digest('hex');
  const response = await handler(new Request('https://example.com/guide-bot', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ message: { text: '/start', chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Айнур' } } }),
  }));
  assert.equal(response.status, 200);
  assert.ok(messages.some((m) => m.url.includes('/botmain-token/sendPhoto')
    && m.body.reply_markup.inline_keyboard[1][0].url === 'https://t.me/ainurkarimova_pay_bot?start=guide_winter_2627'));
  const direct = await handler(new Request('https://example.com/guide-bot', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify({ message: { text: '/start guide', chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false } } }),
  }));
  assert.equal(direct.status, 200);
  assert.ok(messages.some((m) => m.url.includes('/botmain-token/sendMessage')
    && m.body.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app?.url === 'https://ainurkarimovastyle.github.io/ainur-style-guide/'));
});
