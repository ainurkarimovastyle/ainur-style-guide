# Гайд по покупкам · Айнур Каримова

Telegram Mini App с подборкой вещей из магазинов Астаны.

- `index.html` — сам гайд (каталог, фильтры, карточка вещи). Открывается только внутри Telegram;
  для проверки командой — `index.html?preview=<preview_token>`.
- `supabase/functions/guide-api` — API гайда: проверка подписи Telegram, доступ после оплаты, выдача позиций, статистика.
- `supabase/functions/build-items` — сборка таблицы `items` из Google-таблицы и данных со страниц магазинов.

База: Supabase-проект `ainur-style-guide` (таблицы `items`, `users`, `access`, `events`, `staging_raw`).

Секреты функций (задаются в панели Supabase → Edge Functions → Secrets):
- `BOT_TOKEN` — токен бота, в котором открывается гайд;
- `ADMIN_IDS` — Telegram ID через запятую, у кого доступ без оплаты;
- `PAY_URL` — ссылка на платёжного бота.

Оплата через Tribute готовится отдельно от публикации сайта и бота:
- Основной бот `@ainurkarimova_bot` показывает витрину и открывает купленный гид.
- Платёжный бот `@ainurkarimova_pay_bot` получает покупателя из витрины и показывает ссылку Tribute.
- После одобрения товара в Tribute указать его числовой ID в секрете `TRIBUTE_PRODUCTS`.
- В секретах Supabase указать `TRIBUTE_API_KEY` и `MAIN_BOT_TOKEN`; ключ Tribute не хранить в репозитории.
- В Tribute указать URL вебхука `https://zafgwbfgutlbudqevpal.supabase.co/functions/v1/tribute-webhook`.
- Применить миграцию `supabase/migrations/20261121_access_payments.sql` и развернуть `tribute-webhook` с `verify_jwt=false`.
- Проверить контрольную покупку и возврат до публикации кнопки оплаты.
