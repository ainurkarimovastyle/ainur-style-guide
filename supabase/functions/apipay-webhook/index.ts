// Подписанные события ApiPay для телефонного счёта Kaspi.
// Секреты: APIPAY_WEBHOOK_SECRET, BOT_TOKEN, MAIN_BOT_TOKEN, ADMIN_IDS.
// Развернуть с verify_jwt=false: доступ защищён HMAC-подписью ApiPay.
import { createClient } from "jsr:@supabase/supabase-js@2";
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const enc = new TextEncoder();
const GUIDE = "https://t.me/ainurkarimova_bot?start=guide";
async function signatureOk(raw: string, signature: string, secret: string) {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  const given = signature.slice(7).toLowerCase();
  let diff = 0;
  for (let i = 0; i < digest.length; i++) diff |= digest[i] ^ Number.parseInt(given.slice(i * 2, i * 2 + 2), 16);
  return diff === 0;
}
async function tg(token: string, chatId: number, text: string, button = false) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text,
        ...(button ? { reply_markup: { inline_keyboard: [[{ text: "Открыть гид", url: GUIDE }]] } } : {}) }),
    });
  } catch (e) { console.error("telegram notification", e); }
}
function amountKzt(value: unknown) {
  if (typeof value !== "string" || !/^\d+\.00$/.test(value)) return null;
  const n = Number(value.slice(0, -3));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const secret = Deno.env.get("APIPAY_WEBHOOK_SECRET");
  if (!secret) return new Response("not_configured", { status: 503 });
  const raw = await req.text();
  if (!(await signatureOk(raw, req.headers.get("x-webhook-signature") ?? "", secret)))
    return new Response("forbidden", { status: 401 });
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response("bad_json", { status: 400 }); }
  const isSandbox = event?.is_sandbox;
  const expectedSandbox = Deno.env.get("APIPAY_SANDBOX_MODE") === "true";
  if (typeof isSandbox !== "boolean" || isSandbox !== expectedSandbox) return new Response("ok");
  if (!['invoice.status_changed', 'invoice.refunded'].includes(event?.event)) return new Response("ok");

  const invoice = event?.invoice;
  if (!invoice || invoice.is_sandbox !== isSandbox || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(invoice.external_order_id ?? "")))
    return new Response("ok");
  const invoiceId = Number(invoice.id);
  const amount = amountKzt(invoice.amount);
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0 || amount === null) return new Response("ok");
  const fullRefund = invoice.is_fully_refunded === true &&
    (event.event === 'invoice.status_changed' || event.refund?.status === 'completed');
  const action = fullRefund ? 'refunded' : event.event === 'invoice.refunded' ? 'ignored' : 'status';
  if (action === 'ignored') return new Response("ok");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const orderRef = String(invoice.external_order_id);
  const { data: order, error: lookupError } = await sb.from("apipay_orders")
    .select("tg_id,amount_kzt,invoice_id").eq("order_ref", orderRef).maybeSingle();
  if (lookupError) { console.error("apipay order lookup", lookupError); return new Response("db_error", { status: 500 }); }
  if (!order || order.amount_kzt !== amount || (order.invoice_id && order.invoice_id !== invoiceId)) return new Response("ok");
  const { data: result, error } = await sb.rpc("apipay_apply_event", {
    p_order_ref: orderRef, p_invoice_id: invoiceId, p_amount_kzt: amount,
    p_event: action, p_status: String(invoice.status ?? ""), p_is_sandbox: isSandbox,
  });
  if (error) { console.error("apipay apply event", error); return new Response("db_error", { status: 500 }); }
  if (result === "granted" || result === "revoked") {
    const notify = async () => {
      const paymentBot = Deno.env.get("BOT_TOKEN");
      if (paymentBot) await tg(paymentBot, order.tg_id,
        result === "granted" ? "Оплата прошла ✅ Доступ к Shopping Guide открыт. Нажмите «Открыть гид»." : "Возврат оформлен. Доступ к гайду закрыт.",
        result === "granted");
      const mainBot = Deno.env.get("MAIN_BOT_TOKEN");
      if (mainBot) for (const admin of (Deno.env.get("ADMIN_IDS") ?? "").split(",").map((s) => Number(s.trim())).filter(Number.isSafeInteger))
        await tg(mainBot, admin, `${result === "granted" ? "💳 Оплата Kaspi" : "↩️ Возврат Kaspi"}: ${amount} ₸, Telegram ID ${order.tg_id}, счёт ${invoiceId}`);
    };
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(notify());
    else await notify(); // локальные проверки без Supabase runtime
  }
  return new Response("ok");
});
