import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool,
  DB_POOL_SIZE: z.coerce.number().default(10),
  SESSION_SECRET: z.string().min(16),
  LOG_LEVEL: z.string().default("info"),
  SENTRY_DSN: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(), // e.g. whatsapp:+14155238886
  TWILIO_TEMPLATE_LOGIN_CODE: z.string().optional(),
  TWILIO_TEMPLATE_CHANGE_ALERT: z.string().optional(),
  TWILIO_TEMPLATE_MONITOR_PROBLEM: z.string().optional(),
  TWILIO_TEMPLATE_DIGEST: z.string().optional(),
  TWILIO_TEMPLATE_ACCOUNT_DELETED: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  LLM_DAILY_CAP_USD: z.coerce.number().default(0.5),

  FETCH_USER_AGENT: z
    .string()
    .default(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    ),
  FETCH_TIMEOUT_MS: z.coerce.number().default(15_000),
  FETCH_MAX_BYTES: z.coerce.number().default(2 * 1024 * 1024),
  WORKER_CONCURRENCY: z.coerce.number().default(10),
  BROWSER_CONCURRENCY: z.coerce.number().default(2),
  WORKER_POLL_MS: z.coerce.number().default(30_000),

  // Dev conveniences: print WhatsApp messages to the log instead of sending.
  WHATSAPP_DRY_RUN: bool,
  // Testing without WhatsApp: this number always gets this code. Ignored unless dry-run.
  TEST_LOGIN_PHONE: z.string().regex(/^\+\d{6,15}$/, "E.164, e.g. +61400000000").or(z.literal("")).optional(),
  TEST_LOGIN_CODE: z.string().regex(/^\d{6}$/, "6 digits").or(z.literal("")).optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid environment:\n${issues}`);
}
const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === "production",
  port: env.PORT,
  appUrl: env.APP_URL.replace(/\/$/, ""),
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL,
  dbPoolSize: env.DB_POOL_SIZE,
  sessionSecret: env.SESSION_SECRET,
  logLevel: env.LOG_LEVEL,
  sentryDsn: env.SENTRY_DSN,
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_WHATSAPP_FROM,
    templates: {
      login_code: env.TWILIO_TEMPLATE_LOGIN_CODE,
      change_alert: env.TWILIO_TEMPLATE_CHANGE_ALERT,
      monitor_problem: env.TWILIO_TEMPLATE_MONITOR_PROBLEM,
      digest: env.TWILIO_TEMPLATE_DIGEST,
      account_deleted: env.TWILIO_TEMPLATE_ACCOUNT_DELETED,
    },
    dryRun: env.WHATSAPP_DRY_RUN || !env.TWILIO_ACCOUNT_SID,
  },
  testLogin:
    (env.WHATSAPP_DRY_RUN || !env.TWILIO_ACCOUNT_SID) && env.TEST_LOGIN_PHONE && env.TEST_LOGIN_CODE
      ? { phone: env.TEST_LOGIN_PHONE, code: env.TEST_LOGIN_CODE }
      : null,
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ANTHROPIC_MODEL,
    dailyCapUsd: env.LLM_DAILY_CAP_USD,
  },
  fetch: {
    userAgent: env.FETCH_USER_AGENT,
    timeoutMs: env.FETCH_TIMEOUT_MS,
    maxBytes: env.FETCH_MAX_BYTES,
  },
  worker: {
    concurrency: env.WORKER_CONCURRENCY,
    browserConcurrency: env.BROWSER_CONCURRENCY,
    pollMs: env.WORKER_POLL_MS,
  },
  limits: {
    monitorsPerUser: 10,
    fastMonitorsPerUser: 3,
    browserMonitorsPerUser: 2,
    alertsPerDay: 30,
    proposalsPerDay: 20,
    minAlertGapMs: 30 * 60 * 1000,
    checkNowGapMs: 60 * 1000,
    sessionDays: 90,
    loginCodeMinutes: 10,
    magicTokenHours: 24,
  },
} as const;

export type Config = typeof config;
