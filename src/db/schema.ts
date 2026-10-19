import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------- enums ----------

export const planEnum = pgEnum("plan", ["free", "paid"]);
export const monitorStatusEnum = pgEnum("monitor_status", [
  "active",
  "paused",
  "paused_error",
  "stale",
]);
export const intervalEnum = pgEnum("check_interval", ["30m", "1h", "1d"]);
export const checkOutcomeEnum = pgEnum("check_outcome", [
  "unchanged",
  "changed",
  "changed_no_alert",
  "stale",
  "blocked",
  "error",
]);
export const snapshotKindEnum = pgEnum("snapshot_kind", ["latest", "previous"]);
export const ruleAuthorEnum = pgEnum("rule_author", ["llm", "user"]);
export const llmPurposeEnum = pgEnum("llm_purpose", ["rule", "judge", "relocate"]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
]);

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------- users & auth ----------

export const users = pgTable(
  "users",
  {
    id: id(),
    phoneE164: text("phone_e164").notNull(),
    countryCode: text("country_code"),
    timezone: text("timezone").notNull().default("UTC"),
    quietHoursStart: integer("quiet_hours_start"), // minutes from local midnight
    quietHoursEnd: integer("quiet_hours_end"),
    whatsappOptedOut: boolean("whatsapp_opted_out").notNull().default(false),
    plan: planEnum("plan").notNull().default("free"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_phone_idx").on(t.phoneE164)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // opaque random token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const loginCodes = pgTable(
  "login_codes",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    salt: text("salt").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("login_codes_user_idx").on(t.userId)],
);

export const magicTokens = pgTable(
  "magic_tokens",
  {
    id: text("id").primaryKey(), // random token
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("magic_tokens_user_idx").on(t.userId)],
);

// ---------- monitors ----------

export const monitors = pgTable(
  "monitors",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    host: text("host").notNull(),
    title: text("title"),
    faviconUrl: text("favicon_url"),
    status: monitorStatusEnum("status").notNull().default("active"),
    interval: intervalEnum("interval").notNull().default("1h"),
    dailyAt: integer("daily_at"), // minutes from local midnight, daily only
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastOutcome: checkOutcomeEnum("last_outcome"),
    lastAlertAt: timestamp("last_alert_at", { withTimezone: true }),
    lastValue: text("last_value"),
    previousValue: text("previous_value"),
    needsBrowser: boolean("needs_browser").notNull().default(false),
    consecutiveErrors: integer("consecutive_errors").notNull().default(0),
    consecutiveBlocks: integer("consecutive_blocks").notNull().default(0),
    etag: text("etag"),
    lastModified: text("last_modified"),
    createdAt: createdAt(),
  },
  (t) => [
    index("monitors_due_idx").on(t.status, t.nextRunAt),
    index("monitors_user_idx").on(t.userId),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: id(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    json: jsonb("json").notNull(),
    summary: text("summary").notNull(),
    confidence: real("confidence"),
    createdBy: ruleAuthorEnum("created_by").notNull().default("llm"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("rules_monitor_idx").on(t.monitorId, t.active)],
);

export const checks = pgTable(
  "checks",
  {
    id: id(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: checkOutcomeEnum("outcome"),
    httpStatus: integer("http_status"),
    fetchMs: integer("fetch_ms"),
    observedValue: text("observed_value"),
    textHash: text("text_hash"),
    error: text("error"),
  },
  (t) => [index("checks_monitor_idx").on(t.monitorId, t.startedAt)],
);

export const snapshots = pgTable(
  "snapshots",
  {
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    kind: snapshotKindEnum("kind").notNull(),
    readableText: text("readable_text").notNull(),
    html: text("html"), // cleaned body HTML, latest only, for rule relocation
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("snapshots_monitor_kind_idx").on(t.monitorId, t.kind)],
);

export const changes = pgTable(
  "changes",
  {
    id: id(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    checkId: text("check_id"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    summary: text("summary"),
    alerted: boolean("alerted").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("changes_monitor_idx").on(t.monitorId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    monitorId: text("monitor_id"),
    template: text("template").notNull(),
    body: text("body"),
    twilioSid: text("twilio_sid"),
    status: notificationStatusEnum("status").notNull().default("queued"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    index("notifications_sid_idx").on(t.twilioSid),
  ],
);

export const llmCalls = pgTable(
  "llm_calls",
  {
    id: id(),
    userId: text("user_id"),
    monitorId: text("monitor_id"),
    purpose: llmPurposeEnum("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("llm_calls_user_idx").on(t.userId, t.createdAt)],
);

// Pending previews: a fetched page waiting for the user to describe a rule.
export const previews = pgTable(
  "previews",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    host: text("host").notNull(),
    title: text("title"),
    faviconUrl: text("favicon_url"),
    readableText: text("readable_text").notNull(),
    html: text("html").notNull(),
    httpStatus: integer("http_status"),
    fetchStatus: text("fetch_status").notNull(), // ok | thin | blocked | error
    needsBrowser: boolean("needs_browser").notNull().default(false),
    etag: text("etag"),
    lastModified: text("last_modified"),
    createdAt: createdAt(),
  },
  (t) => [index("previews_user_idx").on(t.userId, t.createdAt)],
);

export type User = typeof users.$inferSelect;
export type Monitor = typeof monitors.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type Preview = typeof previews.$inferSelect;
