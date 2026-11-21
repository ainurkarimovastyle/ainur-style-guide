// Бот и картотека клиентов гайда.
//  1) Webhook Telegram (заголовок X-Telegram-Bot-Api-Secret-Token): /start, любые сообщения, блокировка бота.
//     Каждый, кто написал боту, попадает в таблицу users (картотека) и получает приветствие с фото.
//  2) API для мини-аппа (POST { initData | preview, action }):
//     me — регистрирует открывшего мини-апп, отдаёт {admin, access};
//     clients / export_clients — картотека с фильтром по датам (только админы).
//  3) Служебные действия (заголовок x-ingest-token): info, setup, send_welcome.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info, x-ingest-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const HUB = "https://ainurkarimovastyle.github.io/ainur-style-guide/hub/";
const PHOTO = HUB + "welcome.jpg";
const HUB_V = HUB + "?v=20261118b"; // номер версии сбивает кеш Telegram при обновлении хаба
const FN_URL = "https://zafgwbfgutlbudqevpal.supabase.co/functions/v1/guide-bot";
const TZ = "Asia/Almaty"; // даты в картотеке считаем по времени Астаны

// темы, на которые можно «подписаться колокольчиком» (ключ → название для админов)
const TOPICS: Record<string, string> = {
  newyear: "Shopping Guide «Новый год 2027»",
  intensive: "Интенсив-группа по стилю",
  findstyle: "Как найти свой стиль",
  colortype: "Цветотип и тип фигуры",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function welcomeText(name?: string | null) {
  const hi = name ? `Привет, ${esc(name)}!` : "Привет!";
  return `${hi} Я Айнур, стилист из Астаны ❤️\n\n` +
    `Здесь я собрала всё, что помогает одеваться красиво и без лишних трат: гайды по сезонам, обучение и бесплатные материалы.\n\n` +
    `Загляни в Shopping Guide «Зима 2026/27» — там больше 1500 вещей из любимых магазинов, которые я отобрала сама, плюс особые находки сезона ✨\n\n` +
    `Нажимай «Открыть» и выбирай интересное.`;
}
const OPEN_KB = { inline_keyboard: [[{ text: "Открыть", web_app: { url: HUB_V } }]] };

const enc = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function verifyInitData(initData: string, botToken: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (hex(await hmac(secret, check)) !== hash) return null;
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 7 * 24 * 3600) return null;
  try { return JSON.parse(params.get("user") ?? "null"); } catch { return null; }
}

async function tgApi(token: string, method: string, body: unknown) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}

async function sendWelcome(sb: any, token: string, chatId: number, name?: string | null) {
  let r = await tgApi(token, "sendPhoto", {
    chat_id: chatId, photo: PHOTO, caption: welcomeText(name), parse_mode: "HTML", reply_markup: OPEN_KB,
  });
  if (!r.ok && r.error_code !== 403) { // фото не дошло — отправим хотя бы текст
    r = await tgApi(token, "sendMessage", { chat_id: chatId, text: welcomeText(name), parse_mode: "HTML", reply_markup: OPEN_KB });
  }
  if (!r.ok && r.error_code === 403) await sb.from("users").update({ blocked_at: new Date().toISOString() }).eq("tg_id", chatId);
  return r;
}

// ───────── платёжный бот ─────────
function tributeGuideLink() {
  const id = (Deno.env.get("TRIBUTE_PRODUCTS") ?? "").split(",")[0]?.trim().replace(/^p/i, "");
  return id && /^\d+$/.test(id) ? `https://t.me/tribute/app?startapp=p${id}` : null;
}
async function legacyUpdate(sb: any, legacy: string, main: string, upd: any) {
  const msg = upd.message;
  if (!msg || msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
  const newName = (await tgApi(main, "getMe", {})).result?.username ?? "ainurkarimova_bot";
  const { data: rows, error } = await sb.from("access").select("expires_at").eq("tg_id", msg.from.id).eq("revoked", false);
  if (error) {
    await tgApi(legacy, "sendMessage", { chat_id: msg.chat.id, text: "Не получилось проверить доступ. Пожалуйста, попробуйте позже." });
    return;
  }
  const paid = (rows ?? []).some((r: any) => !r.expires_at || new Date(r.expires_at) > new Date());
  const product = tributeGuideLink();
  const mainUrl = `https://t.me/${newName}?start=guide`;
  const buttons: any[] = [];
  if (!paid && product) buttons.push([{ text: "Оплатить через Tribute", url: product }]);
  if (mainUrl) buttons.push([{ text: paid ? "Открыть гид" : "Открыть витрину", url: mainUrl }]);
  const text = paid
    ? "Оплата найдена ✅ Доступ к Shopping Guide уже открыт. Нажмите «Открыть гид»."
    : product
    ? "Shopping Guide · Зима 26/27\n\nВыберите «Оплатить через Tribute». После покупки доступ откроется на этом аккаунте Telegram."
    : "Shopping Guide · Зима 26/27\n\nОплата через Tribute пока подключается. Загляните сюда позже.";
  await tgApi(legacy, "sendMessage", {
    chat_id: msg.chat.id, text,
    ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  await sb.from("events").insert({ tg_id: msg.from.id, type: "payment_bot_message", payload: null });
}

// ───────── webhook ─────────
async function handleUpdate(sb: any, token: string, upd: any) {
  const nowIso = new Date().toISOString();
  const mcm = upd.my_chat_member;
  if (mcm && mcm.chat?.type === "private") {
    const st = mcm.new_chat_member?.status;
    if (st === "kicked" || st === "left") await sb.from("users").update({ blocked_at: nowIso }).eq("tg_id", mcm.chat.id);
    else if (st === "member") await sb.from("users").update({ blocked_at: null }).eq("tg_id", mcm.chat.id);
    return;
  }
  const msg = upd.message;
  if (!msg || msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
  const f = msg.from;
  const text: string = msg.text ?? "";
  const isStart = /^\/start(\s|$)/.test(text);
  const payload = isStart ? (text.split(/\s+/)[1] ?? null) : null;

  const { data: ex } = await sb.from("users").select("started_at,start_param").eq("tg_id", f.id).maybeSingle();
  const row: any = {
    tg_id: f.id, username: f.username ?? null, first_name: f.first_name ?? null, last_name: f.last_name ?? null,
    language_code: f.language_code ?? null, is_premium: f.is_premium ?? null,
    allows_write: true, blocked_at: null, last_seen_at: nowIso,
  };
  if (!ex?.started_at) row.started_at = nowIso;
  if (payload && !ex?.start_param) row.start_param = payload.slice(0, 64);
  await sb.from("users").upsert(row, { onConflict: "tg_id" });
  await sb.from("events").insert({ tg_id: f.id, type: isStart ? "bot_start" : "bot_message", payload: payload ? { start: payload } : null });

  if (isStart) {
    await sendWelcome(sb, token, msg.chat.id, f.first_name);
  } else {
    const r = await tgApi(token, "sendMessage", { chat_id: msg.chat.id, text: "Нажимай кнопку ниже, чтобы открыть гайды и обучение.", reply_markup: OPEN_KB });
    if (!r.ok && r.error_code === 403) await sb.from("users").update({ blocked_at: nowIso }).eq("tg_id", f.id);
  }
}

// ───────── картотека ─────────
const DATE_FIELDS = ["created_at", "started_at", "last_seen_at"];
function dayStart(d: string) { return new Date(`${d}T00:00:00+05:00`).toISOString(); }
function dayAfter(d: string) { return new Date(new Date(`${d}T00:00:00+05:00`).getTime() + 86400000).toISOString(); }
const fmt = (iso?: string | null) => iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

function clientsQuery(sb: any, body: any, head = false) {
  const field = DATE_FIELDS.includes(body.field) ? body.field : "created_at";
  let q = sb.from("users").select("tg_id,username,first_name,last_name,language_code,created_at,started_at,last_seen_at,start_param,allows_write,blocked_at", { count: "exact", head });
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.from ?? "")) q = q.gte(field, dayStart(body.from));
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.to ?? "")) q = q.lt(field, dayAfter(body.to));
  if (body.reach) q = q.or("started_at.not.is.null,allows_write.eq.true").is("blocked_at", null);
  return { q, field };
}
const status = (u: any) => u.blocked_at ? "заблокировал бота" : (u.started_at || u.allows_write) ? "можно писать" : "только открыл приложение";

async function clients(sb: any, body: any) {
  const { q, field } = clientsQuery(sb, body);
  const asc = body.dir === "asc";
  const { data, count, error } = await q.order(field, { ascending: asc, nullsFirst: false }).limit(500);
  if (error) return json({ error: error.message }, 500);
  const { count: reach } = await clientsQuery(sb, { ...body, reach: true }, true).q;
  const { count: all } = await clientsQuery(sb, {}, true).q;
  const paid = new Map<number, any>();
  const ids = (data ?? []).map((u: any) => u.tg_id);
  if (ids.length) {
    const { data: acc } = await sb.from("access").select("tg_id,source,granted_at,expires_at").in("tg_id", ids).eq("revoked", false);
    for (const a of acc ?? []) if (!a.expires_at || new Date(a.expires_at) > new Date()) paid.set(a.tg_id, a);
  }
  return json({
    total: count ?? 0, reach: reach ?? 0, all: all ?? 0, shown: (data ?? []).length,
    rows: (data ?? []).map((u: any) => ({
      tg_id: u.tg_id, username: u.username, name: [u.first_name, u.last_name].filter(Boolean).join(" "),
      created: fmt(u.created_at), started: fmt(u.started_at), seen: fmt(u.last_seen_at),
      src: u.start_param, status: status(u),
      paid: paid.has(u.tg_id) ? { source: paid.get(u.tg_id).source, at: fmt(paid.get(u.tg_id).granted_at) } : null,
    })),
  });
}

async function csvOf(sb: any, body: any) {
  const { q, field } = clientsQuery(sb, body);
  const { data, error } = await q.order(field, { ascending: body.dir === "asc", nullsFirst: false }).limit(20000);
  if (error) return { error: error.message };
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Telegram ID", "Username", "Имя", "Фамилия", "Язык", "Первый контакт", "Запустил бота", "Последний визит", "Источник", "Статус"];
  const lines = (data ?? []).map((u: any) => [u.tg_id, u.username ? "@" + u.username : "", u.first_name, u.last_name, u.language_code, fmt(u.created_at), fmt(u.started_at), fmt(u.last_seen_at), u.start_param, status(u)].map(cell).join(";"));
  return { csv: "﻿" + [head.map(cell).join(";"), ...lines].join("\r\n") + "\r\n", count: lines.length };
}

async function waitUsers(sb: any, ids: number[]) {
  const m = new Map<number, any>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("users").select("tg_id,username,first_name,last_name,started_at,allows_write,blocked_at").in("tg_id", ids.slice(i, i + 150));
    for (const u of data ?? []) m.set(u.tg_id, u);
  }
  return m;
}
const canWrite = (u: any) => !!u && !u.blocked_at && !!(u.started_at || u.allows_write);

async function waitlistRows(sb: any, body: any) {
  let q = sb.from("waitlist").select("tg_id,topic,created_at");
  if (body.topic) q = q.eq("topic", body.topic);
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.from ?? "")) q = q.gte("created_at", dayStart(body.from));
  if (/^\d{4}-\d{2}-\d{2}$/.test(body.to ?? "")) q = q.lt("created_at", dayAfter(body.to));
  const { data, error } = await q.order("created_at", { ascending: body.dir === "asc" }).limit(20000);
  if (error) return { error: error.message };
  const users = await waitUsers(sb, [...new Set((data ?? []).map((x: any) => x.tg_id))] as number[]);
  let rows = (data ?? []).map((w: any) => ({ ...w, u: users.get(w.tg_id) }));
  if (body.reach) rows = rows.filter((r: any) => canWrite(r.u));
  return { rows };
}

async function waitlistApi(sb: any, body: any) {
  if (!body.topic) { // сводка по темам
    const all: any = await waitlistRows(sb, { from: body.from, to: body.to });
    if (all.error) return json({ error: all.error }, 500);
    return json({
      topics: Object.entries(TOPICS).map(([k, label]) => {
        const r = all.rows.filter((x: any) => x.topic === k);
        return { topic: k, label, count: r.length, reach: r.filter((x: any) => canWrite(x.u)).length };
      }),
    });
  }
  const r: any = await waitlistRows(sb, body);
  if (r.error) return json({ error: r.error }, 500);
  return json({
    topic: body.topic, label: TOPICS[body.topic] ?? body.topic, total: r.rows.length, reach: r.rows.filter((x: any) => canWrite(x.u)).length,
    rows: r.rows.slice(0, 500).map((x: any) => ({
      tg_id: x.tg_id, username: x.u?.username ?? null, name: [x.u?.first_name, x.u?.last_name].filter(Boolean).join(" "),
      when: fmt(x.created_at), status: x.u?.blocked_at ? "заблокировал бота" : canWrite(x.u) ? "можно писать" : "только открыл приложение",
    })),
  });
}

async function waitlistCsv(sb: any, body: any) {
  const r: any = await waitlistRows(sb, body);
  if (r.error) return { error: r.error };
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Telegram ID", "Username", "Имя", "Фамилия", "Тема", "Нажал колокольчик", "Статус"];
  const lines = r.rows.map((x: any) => [x.tg_id, x.u?.username ? "@" + x.u.username : "", x.u?.first_name, x.u?.last_name, TOPICS[x.topic] ?? x.topic, fmt(x.created_at), x.u?.blocked_at ? "заблокировал бота" : canWrite(x.u) ? "можно писать" : "только открыл приложение"].map(cell).join(";"));
  return { csv: "\ufeff" + [head.map(cell).join(";"), ...lines].join("\r\n") + "\r\n", count: lines.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // основной бот (витрина) — MAIN_BOT_TOKEN; старый @ainurkarimova_pay_bot — BOT_TOKEN (на время переезда)
  const legacyToken = Deno.env.get("BOT_TOKEN") ?? null;
  const botToken = Deno.env.get("MAIN_BOT_TOKEN") ?? legacyToken;
  if (!botToken) return json({ error: "not_configured" }, 503);
  const whSecret = hex(await hmac(enc.encode(botToken), "guide-bot-webhook"));
  const legacyOn = !!legacyToken && legacyToken !== botToken;
  const whLegacy = legacyOn ? hex(await hmac(enc.encode(legacyToken!), "guide-bot-webhook")) : null;

  // 1) webhook от Telegram
  const hdr = req.headers.get("x-telegram-bot-api-secret-token");
  if (hdr) {
    if (hdr === whSecret) {
      try { await handleUpdate(sb, botToken, await req.json()); } catch (e) { console.error("update", e); }
      return new Response("ok");
    }
    if (whLegacy && hdr === whLegacy) { // старый бот: отправляем в новый
      try { await legacyUpdate(sb, legacyToken!, botToken, await req.json()); } catch (e) { console.error("legacy", e); }
      return new Response("ok");
    }
    return json({ error: "forbidden" }, 403);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* пусто */ }

  // 2) служебные действия
  const ing = req.headers.get("x-ingest-token");
  if (ing) {
    const { data: ok } = await sb.rpc("check_ingest_token", { t: ing });
    if (ok !== true) return json({ error: "forbidden" }, 403);
    if (body.action === "info") {
      return json({
        me: (await tgApi(botToken, "getMe", {})).result?.username,
        webhook: (await tgApi(botToken, "getWebhookInfo", {})).result,
        menu: (await tgApi(botToken, "getChatMenuButton", {})).result,
      });
    }
    if (body.action === "setup") {
      const out: any = {};
      if (body.webhook) out.webhook = await tgApi(botToken, "setWebhook", { url: FN_URL, secret_token: whSecret, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false });
      if (body.commands) out.commands = await tgApi(botToken, "setMyCommands", { commands: [{ command: "start", description: "Открыть гайды и обучение" }] });
      if (body.menu) out.menu = await tgApi(botToken, "setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: HUB_V } } });
      return json(out);
    }
    if (body.action === "legacy_info" && legacyOn) {
      return json({
        me: (await tgApi(legacyToken!, "getMe", {})).result?.username,
        webhook: (await tgApi(legacyToken!, "getWebhookInfo", {})).result,
      });
    }
    if (body.action === "legacy_webhook" && legacyOn) { // старый бот продолжает слать апдейты сюда, но со своим секретом
      return json(await tgApi(legacyToken!, "setWebhook", { url: FN_URL, secret_token: whLegacy, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false }));
    }
    if (body.action === "send_welcome") {
      const id = Number(body.tg_id);
      if (!Number.isInteger(id)) return json({ error: "bad_id" }, 400);
      const { data: u } = await sb.from("users").select("first_name").eq("tg_id", id).maybeSingle();
      return json(await sendWelcome(sb, botToken, id, u?.first_name));
    }
    return json({ error: "unknown" }, 400);
  }

  // 3) API мини-аппа
  const admins = (Deno.env.get("ADMIN_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let user: any = null, isAdmin = false;
  if (body.preview) {
    const { data: ok } = await sb.rpc("check_preview_token", { t: String(body.preview) });
    if (ok !== true) return json({ error: "forbidden" }, 403);
    isAdmin = true;
  } else {
    user = await verifyInitData(String(body.initData ?? ""), botToken)
      ?? (legacyOn ? await verifyInitData(String(body.initData ?? ""), legacyToken!) : null);
    if (!user?.id) return json({ error: "unauthorized" }, 401);
    isAdmin = admins.includes(String(user.id));
  }

  if (body.action === "me") {
    if (!user) return json({ ok: true, admin: true, access: true });
    const row: any = {
      tg_id: user.id, username: user.username ?? null, first_name: user.first_name ?? null, last_name: user.last_name ?? null,
      language_code: user.language_code ?? null, last_seen_at: new Date().toISOString(),
    };
    if (user.is_premium !== undefined) row.is_premium = !!user.is_premium;
    if (user.allows_write_to_pm) row.allows_write = true;
    await sb.from("users").upsert(row, { onConflict: "tg_id" });
    await sb.from("events").insert({ tg_id: user.id, type: "hub_open", payload: null });
    let access = isAdmin;
    if (!access) {
      const { data: rows } = await sb.from("access").select("expires_at,revoked").eq("tg_id", user.id).eq("revoked", false);
      access = (rows ?? []).some((r: any) => !r.expires_at || new Date(r.expires_at) > new Date());
    }
    const { data: sub } = await sb.from("waitlist").select("topic").eq("tg_id", user.id);
    return json({ ok: true, admin: isAdmin, access, subs: (sub ?? []).map((x: any) => x.topic) });
  }

  if (body.action === "subscribe") { // колокольчик: записаться / отписаться от темы
    if (!user) return json({ error: "no_user" }, 400);
    const topic = String(body.topic ?? "");
    if (!TOPICS[topic]) return json({ error: "bad_topic" }, 400);
    if (body.on === false) {
      await sb.from("waitlist").delete().eq("tg_id", user.id).eq("topic", topic);
    } else {
      await sb.from("users").upsert({
        tg_id: user.id, username: user.username ?? null, first_name: user.first_name ?? null, last_name: user.last_name ?? null,
        language_code: user.language_code ?? null, last_seen_at: new Date().toISOString(),
        ...(body.write || user.allows_write_to_pm ? { allows_write: true } : {}),
      }, { onConflict: "tg_id" });
      await sb.from("waitlist").upsert({ tg_id: user.id, topic }, { onConflict: "tg_id,topic", ignoreDuplicates: true });
      await sb.from("events").insert({ tg_id: user.id, type: "bell", payload: { topic } });
    }
    return json({ ok: true });
  }

  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (body.action === "clients") return await clients(sb, body);
  if (body.action === "waitlist") return await waitlistApi(sb, body);
  if (body.action === "export_waitlist") {
    const r: any = await waitlistCsv(sb, body);
    if (r.error) return json({ error: r.error }, 500);
    if (!user) return json({ ok: true, csv: r.csv, count: r.count });
    const fd = new FormData();
    fd.append("chat_id", String(user.id));
    fd.append("caption", `${TOPICS[body.topic] ?? "Все темы"}: ${r.count}`);
    fd.append("document", new Blob([r.csv], { type: "text/csv" }), `колокольчик-${body.topic ?? "все"}-${new Date().toISOString().slice(0, 10)}.csv`);
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: fd });
    if (!resp.ok) return json({ error: "send_failed" }, 502);
    return json({ ok: true, count: r.count });
  }
  if (body.action === "export_clients") {
    const r: any = await csvOf(sb, body);
    if (r.error) return json({ error: r.error }, 500);
    if (!user) return json({ ok: true, csv: r.csv, count: r.count });
    const fd = new FormData();
    fd.append("chat_id", String(user.id));
    fd.append("caption", `Клиенты бота: ${r.count}`);
    fd.append("document", new Blob([r.csv], { type: "text/csv" }), `клиенты-${new Date().toISOString().slice(0, 10)}.csv`);
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: fd });
    if (!resp.ok) return json({ error: "send_failed" }, 502);
    return json({ ok: true, count: r.count });
  }
  return json({ error: "unknown" }, 400);
});
