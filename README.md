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

Оплата через Kaspi / ApiPay (код подготовлен, до регистрации не активен):
- Кнопка в витрине открывает платёжного бота. В нём покупатель выбирает Kaspi и отправляет номер телефона Казахстана. Бот создаёт счёт на 14 000 ₸ через `POST /invoices` ApiPay.
- После регистрации в ApiPay настроить Kaspi Pay, получить API-ключ и создать вебхук на `https://zafgwbfgutlbudqevpal.supabase.co/functions/v1/apipay-webhook` для `invoice.status_changed` и `invoice.refunded`.
- В секретах Supabase указать `APIPAY_API_KEY`, `APIPAY_WEBHOOK_SECRET`, `BOT_TOKEN`, `MAIN_BOT_TOKEN`. Для тестов ApiPay в песочнице временно задать `APIPAY_SANDBOX_MODE=true`; перед реальными платежами удалить этот секрет или задать `false`.
- Применить `supabase/migrations/20261121_apipay_orders.sql`, развернуть `guide-bot` и `apipay-webhook` с `verify_jwt=false`, затем обновить Telegram-вебхук платёжного бота служебным действием `legacy_webhook`.
- Проверить создание тестового счёта, успешную оплату, повторное уведомление и полный возврат в песочнице ApiPay. Бот показывает кнопку Kaspi только после установки обоих секретов; доступ выдаёт только подписанное уведомление о статусе `paid`.
