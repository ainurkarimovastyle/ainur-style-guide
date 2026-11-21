// Вебхук Tribute: оплата гайда для покупателей из РФ/Беларуси.
//  - Tribute шлёт POST с телом JSON и заголовком trbt-signature = HMAC-SHA256(тело, API-ключ Tribute).
//  - new_digital_product → запись в access (source=tribute, payment_ref=purchase_id) + сообщение покупателю и админам.
//  - digital_product_refunded → доступ по этой покупке отзывается.
//  Повтор одного и того же уведомления доступ второй раз не выдаёт (уникальный индекс source+payment_ref).
// Секреты Supabase: TRIBUTE_API_KEY, TRIBUTE_PRODUCTS (id продуктов гайда через запятую), BOT_TOKEN, MAIN_BOT_TOKEN, ADMIN_IDS.
// Деплоить с verify_jwt = false: Tribute не шлёт JWT Supabase, защита — подпись.
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAIN_BOT_URL = "https://t.me/ainurkarimova_bot?start=guide";
const enc = new TextEncoder();

async function hmacSha256(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
function sameStr(a: string, b: string) { // сравнение без утечки по времени
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function signatureOk(raw: string, sig: string, key: string) {
  const mac = await hmacSha256(key, raw);
  const s = sig.trim().replace(/^sha256=/i, "");
  // в документации Tribute не указано, hex или base64 — принимаем оба
  return sameStr(s.toLowerCase(), hex(mac)) || sameStr(s, b64(mac));
}

async function tg(token: string, method: string, body: unknown) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (amount: unknown, cur: unknown) =>
  typeof amount === "number" ? `${(amount / 100).toLocaleString("ru-RU")} ${String(cur ?? "").toUpperCase()}` : "";

async function notifyAdmins(token: string, text: string) {
  const admins = (Deno.env.get("ADMIN_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of admins) await tg(token, "sendMessage", { chat_id: Number(id), text, parse_mode: "HTML" });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const key = Deno.env.get("TRIBUTE_API_KEY");
  const mainToken = Deno.env.get("MAIN_BOT_TOKEN");
  const paymentToken = Deno.env.get("BOT_TOKEN");
  if (!key || !mainToken || !paymentToken) return new Response("not_configured", { status: 503 });

  const raw = await req.text();
  const sig = req.headers.get("trbt-signature") ?? "";
  if (!sig || !(await signatureOk(raw, sig, key))) return new Response("forbidden", { status: 401 });

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return new Response("bad_json", { status: 400 }); }
  const name = String(ev?.name ?? "");
  const p = ev?.payload ?? {};
  const tgId = Number(p.telegram_user_id);
  const ref = p.purchase_id != null ? String(p.purchase_id) : null;
  const productId = String(p.product_id ?? "");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  await sb.from("events").insert({ tg_id: Number.isSafeInteger(tgId) ? tgId : null, type: "tribute_" + (name || "unknown"), payload: ev });

  const guideProducts = (Deno.env.get("TRIBUTE_PRODUCTS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!guideProducts.includes(productId)) return new Response("ok"); // чужой продукт или другое событие — только лог
  if (!Number.isSafeInteger(tgId) || tgId <= 0 || !ref) return new Response("ok");

  if (name === "new_digital_product") {
    // покупатель мог не открывать нашего бота — создаём строку в картотеке, ничего не перезаписывая
    await sb.from("users").upsert(
      { tg_id: tgId, username: p.telegram_username ?? null },
      { onConflict: "tg_id", ignoreDuplicates: true },
    );
    const { error } = await sb.from("access").insert({
      tg_id: tgId, source: "tribute", payment_ref: ref,
      amount: typeof p.amount === "number" ? p.amount : null, currency: p.currency ?? null, expires_at: null,
    });
    if (error) {
      if (error.code === "23505") return new Response("ok"); // эта покупка уже обработана
      console.error("access insert", error);
      return new Response("db_error", { status: 500 }); // Tribute повторит позже
    }
    let r = await tg(paymentToken, "sendMessage", {
      chat_id: tgId,
      text: "Оплата прошла, доступ к Shopping Guide открыт ❤️\n\nНажимай «Открыть гид» — он откроется в основном боте.",
      reply_markup: { inline_keyboard: [[{ text: "Открыть гид", url: MAIN_BOT_URL }]] },
    });
    if (!r.ok) r = await tg(mainToken, "sendMessage", {
      chat_id: tgId,
      text: "Оплата прошла, доступ к Shopping Guide открыт ❤️ Нажимай «Открыть гид».",
      reply_markup: { inline_keyboard: [[{ text: "Открыть гид", url: MAIN_BOT_URL }]] },
    });
    if (!r.ok && r.error_code === 403) await sb.from("users").update({ blocked_at: new Date().toISOString() }).eq("tg_id", tgId);
    await notifyAdmins(mainToken,
      `💳 Оплата Tribute: ${esc(String(p.product_name ?? "гайд"))} ${esc(money(p.amount, p.currency))}\n` +
      `${p.telegram_username ? "@" + esc(String(p.telegram_username)) : "id " + tgId} · доступ выдан` +
      (r.ok ? "" : "\n(сообщение покупателю не дошло: он ещё не запускал бота)"));
    return new Response("ok");
  }

  if (name === "digital_product_refunded") {
    const { data } = await sb.from("access").update({ revoked: true })
      .eq("source", "tribute").eq("payment_ref", ref).eq("revoked", false).select("id");
    if ((data ?? []).length) {
      await notifyAdmins(mainToken, `↩️ Возврат Tribute: id ${tgId}${p.telegram_username ? " (@" + esc(String(p.telegram_username)) + ")" : ""}, доступ закрыт`);
    }
    return new Response("ok");
  }

  return new Response("ok");
});
