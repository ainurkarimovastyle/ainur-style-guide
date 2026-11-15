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
    const { data, error } = await sb.from("items").select(FIELDS).eq("active", true).order("sort");
    if (error) return json({ error: error.message }, 500);
    return json({ access: true, preview: true, items: data });
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

  if (body.action === "event") {
    const type = String(body.type ?? "").slice(0, 40);
    if (type) await sb.from("events").insert({ tg_id: user.id, type, payload: body.payload ?? null });
    return json({ ok: true });
  }

  await sb.from("events").insert({ tg_id: user.id, type: access ? "open" : "open_locked", payload: null });
  if (!access) return json({ access: false, pay_url: Deno.env.get("PAY_URL") ?? null });

  const { data, error } = await sb.from("items").select(FIELDS).eq("active", true).order("sort");
  if (error) return json({ error: error.message }, 500);
  return json({ access: true, items: data, user: { first_name: user.first_name ?? "" } });
});
