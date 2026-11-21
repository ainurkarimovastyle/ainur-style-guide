-- Один заказ связывает Telegram-покупателя со счётом ApiPay.
create table if not exists public.apipay_orders (
  order_ref uuid primary key,
  tg_id bigint not null,
  product_key text not null default 'guide_winter_2627',
  amount_kzt integer not null check (amount_kzt > 0),
  phone_number text,
  invoice_id bigint unique,
  status text not null check (status in ('awaiting_phone','creating','processing','pending','paid','error','expired','cancelled','refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists apipay_one_active_order_per_buyer
  on public.apipay_orders (tg_id, product_key)
  where status in ('awaiting_phone','creating','processing','pending');
create index if not exists apipay_orders_tg_id_idx on public.apipay_orders (tg_id, created_at desc);
alter table public.apipay_orders enable row level security;
-- Только Edge Functions с service_role читают и меняют заказы.

-- Применяем события под блокировкой заказа: повторные и переставленные вебхуки
-- не выдают доступ дважды и не возвращают его после полного возврата.
create or replace function public.apipay_apply_event(
  p_order_ref uuid, p_invoice_id bigint, p_amount_kzt integer,
  p_event text, p_status text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  o public.apipay_orders%rowtype;
  inserted_count integer;
  revoked_count integer;
begin
  select * into o from public.apipay_orders where order_ref = p_order_ref for update;
  if not found or o.amount_kzt <> p_amount_kzt or p_invoice_id is null or p_invoice_id <= 0
     or (o.invoice_id is not null and o.invoice_id <> p_invoice_id) then
    return 'ignored';
  end if;
  if p_event = 'refunded' then
    update public.apipay_orders set status = 'refunded', invoice_id = p_invoice_id, updated_at = now()
      where order_ref = p_order_ref;
    update public.access set revoked = true where source = 'apipay'
      and payment_ref = p_invoice_id::text and tg_id = o.tg_id and revoked = false;
    get diagnostics revoked_count = row_count;
    return case when revoked_count > 0 then 'revoked' else 'ok' end;
  end if;
  if o.status = 'refunded' then return 'ignored'; end if;
  if p_status = 'paid' then
    update public.apipay_orders set status = 'paid', invoice_id = p_invoice_id, updated_at = now()
      where order_ref = p_order_ref;
    insert into public.access (tg_id, source, payment_ref, amount, currency, expires_at)
      values (o.tg_id, 'apipay', p_invoice_id::text, p_amount_kzt, 'KZT', null)
      on conflict (source, payment_ref) where payment_ref is not null do nothing;
    get diagnostics inserted_count = row_count;
    return case when inserted_count > 0 then 'granted' else 'ok' end;
  end if;
  if o.status = 'paid' then return 'ignored'; end if;
  if p_status in ('processing','pending','error','expired','cancelled') then
    update public.apipay_orders set status = p_status, invoice_id = p_invoice_id, updated_at = now()
      where order_ref = p_order_ref;
    return 'updated';
  end if;
  return 'ignored';
end;
$$;
revoke all on function public.apipay_apply_event(uuid,bigint,integer,text,text) from public, anon, authenticated;
grant execute on function public.apipay_apply_event(uuid,bigint,integer,text,text) to service_role;
