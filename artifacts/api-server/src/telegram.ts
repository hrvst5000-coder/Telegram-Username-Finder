import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, botPayments, botUsers } from "@workspace/db";
import { logger } from "./lib/logger";

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const CRYPTOBOT_TOKEN = process.env["CRYPTOBOT_API_TOKEN"];
const XROCKET_TOKEN = process.env["XROCKET_API_TOKEN"];
const PRICE_USD = "0.01";
const ATTEMPTS_PER_PURCHASE = 5;
const FREE_ATTEMPTS_PER_DAY = 5;

type TelegramUpdate = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { chat: { id: number } };
    data?: string;
  };
};

type TelegramReplyMarkup =
  | { keyboard: Array<Array<{ text: string }>>; resize_keyboard?: boolean; is_persistent?: boolean }
  | { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

type TelegramResult<T> = { ok: boolean; result?: T; description?: string };

type PaymentProvider = "cryptobot" | "xrocket";

const mainKeyboard: TelegramReplyMarkup = {
  keyboard: [
    [{ text: "🔎 Найти username" }, { text: "🛒 Купить попытки" }],
    [{ text: "👥 Пригласить друзей" }, { text: "ℹ️ Мой баланс" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const shortNames = [
  "aeris", "aurea", "bliss", "bloom", "brave", "candy", "celes", "daisy",
  "dream", "elara", "flora", "glowy", "honey", "ivory", "lilac", "lumen",
  "lyric", "musee", "noble", "ocean", "pearl", "rosie", "seren", "sonic",
  "velar", "vivid", "waves", "zelda", "amity", "aroma", "belle", "crema",
  "dawnx", "eclat", "fable", "fairy", "fresh", "lucid", "magic", "merry",
  "moony", "orbit", "plume", "quiet", "river", "satin", "soulx", "sunny",
  "witty",
];

const sixNames = [
  "aurora", "breeze", "celest", "cosmos", "dazzle", "dreamy", "embery",
  "feline", "glowly", "golden", "heaven", "honest", "lilies", "lovely",
  "lucent", "mellow", "nebula", "novela", "pearly", "pretty", "rosier",
  "silken", "smooth", "stella", "velvet", "violet", "wisely", "amoura",
  "bloomy", "brighty", "calmia", "dreams", "fresco", "gentle", "hushly",
  "lovely", "mystic", "nature", "opales", "purely", "secret", "softly",
  "sunlit", "sweetly", "uplift", "warmth", "zenith",
];

const roots = [
  "aura", "bloom", "cloud", "cosmo", "dream", "flora", "glow", "lumen",
  "muse", "nova", "ocean", "pearl", "pixel", "rosey", "serene", "shine",
  "solar", "stella", "velvet", "vivid", "zen",
];

function moscowDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shuffle<T>(items: T[], seed: string): T[] {
  return [...items].sort((left, right) => {
    const leftHash = createHash("sha256").update(`${seed}:${String(left)}`).digest("hex");
    const rightHash = createHash("sha256").update(`${seed}:${String(right)}`).digest("hex");
    return leftHash.localeCompare(rightHash);
  });
}

function isValidUsername(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(value);
}

class TelegramClient {
  constructor(private readonly token: string) {}

  async call<T>(method: string, body?: Record<string, unknown>): Promise<TelegramResult<T>> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = (await response.json()) as TelegramResult<T>;
    if (!response.ok && method !== "getChat") {
      throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
    }
    return result;
  }

  async sendMessage(chatId: number, text: string, replyMarkup?: TelegramReplyMarkup): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      disable_web_page_preview: true,
    });
  }
}

async function getOrCreateUser(
  telegramId: number,
  firstName: string,
  username?: string,
  referralId?: number,
) {
  const today = moscowDate();
  await db
    .insert(botUsers)
    .values({
      telegramId,
      firstName: firstName || "Друг",
      username: username ?? null,
      freeAttemptsDate: today,
      referredBy: referralId && referralId !== telegramId ? referralId : null,
    })
    .onConflictDoNothing();

  const existing = await db.select().from(botUsers).where(eq(botUsers.telegramId, telegramId)).limit(1);
  const user = existing[0];
  if (!user) {
    throw new Error(`Unable to create Telegram user ${telegramId}`);
  }

  if (user.freeAttemptsDate !== today) {
    const refreshed = await db
      .update(botUsers)
      .set({ freeAttemptsDate: today, freeAttemptsUsed: 0, firstName: firstName || user.firstName, username: username ?? user.username })
      .where(eq(botUsers.telegramId, telegramId))
      .returning();
    return refreshed[0] ?? user;
  }

  if (user.referredBy === referralId && referralId && referralId !== telegramId) {
    return user;
  }

  if (referralId && referralId !== telegramId && !user.referredBy) {
    const updated = await db
      .update(botUsers)
      .set({ referredBy: referralId })
      .where(eq(botUsers.telegramId, telegramId))
      .returning();
    return updated[0] ?? user;
  }

  return user;
}

async function applyReferralBonus(userId: number): Promise<void> {
  const users = await db.select().from(botUsers).where(eq(botUsers.telegramId, userId)).limit(1);
  const user = users[0];
  if (!user?.referredBy) return;

  const referrer = await db.select().from(botUsers).where(eq(botUsers.telegramId, user.referredBy)).limit(1);
  if (!referrer[0]) return;

  await db
    .update(botUsers)
    .set({
      paidAttempts: referrer[0].paidAttempts + 1,
      referralCount: referrer[0].referralCount + 1,
    })
    .where(eq(botUsers.telegramId, referrer[0].telegramId));
}

async function consumeAttempt(userId: number): Promise<{ remaining: number; source: "free" | "paid" } | null> {
  const userRows = await db.select().from(botUsers).where(eq(botUsers.telegramId, userId)).limit(1);
  const user = userRows[0];
  if (!user) return null;

  const today = moscowDate();
  let freeUsed = user.freeAttemptsUsed;
  if (user.freeAttemptsDate !== today) freeUsed = 0;

  if (freeUsed < FREE_ATTEMPTS_PER_DAY) {
    const updated = await db
      .update(botUsers)
      .set({ freeAttemptsDate: today, freeAttemptsUsed: freeUsed + 1 })
      .where(eq(botUsers.telegramId, userId))
      .returning();
    const next = updated[0];
    return { remaining: FREE_ATTEMPTS_PER_DAY - (next?.freeAttemptsUsed ?? freeUsed + 1) + user.paidAttempts, source: "free" };
  }

  if (user.paidAttempts > 0) {
    const updated = await db
      .update(botUsers)
      .set({ freeAttemptsDate: today, freeAttemptsUsed: freeUsed, paidAttempts: user.paidAttempts - 1 })
      .where(eq(botUsers.telegramId, userId))
      .returning();
    const next = updated[0];
    return { remaining: next?.paidAttempts ?? user.paidAttempts - 1, source: "paid" };
  }

  return null;
}

function candidateNames(mode: "short" | "six" | "any", userId: number): string[] {
  if (mode === "short") return shuffle(shortNames, `${userId}:short`).slice(0, 18);
  if (mode === "six") return shuffle(sixNames, `${userId}:six`).slice(0, 18);

  const generated = new Set<string>();
  for (const root of shuffle(roots, `${userId}:any`)) {
    generated.add(root);
    generated.add(`${root}hub`);
    generated.add(`${root}room`);
    generated.add(`the_${root}`);
    generated.add(`${root}_club`);
    if (generated.size >= 26) break;
  }
  return shuffle([...generated].filter(isValidUsername), `${userId}:any-final`).slice(0, 22);
}

async function findAvailableUsernames(
  telegram: TelegramClient,
  mode: "short" | "six" | "any",
  userId: number,
): Promise<string[]> {
  const available: string[] = [];
  for (const candidate of candidateNames(mode, userId)) {
    const response = await telegram.call<{ id: number }>("getChat", { chat_id: `@${candidate}` });
    if (!response.ok && /not found|username/i.test(response.description ?? "")) {
      available.push(candidate);
    }
    if (available.length >= 5) break;
    await delay(120);
  }
  return available;
}

function searchModeLabel(mode: "short" | "six" | "any"): string {
  if (mode === "short") return "5 букв";
  if (mode === "six") return "6 букв";
  return "без ограничений";
}

async function createCryptoBotInvoice(userId: number, paymentId: number, telegram: TelegramClient): Promise<string> {
  if (!CRYPTOBOT_TOKEN) throw new Error("CRYPTOBOT_API_TOKEN is not configured");
  const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
    method: "POST",
    headers: { "content-type": "application/json", "Crypto-Pay-API-Token": CRYPTOBOT_TOKEN },
    body: JSON.stringify({
      currency_type: "fiat",
      fiat: "USD",
      amount: PRICE_USD,
      accepted_assets: "USDT",
      description: "5 попыток поиска username",
      paid_btn_name: "callback",
      paid_btn_url: "https://t.me",
    }),
  });
  const data = (await response.json()) as { ok: boolean; result?: { invoice_id: number; bot_invoice_url?: string }; error?: { name?: string } };
  if (!data.ok || !data.result) throw new Error(`Crypto Bot invoice error: ${data.error?.name ?? "unknown"}`);
  await db
    .update(botPayments)
    .set({ externalId: String(data.result.invoice_id), payUrl: data.result.bot_invoice_url ?? null })
    .where(eq(botPayments.id, paymentId));
  return data.result.bot_invoice_url ?? `https://t.me/CryptoBot?start=invoice_${data.result.invoice_id}`;
}

async function createXrocketInvoice(userId: number, paymentId: number): Promise<string> {
  if (!XROCKET_TOKEN) throw new Error("XROCKET_API_TOKEN is not configured");
  const response = await fetch("https://pay.xrocket.exchange/tg-invoices", {
    method: "POST",
    headers: { "content-type": "application/json", "Rocket-Pay-Key": XROCKET_TOKEN },
    body: JSON.stringify({
      amount: Number(PRICE_USD),
      currency: "USDT",
      description: "5 попыток поиска username",
      numPayments: 1,
      expiredIn: 3600,
    }),
  });
  const data = (await response.json()) as { success?: boolean; data?: Record<string, unknown>; message?: string };
  if (!response.ok || !data.data) throw new Error(`xRocket invoice error: ${data.message ?? `HTTP ${response.status}`}`);
  const invoice = data.data;
  const externalId = String(invoice["id"] ?? invoice["invoiceId"] ?? "");
  const payUrl = String(invoice["link"] ?? invoice["payLink"] ?? invoice["url"] ?? "");
  if (!externalId || !payUrl) throw new Error("xRocket returned an incomplete invoice");
  await db
    .update(botPayments)
    .set({ externalId, payUrl })
    .where(eq(botPayments.id, paymentId));
  return payUrl;
}

async function startPayment(userId: number, provider: PaymentProvider, telegram: TelegramClient): Promise<string> {
  const [payment] = await db
    .insert(botPayments)
    .values({
      telegramId: userId,
      provider,
      externalId: `pending-${Date.now()}-${userId}`,
      amount: PRICE_USD,
      attempts: ATTEMPTS_PER_PURCHASE,
    })
    .returning();
  if (!payment) throw new Error("Unable to create payment record");

  try {
    return provider === "cryptobot"
      ? await createCryptoBotInvoice(userId, payment.id, telegram)
      : await createXrocketInvoice(userId, payment.id);
  } catch (error) {
    await db.update(botPayments).set({ status: "failed" }).where(eq(botPayments.id, payment.id));
    throw error;
  }
}

async function grantPaidAttempts(paymentId: number): Promise<void> {
  const payments = await db
    .select()
    .from(botPayments)
    .where(and(eq(botPayments.id, paymentId), eq(botPayments.status, "pending")))
    .limit(1);
  const payment = payments[0];
  if (!payment) return;

  await db
    .update(botPayments)
    .set({ status: "paid", completedAt: new Date() })
    .where(and(eq(botPayments.id, payment.id), eq(botPayments.status, "pending")));
  await db
    .update(botUsers)
    .set({
      paidAttempts: ((await db.select().from(botUsers).where(eq(botUsers.telegramId, payment.telegramId)).limit(1))[0]?.paidAttempts ?? 0) + payment.attempts,
    })
    .where(eq(botUsers.telegramId, payment.telegramId));
}

async function pollCryptoBotPayments(telegram: TelegramClient): Promise<void> {
  if (!CRYPTOBOT_TOKEN) return;
  const payments = await db
    .select()
    .from(botPayments)
    .where(and(eq(botPayments.provider, "cryptobot"), eq(botPayments.status, "pending")));
  for (const payment of payments) {
    if (payment.externalId.startsWith("pending-")) continue;
    const response = await fetch(`https://pay.crypt.bot/api/getInvoices?invoice_ids=${encodeURIComponent(payment.externalId)}`, {
      headers: { "Crypto-Pay-API-Token": CRYPTOBOT_TOKEN },
    });
    const data = (await response.json()) as { ok: boolean; result?: { items?: Array<{ status?: string }> } };
    const status = data.result?.items?.[0]?.status;
    if (status === "paid") await grantPaidAttempts(payment.id);
  }
}

async function pollXrocketPayments(): Promise<void> {
  if (!XROCKET_TOKEN) return;
  const payments = await db
    .select()
    .from(botPayments)
    .where(and(eq(botPayments.provider, "xrocket"), eq(botPayments.status, "pending")));
  for (const payment of payments) {
    if (payment.externalId.startsWith("pending-")) continue;
    const response = await fetch(`https://pay.xrocket.exchange/tg-invoices/${encodeURIComponent(payment.externalId)}`, {
      headers: { "Rocket-Pay-Key": XROCKET_TOKEN },
    });
    if (!response.ok) continue;
    const data = (await response.json()) as { data?: Record<string, unknown> };
    const status = String(data.data?.["status"] ?? data.data?.["state"] ?? "").toLowerCase();
    if (/paid|complete|success|activate/.test(status)) await grantPaidAttempts(payment.id);
  }
}

async function paymentPoller(telegram: TelegramClient): Promise<void> {
  while (true) {
    try {
      await Promise.all([pollCryptoBotPayments(telegram), pollXrocketPayments()]);
    } catch (error) {
      logger.error({ err: error }, "Payment polling failed");
    }
    await delay(15_000);
  }
}

async function sendBalance(telegram: TelegramClient, userId: number, chatId: number): Promise<void> {
  const [user] = await db.select().from(botUsers).where(eq(botUsers.telegramId, userId)).limit(1);
  if (!user) return;
  const today = moscowDate();
  const freeUsed = user.freeAttemptsDate === today ? user.freeAttemptsUsed : 0;
  await telegram.sendMessage(
    chatId,
    `Ваш баланс\n\nБесплатно сегодня: ${Math.max(0, FREE_ATTEMPTS_PER_DAY - freeUsed)} из ${FREE_ATTEMPTS_PER_DAY}\nПлатных попыток: ${user.paidAttempts}\n\nЦена: 5 попыток — $${PRICE_USD}`,
    mainKeyboard,
  );
}

async function sendPurchaseMenu(telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, `Пополнить баланс\n\n5 попыток — $${PRICE_USD}\nВыберите способ оплаты:`, {
    inline_keyboard: [
      [{ text: "Xrocket", callback_data: "buy:xrocket" }, { text: "Crypto Bot", callback_data: "buy:cryptobot" }],
      [{ text: "Назад", callback_data: "menu:back" }],
    ],
  });
}

async function handleSearch(
  telegram: TelegramClient,
  chatId: number,
  userId: number,
  mode: "short" | "six" | "any",
): Promise<void> {
  const attempt = await consumeAttempt(userId);
  if (!attempt) {
    await telegram.sendMessage(chatId, "Бесплатные попытки на сегодня закончились. Купите ещё 5 попыток за $0.01.", mainKeyboard);
    return;
  }

  await telegram.sendMessage(chatId, `Ищу красивые варианты (${searchModeLabel(mode)})…`, mainKeyboard);
  const results = await findAvailableUsernames(telegram, mode, userId);
  if (!results.length) {
    await telegram.sendMessage(chatId, "В этот раз подходящих вариантов не нашлось. Попробуйте ещё раз — попытка уже использована.", mainKeyboard);
    return;
  }

  const links = results.map((name) => `@${name} — https://t.me/${name}`).join("\n");
  await telegram.sendMessage(
    chatId,
    `Нашёл варианты:\n\n${links}\n\nОсталось попыток: ${attempt.remaining}\n\nВажно: это предварительная проверка через Bot API. Перед регистрацией проверьте username в Telegram — имя может быть занято или зарезервировано.`,
    mainKeyboard,
  );
}

async function handleUpdate(telegram: TelegramClient, update: TelegramUpdate, botUsername: string): Promise<void> {
  const message = update.message;
  const callback = update.callback_query;
  const from = message?.from ?? callback?.from;
  const chatId = message?.chat.id ?? callback?.message?.chat.id;
  if (!from || !chatId) return;

  let referralId: number | undefined;
  if (message?.text?.startsWith("/start")) {
    const startParam = message.text.split(/\s+/)[1];
    if (startParam?.startsWith("ref_")) {
      const parsed = Number(startParam.slice(4));
      if (Number.isSafeInteger(parsed)) referralId = parsed;
    }
  }
  const user = await getOrCreateUser(from.id, from.first_name ?? "Друг", from.username, referralId);
  if (referralId && user.referredBy === referralId && !user.referralRewarded) {
    await applyReferralBonus(from.id);
    await db
      .update(botUsers)
      .set({ referralRewarded: true })
      .where(eq(botUsers.telegramId, from.id));
  }

  if (callback) {
    await telegram.call("answerCallbackQuery", { callback_query_id: callback.id });
    const data = callback.data ?? "";
    if (data === "menu:back") {
      await telegram.sendMessage(chatId, "Главное меню", mainKeyboard);
      return;
    }
    if (data === "search:short" || data === "search:six" || data === "search:any") {
      await handleSearch(telegram, chatId, from.id, data.slice(7) as "short" | "six" | "any");
      return;
    }
    if (data === "buy:xrocket" || data === "buy:cryptobot") {
      const provider = data.slice(4) as PaymentProvider;
      try {
        const url = await startPayment(from.id, provider, telegram);
        await telegram.sendMessage(chatId, `Счёт создан. После оплаты попытки начислятся автоматически.\n\nСсылка на оплату: ${url}`, mainKeyboard);
      } catch (error) {
        logger.error({ err: error, provider }, "Could not create payment invoice");
        await telegram.sendMessage(chatId, "Не удалось создать счёт. Проверьте настройки оплаты и попробуйте позже.", mainKeyboard);
      }
      return;
    }
    return;
  }

  const text = message?.text ?? "";
  if (text.startsWith("/start")) {
    await telegram.sendMessage(
      chatId,
      `Привет, ${user.firstName}!\n\nЯ помогу найти красивые Telegram username.\n\nУ вас 5 бесплатных попыток в день.\nСтоимость 5 попыток — $${PRICE_USD}.`,
      mainKeyboard,
    );
    return;
  }
  if (text === "🔎 Найти username" || text === "Найти") {
    await telegram.sendMessage(chatId, "Какой длины username искать?", {
      inline_keyboard: [
        [{ text: "1–5 букв (ищу 5)", callback_data: "search:short" }],
        [{ text: "6 букв", callback_data: "search:six" }],
        [{ text: "Без ограничений", callback_data: "search:any" }],
      ],
    });
    return;
  }
  if (text === "🛒 Купить попытки" || text === "Пополнить") {
    await sendPurchaseMenu(telegram, chatId);
    return;
  }
  if (text === "ℹ️ Мой баланс" || text === "Баланс") {
    await sendBalance(telegram, from.id, chatId);
    return;
  }
  if (text === "👥 Пригласить друзей" || text === "Пригласить друзей") {
    await telegram.sendMessage(
      chatId,
      `Приглашайте друзей и получайте по 1 дополнительной попытке за каждого нового пользователя.\n\nВаша ссылка:\nhttps://t.me/${botUsername}?start=ref_${from.id}\n\nПриглашено: ${user.referralCount}`,
      mainKeyboard,
    );
    return;
  }
  await telegram.sendMessage(chatId, "Выберите действие в меню ниже.", mainKeyboard);
}

export async function startTelegramBot(): Promise<void> {
  if (!BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN is not configured; Telegram bot is disabled");
    return;
  }

  const telegram = new TelegramClient(BOT_TOKEN);
  const me = await telegram.call<{ username?: string }>("getMe");
  if (!me.ok || !me.result) throw new Error(`Telegram bot authorization failed: ${me.description ?? "unknown error"}`);
  await telegram.call("deleteWebhook", { drop_pending_updates: false });
  const botUsername = me.result.username ?? "username_finder_bot";
  logger.info({ botUsername }, "Telegram username finder started");
  void paymentPoller(telegram);

  let offset = 0;
  while (true) {
    try {
      const updates = await telegram.call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates.result ?? []) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(telegram, update, botUsername);
        } catch (error) {
          logger.error({ err: error, updateId: update.update_id }, "Telegram update failed");
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram polling failed; retrying");
      await delay(5_000);
    }
  }
}