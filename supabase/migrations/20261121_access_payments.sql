-- Оплаты: одна покупка = одна выдача доступа, валюта платежа.
alter table public.access add column if not exists currency text;
create unique index if not exists access_source_payment_ref_uidx
  on public.access (source, payment_ref) where payment_ref is not null;
