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
