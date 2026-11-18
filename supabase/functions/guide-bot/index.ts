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
const PHOTO = HUB + "ainur.jpg";
const FN_URL = "https://zafgwbfgutlbudqevpal.supabase.co/functions/v1/guide-bot";
const TZ = "Asia/Almaty"; // даты в картотеке считаем по времени Астаны

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function welcomeText(name?: string | null) {
  const hi = name ? `Привет, ${esc(name)}!` : "Привет!";
  return `${hi} Я Айнур, стилист из Астаны ❤️\n\n` +
    `Здесь я собрала всё, что помогает одеваться красиво и без лишних трат: гайды по сезонам, обучение и бесплатные материалы.\n\n` +
    `Загляни в Shopping Guide «Зима 2026/27» — там больше 1500 вещей из любимых магазинов, которые я отобрала сама, плюс особые находки сезона ✨\n\n` +
    `Нажимай «Открыть» и выбирай интересное.`;
}
const OPEN_KB = { inline_keyboard: [[{ text: "Открыть", web_app: { url: HUB } }]] };

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
  return json({
    total: count ?? 0, reach: reach ?? 0, all: all ?? 0, shown: (data ?? []).length,
    rows: (data ?? []).map((u: any) => ({
      tg_id: u.tg_id, username: u.username, name: [u.first_name, u.last_name].filter(Boolean).join(" "),
      created: fmt(u.created_at), started: fmt(u.started_at), seen: fmt(u.last_seen_at),
      src: u.start_param, status: status(u),
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const botToken = Deno.env.get("BOT_TOKEN");
  if (!botToken) return json({ error: "not_configured" }, 503);
  const whSecret = hex(await hmac(enc.encode(botToken), "guide-bot-webhook"));

  // 1) webhook от Telegram
  const hdr = req.headers.get("x-telegram-bot-api-secret-token");
  if (hdr) {
    if (hdr !== whSecret) return json({ error: "forbidden" }, 403);
    try { await handleUpdate(sb, botToken, await req.json()); } catch (e) { console.error("update", e); }
    return new Response("ok");
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
      if (body.menu) out.menu = await tgApi(botToken, "setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть", web_app: { url: HUB } } });
      return json(out);
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
    user = await verifyInitData(String(body.initData ?? ""), botToken);
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
    return json({ ok: true, admin: isAdmin, access });
  }

  if (!isAdmin) return json({ error: "forbidden" }, 403);
  if (body.action === "clients") return await clients(sb, body);
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
