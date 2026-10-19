import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { validateTwilioSignature, sendWhatsApp } from "../core/whatsapp.js";
import { markDelivery, createMagicLink } from "../core/notify.js";
import { logger } from "../logger.js";

const { users, monitors } = schema;

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const verify = (req: { body: unknown; headers: Record<string, unknown>; url: string }): boolean => {
    const params = (req.body ?? {}) as Record<string, string>;
    const url = `${config.appUrl}${req.url}`;
    return validateTwilioSignature(url, params, req.headers["x-twilio-signature"] as string | undefined);
  };

  // Inbound WhatsApp: STOP / START, otherwise a help line.
  app.post("/twilio/inbound", async (req, reply) => {
    if (!verify(req)) return reply.code(403).send("forbidden");
    const body = req.body as Record<string, string>;
    const from = (body.From ?? "").replace(/^whatsapp:/, "");
    const text = (body.Body ?? "").trim().toLowerCase();
    const user = await db.query.users.findFirst({ where: eq(users.phoneE164, from) });
    reply.header("content-type", "text/xml");
    if (!user) return reply.send("<Response></Response>");

    if (/^(stop|unsubscribe|cancel|end|quit|baja)$/.test(text)) {
      await db.update(users).set({ whatsappOptedOut: true }).where(eq(users.id, user.id));
      await db.update(monitors).set({ status: "paused" }).where(eq(monitors.userId, user.id));
      logger.info({ userId: user.id }, "opted out");
      return reply.send("<Response></Response>"); // Twilio sends its own STOP confirmation
    }
    if (/^(start|unstop|yes|alta)$/.test(text)) {
      await db.update(users).set({ whatsappOptedOut: false }).where(eq(users.id, user.id));
      return reply.send("<Response></Response>");
    }
    try {
      const link = await createMagicLink(user.id, null);
      await sendWhatsApp(user.phoneE164, "help", { link });
    } catch (e) {
      logger.warn({ err: e }, "help reply failed");
    }
    return reply.send("<Response></Response>");
  });

  // Delivery status callbacks.
  app.post("/twilio/status", async (req, reply) => {
    if (!verify(req)) return reply.code(403).send("forbidden");
    const body = req.body as Record<string, string>;
    if (body.MessageSid && body.MessageStatus) await markDelivery(body.MessageSid, body.MessageStatus);
    return reply.send("ok");
  });
}
