import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { isValidTimezone } from "../core/schedule.js";
import { publicUser } from "./auth.js";
import { sendWhatsApp } from "../core/whatsapp.js";
import { destroySession } from "../plugins/session.js";
import { logger } from "../logger.js";

const { users, monitors, sessions, magicTokens, loginCodes } = schema;

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireUser);

  app.get("/", async (req) => ({ user: publicUser(req.user!) }));

  app.patch("/", async (req, reply) => {
    const body = z
      .object({
        timezone: z.string().optional(),
        quiet_hours_start: z.number().int().min(0).max(1439).nullable().optional(),
        quiet_hours_end: z.number().int().min(0).max(1439).nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Invalid settings." } });
    const patch: Partial<typeof users.$inferInsert> = {};
    if (body.data.timezone !== undefined) {
      if (!isValidTimezone(body.data.timezone)) return reply.code(400).send({ error: { code: "bad_timezone", message: "Unknown timezone." } });
      patch.timezone = body.data.timezone;
    }
    if (body.data.quiet_hours_start !== undefined) patch.quietHoursStart = body.data.quiet_hours_start;
    if (body.data.quiet_hours_end !== undefined) patch.quietHoursEnd = body.data.quiet_hours_end;
    const [updated] = await db.update(users).set(patch).where(eq(users.id, req.user!.id)).returning();
    return { user: publicUser(updated!) };
  });

  app.delete("/", async (req, reply) => {
    const u = req.user!;
    await db.transaction(async (tx) => {
      await tx.delete(monitors).where(eq(monitors.userId, u.id)); // cascades rules, checks, snapshots, changes
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await tx.delete(magicTokens).where(eq(magicTokens.userId, u.id));
      await tx.delete(loginCodes).where(eq(loginCodes.userId, u.id));
      await tx.update(users).set({ deletedAt: new Date() }).where(eq(users.id, u.id));
    });
    try {
      await sendWhatsApp(u.phoneE164, "account_deleted", {});
    } catch (e) {
      logger.warn({ err: e }, "account_deleted message failed");
    }
    await destroySession(reply, null);
    return { ok: true };
  });
}
