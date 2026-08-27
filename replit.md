# Telegram Username Finder

Telegram-бот для поиска красивых Telegram username с бесплатными дневными попытками, реферальной системой и оплатой дополнительных попыток.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`
- Payment env: `CRYPTOBOT_API_TOKEN`, `XROCKET_API_TOKEN`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/telegram.ts` — Telegram polling, меню, поиск, рефералы и оплаты
- `lib/db/src/schema/index.ts` — пользователи бота и платежи
- `artifacts/api-server/src/index.ts` — запуск HTTP-сервера и Telegram-бота

## Architecture decisions

- Бот использует long polling, чтобы запускаться без ручной настройки публичного webhook URL.
- 5 бесплатных попыток считаются по календарному дню Europe/Moscow и хранятся в PostgreSQL.
- Crypto Bot и xRocket подключены через их HTTP API; статус платежей периодически проверяется сервером.
- Проверка username через Bot API обозначается пользователю как предварительная: Bot API не даёт гарантии резервирования свободного имени.

## Product

- Кнопки: «Найти username», «Купить попытки», «Пригласить друзей», «Мой баланс».
- В поиске доступны варианты на 5 букв, ровно 6 букв и без ограничения длины.
- 5 попыток стоят $0.01; за нового приглашённого пользователя приглашающий получает 1 бонусную попытку.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
