import { and, eq, gte, count } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sendWhatsApp, type TemplateName } from "./whatsapp.js";
import { inQuietHours, quietHoursEnd } from "./schedule.js";

const { users, notifications, magicTokens } = schema;

export async function createMagicLink(userId: string, monitorId: string | null): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.insert(magicTokens).values({
    id: token,
    userId,
    monitorId,
    expiresAt: new Date(Date.now() + config.limits.magicTokenHours * 3600 * 1000),
  });
  return `${config.appUrl}/api/auth/magic/${token}`;
}

export async function alertsSentToday(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.template, "change_alert"), gte(notifications.createdAt, since)));
  return row?.n ?? 0;
}

export interface NotifyResult {
  sent: boolean;
  reason?: "opted_out" | "quiet_hours" | "daily_cap" | "failed";
}

/**
 * Send a templated WhatsApp message to a user and record it. Handles opt-out, quiet hours
 * (alerts are held and counted into a digest) and the daily alert cap.
 */
export async function notifyUser(
  userId: string,
  template: TemplateName,
  variables: Record<string, string>,
  opts: { monitorId?: string | null; bypassQuietHours?: boolean } = {},
): Promise<NotifyResult> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.deletedAt) return { sent: false, reason: "failed" };
  if (user.whatsappOptedOut && template !== "account_deleted") return { sent: false, reason: "opted_out" };

  const now = new Date();
  if (template === "change_alert") {
    if (!opts.bypassQuietHours && inQuietHours(now, user.timezone, user.quietHoursStart, user.quietHoursEnd)) {
      await db.insert(notifications).values({
        userId,
        monitorId: opts.monitorId ?? null,
        template: "change_alert",
        body: variables.summary ?? null,
        status: "queued",
      });
      await ensureDigestScheduled(user.id, quietHoursEnd(now, user.timezone, user.quietHoursEnd!));
      return { sent: false, reason: "quiet_hours" };
    }
    const sent = await alertsSentToday(userId);
    if (sent >= config.limits.alertsPerDay) {
      if (sent === config.limits.alertsPerDay) {
        await deliver(user.id, user.phoneE164, "monitor_problem", {
          title: "Daily alert limit",
          reason: `you've hit ${config.limits.alertsPerDay} alerts today; the rest will be summarised later`,
          link: `${config.appUrl}/`,
        }, null);
      }
      await db.insert(notifications).values({ userId, monitorId: opts.monitorId ?? null, template: "change_alert", body: variables.summary ?? null, status: "queued" });
      return { sent: false, reason: "daily_cap" };
    }
  }
  const ok = await deliver(user.id, user.phoneE164, template, variables, opts.monitorId ?? null);
  return ok ? { sent: true } : { sent: false, reason: "failed" };
}

async function deliver(
  userId: string,
  phone: string,
  template: TemplateName,
  variables: Record<string, string>,
  monitorId: string | null,
): Promise<boolean> {
  try {
    const res = await sendWhatsApp(phone, template, variables);
    await db.insert(notifications).values({
      userId,
      monitorId,
      template,
      body: res.body,
      twilioSid: res.sid,
      status: "sent",
      sentAt: new Date(),
    });
    return true;
  } catch (e) {
    logger.error({ err: e, userId, template }, "whatsapp send failed");
    await db.insert(notifications).values({
      userId,
      monitorId,
      template,
      body: null,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** Digests are sent by the worker: it looks for queued change_alert rows whose user is out of quiet hours. */
async function ensureDigestScheduled(_userId: string, _at: Date): Promise<void> {
  // Nothing to do: the worker's digest sweep handles it. Kept as a hook for a future explicit schedule.
}

/** Called by the worker every poll: flush held alerts for users whose quiet hours have ended. */
export async function flushDigests(): Promise<number> {
  const held = await db
    .select({ userId: notifications.userId, n: count() })
    .from(notifications)
    .where(and(eq(notifications.template, "change_alert"), eq(notifications.status, "queued")))
    .groupBy(notifications.userId);
  let flushed = 0;
  for (const h of held) {
    const user = await db.query.users.findFirst({ where: eq(users.id, h.userId) });
    if (!user) continue;
    if (inQuietHours(new Date(), user.timezone, user.quietHoursStart, user.quietHoursEnd)) continue;
    if ((await alertsSentToday(user.id)) >= config.limits.alertsPerDay) continue;
    const link = await createMagicLink(user.id, null);
    const ok = await deliver(user.id, user.phoneE164, "digest", { count: String(h.n), link }, null);
    if (ok) {
      await db
        .update(notifications)
        .set({ status: "sent", sentAt: new Date() })
        .where(and(eq(notifications.userId, user.id), eq(notifications.template, "change_alert"), eq(notifications.status, "queued")));
      flushed += 1;
    }
  }
  return flushed;
}

export async function markDelivery(sid: string, status: string): Promise<void> {
  const delivered = status === "delivered" || status === "read";
  const failed = status === "failed" || status === "undelivered";
  if (!delivered && !failed) return;
  await db
    .update(notifications)
    .set(delivered ? { status: "delivered", deliveredAt: new Date() } : { status: "failed", error: status })
    .where(eq(notifications.twilioSid, sid));
}
