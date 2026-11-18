// API гайда для Telegram Mini App.
// POST { initData, action: "items" | "event", type?, payload? }
//  - проверяет подпись Telegram (initData) ключом бота BOT_TOKEN;
//  - записывает пользователя и проверяет оплаченный доступ;
//  - отдаёт позиции гайда и пишет события для статистики.
// Для просмотра без Telegram (только для команды): { preview: "<preview_token>" }.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

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
  const sig = hex(await hmac(secret, check));
  if (sig !== hash) return null;
  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > 7 * 24 * 3600) return null;
  try { return JSON.parse(params.get("user") ?? "null"); } catch { return null; }
}

const FIELDS =
  "id,category,subcategory,store,url,name,color,color_family,price,old_price,composition,materials,image,base,trend,body_types,comment,promo_label,in_stock,sort";

// PostgREST жёстко ограничивает один запрос db-max-rows (обычно 1000) строками —
// в гайде больше позиций, поэтому собираем результат постранично.
async function allItems(sb: any) {
  const page = 1000;
  const out: any[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from("items").select(FIELDS).eq("active", true).order("sort").range(from, from + page - 1);
    if (error) return { data: null, error };
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < page) break;
  }
  // плашка «Находка»: хранится отдельно от items, поэтому переживает пересборку каталога
  const { data: fl } = await sb.from("finds").select("item_id").limit(5000);
  const fs = new Set((fl ?? []).map((m: any) => m.item_id));
  for (const i of out) if (fs.has(i.id)) i.find = true;
  return { data: out, error: null };
}

async function setMark(sb: any, body: any) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "bad_id" }, 400);
  const q = body.on ? sb.from("delete_marks").upsert({ item_id: id }) : sb.from("delete_marks").delete().eq("item_id", id);
  const { error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function setFind(sb: any, body: any) {
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "bad_id" }, 400);
  const q = body.on ? sb.from("finds").upsert({ item_id: id }) : sb.from("finds").delete().eq("item_id", id);
  const { error } = await q;
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}

async function flagsPayload(sb: any) {
  const { data: m } = await sb.from("delete_marks").select("item_id").limit(5000);
  const { data: f } = await sb.from("finds").select("item_id").limit(5000);
  return json({ del: (m ?? []).map((x: any) => x.item_id), find: (f ?? []).map((x: any) => x.item_id) });
}

async function markedText(sb: any) {
  const { data: marks } = await sb.from("delete_marks").select("item_id").limit(5000);
  const ids = (marks ?? []).map((m: any) => m.item_id);
  if (!ids.length) return { text: "", count: 0 };
  const { data } = await sb.from("items").select("id,store,name,color,url").in("id", ids).order("store").order("id");
  const rows = data ?? [];
  const text = rows.map((x: any) => [x.store, x.name, x.color, x.url].filter(Boolean).join(" · ")).join("\n") + "\n";
  return { text, count: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { /* пусто */ }

  // режим предпросмотра для команды
  if (body.preview) {
    const { data: ok } = await sb.rpc("check_preview_token", { t: String(body.preview) });
    if (ok !== true) return json({ error: "forbidden" }, 403);
    if (body.action === "event") return json({ ok: true });
    // пометка карточек на удаление — только для команды, на этапе разработки
    if (body.action === "mark") return await setMark(sb, body);
    if (body.action === "find") return await setFind(sb, body);
    if (body.action === "flags") return await flagsPayload(sb);
    const { data, error } = await allItems(sb);
    if (error) return json({ error: error.message }, 500);
    const { data: marks } = await sb.from("delete_marks").select("item_id").limit(5000);
    const del = new Set((marks ?? []).map((m: any) => m.item_id));
    return json({ access: true, preview: true, items: data.map((i: any) => (del.has(i.id) ? { ...i, del: true } : i)) });
  }

  const botToken = Deno.env.get("BOT_TOKEN");
  if (!botToken) return json({ error: "not_configured" }, 503);
  const user = await verifyInitData(String(body.initData ?? ""), botToken);
  if (!user?.id) return json({ error: "unauthorized" }, 401);

  await sb.from("users").upsert({
    tg_id: user.id,
    username: user.username ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    language_code: user.language_code ?? null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: "tg_id" });

  const admins = (Deno.env.get("ADMIN_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let access = admins.includes(String(user.id));
  if (!access) {
    const { data: rows } = await sb.from("access").select("expires_at,revoked").eq("tg_id", user.id).eq("revoked", false);
    access = (rows ?? []).some((r) => !r.expires_at || new Date(r.expires_at) > new Date());
  }

  const isAdmin = admins.includes(String(user.id));
  if (isAdmin && body.action === "mark") return await setMark(sb, body);
  if (isAdmin && body.action === "find") return await setFind(sb, body);
  if (isAdmin && body.action === "flags") return await flagsPayload(sb);
  if (isAdmin && body.action === "export_marks") {
    const { text, count } = await markedText(sb);
    if (!count) return json({ error: "empty" }, 400);
    const fd = new FormData();
    fd.append("chat_id", String(user.id));
    fd.append("caption", `К удалению: ${count}`);
    fd.append("document", new Blob(["\ufeff" + text], { type: "text/plain" }), `к-удалению-${new Date().toISOString().slice(0, 10)}.txt`);
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: fd });
    if (!r.ok) return json({ error: "send_failed" }, 502);
    return json({ ok: true, count });
  }

  if (body.action === "event") {
    const type = String(body.type ?? "").slice(0, 40);
    if (type) await sb.from("events").insert({ tg_id: user.id, type, payload: body.payload ?? null });
    return json({ ok: true });
  }

  await sb.from("events").insert({ tg_id: user.id, type: access ? "open" : "open_locked", payload: null });
  if (!access) return json({ access: false, pay_url: Deno.env.get("PAY_URL") ?? null });

  const { data, error } = await allItems(sb);
  if (error) return json({ error: error.message }, 500);
  if (isAdmin) {
    const { data: marks } = await sb.from("delete_marks").select("item_id").limit(5000);
    const del = new Set((marks ?? []).map((m: any) => m.item_id));
    return json({ access: true, dev: true, items: data.map((i: any) => (del.has(i.id) ? { ...i, del: true } : i)), user: { first_name: user.first_name ?? "" } });
  }
  return json({ access: true, items: data, user: { first_name: user.first_name ?? "" } });
});
