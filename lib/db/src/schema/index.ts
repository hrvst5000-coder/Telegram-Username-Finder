import {
  bigint,
  boolean,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const botUsers = pgTable("bot_users", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  username: varchar("username", { length: 255 }),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  freeAttemptsUsed: integer("free_attempts_used").notNull().default(0),
  freeAttemptsDate: varchar("free_attempts_date", { length: 10 }).notNull(),
  paidAttempts: integer("paid_attempts").notNull().default(0),
  referredBy: bigint("referred_by", { mode: "number" }),
  referralRewarded: boolean("referral_rewarded").notNull().default(false),
  referralCount: integer("referral_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const botPayments = pgTable("bot_payments", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "number" }).notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  attempts: integer("attempts").notNull().default(5),
  status: varchar("status", { length: 32 }).notNull().default("pending"),
  payUrl: text("pay_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});