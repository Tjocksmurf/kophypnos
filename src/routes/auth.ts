import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, isNull, count } from "drizzle-orm";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { parsePhone } from "../core/phone.js";
import { sendWhatsApp } from "../core/whatsapp.js";
import { createSession, destroySession } from "../plugins/session.js";
import { isValidTimezone } from "../core/schedule.js";
import { logger } from "../logger.js";

const { users, loginCodes, magicTokens, notifications } = schema;

function hashCode(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---- request a login code
  app.post(
    "/request-code",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (req, reply) => {
      const body = z.object({ phone: z.string().min(6).max(30), country: z.string().length(2).optional(), timezone: z.string().optional() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Enter a phone number." } });
      const phone = parsePhone(body.data.phone, body.data.country ?? null);
      // Never reveal whether a number is valid or known: same response either way.
      if (!phone) return reply.send({ ok: true });

      let user = await db.query.users.findFirst({ where: eq(users.phoneE164, phone.e164) });
      if (user?.deletedAt) {
        // A deleted account signing in again starts fresh.
        await db.update(users).set({ deletedAt: null, whatsappOptedOut: false }).where(eq(users.id, user.id));
        user = { ...user, deletedAt: null };
      }
      if (!user) {
        const tz = body.data.timezone && isValidTimezone(body.data.timezone) ? body.data.timezone : "UTC";
        const [created] = await db
          .insert(users)
          .values({ phoneE164: phone.e164, countryCode: phone.country, timezone: tz })
          .returning();
        user = created!;
      }

      // 3 codes per number per 15 minutes.
      const since = new Date(Date.now() - 15 * 60 * 1000);
      const [recent] = await db.select({ n: count() }).from(loginCodes).where(and(eq(loginCodes.userId, user.id), gte(loginCodes.createdAt, since)));
      if ((recent?.n ?? 0) >= 3) return reply.send({ ok: true });

      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const salt = randomBytes(8).toString("hex");
      await db.update(loginCodes).set({ usedAt: new Date() }).where(and(eq(loginCodes.userId, user.id), isNull(loginCodes.usedAt)));
      await db.insert(loginCodes).values({
        userId: user.id,
        codeHash: hashCode(code, salt),
        salt,
        expiresAt: new Date(Date.now() + config.limits.loginCodeMinutes * 60 * 1000),
      });
      try {
        const res = await sendWhatsApp(phone.e164, "login_code", { code });
        await db.insert(notifications).values({ userId: user.id, template: "login_code", body: res.dryRun ? res.body : null, twilioSid: res.sid, status: "sent", sentAt: new Date() });
        if (res.dryRun) logger.warn({ phone: phone.e164, code }, "DRY RUN login code (not sent)");
      } catch (e) {
        logger.error({ err: e }, "failed to send login code");
        await db.insert(notifications).values({ userId: user.id, template: "login_code", status: "failed", error: e instanceof Error ? e.message : String(e) });
      }
      return reply.send({ ok: true, ...(config.twilio.dryRun && !config.isProd ? { dev_code: code } : {}) });
    },
  );

  // ---- verify a code
  app.post(
    "/verify",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const body = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/), country: z.string().length(2).optional() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Enter the 6-digit code." } });
      const phone = parsePhone(body.data.phone, body.data.country ?? null);
      const fail = () => reply.code(400).send({ error: { code: "invalid_code", message: "That code isn't right or has expired." } });
      if (!phone) return fail();
      const user = await db.query.users.findFirst({ where: eq(users.phoneE164, phone.e164) });
      if (!user) return fail();
      const row = await db.query.loginCodes.findFirst({
        where: and(eq(loginCodes.userId, user.id), isNull(loginCodes.usedAt)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });
      if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= 5) return fail();
      const expected = Buffer.from(row.codeHash, "hex");
      const got = Buffer.from(hashCode(body.data.code, row.salt), "hex");
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
        await db.update(loginCodes).set({ attempts: row.attempts + 1 }).where(eq(loginCodes.id, row.id));
        return fail();
      }
      await db.update(loginCodes).set({ usedAt: new Date() }).where(eq(loginCodes.id, row.id));
      await db.update(users).set({ lastSeenAt: new Date(), deletedAt: null }).where(eq(users.id, user.id));
      await createSession(reply, user.id, req.headers["user-agent"]);
      return reply.send({ ok: true, user: publicUser(user) });
    },
  );

  app.post("/logout", async (req, reply) => {
    await destroySession(reply, req.sessionId);
    return reply.send({ ok: true });
  });

  // ---- magic link from a WhatsApp message
  app.get("/magic/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const row = await db.query.magicTokens.findFirst({ where: eq(magicTokens.id, token) });
    const target = row?.monitorId ? `/m/${row.monitorId}` : "/";
    if (!row || row.expiresAt.getTime() < Date.now()) {
      return reply.redirect(req.user ? target : "/login?expired=1");
    }
    if (!row.usedAt) {
      await db.update(magicTokens).set({ usedAt: new Date() }).where(eq(magicTokens.id, row.id));
      if (!req.user || req.user.id !== row.userId) {
        const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
        if (user && !user.deletedAt) await createSession(reply, user.id, req.headers["user-agent"]);
      }
    } else if (!req.user) {
      return reply.redirect("/login?expired=1");
    }
    return reply.redirect(target);
  });
}

export function publicUser(u: schema.User) {
  return {
    id: u.id,
    phone: u.phoneE164,
    timezone: u.timezone,
    quiet_hours_start: u.quietHoursStart,
    quiet_hours_end: u.quietHoursEnd,
    whatsapp_opted_out: u.whatsappOptedOut,
    plan: u.plan,
    created_at: u.createdAt,
  };
}
