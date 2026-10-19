import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";

const { sessions, users } = schema;
export const SESSION_COOKIE = "pm_session";

declare module "fastify" {
  interface FastifyRequest {
    user: schema.User | null;
    sessionId: string | null;
  }
  interface FastifyInstance {
    requireUser: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function createSession(reply: FastifyReply, userId: string, userAgent?: string): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    id,
    userId,
    userAgent: userAgent?.slice(0, 300) ?? null,
    expiresAt: new Date(Date.now() + config.limits.sessionDays * 86400 * 1000),
  });
  reply.setCookie(SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    signed: true,
    maxAge: config.limits.sessionDays * 86400,
  });
  return id;
}

export async function destroySession(reply: FastifyReply, sessionId: string | null): Promise<void> {
  if (sessionId) await db.delete(sessions).where(eq(sessions.id, sessionId));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

async function plugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("user", null);
  app.decorateRequest("sessionId", null);

  app.addHook("onRequest", async (req) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return;
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return;
    const row = await db.query.sessions.findFirst({ where: eq(sessions.id, unsigned.value) });
    if (!row || row.expiresAt.getTime() < Date.now()) return;
    const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!user || user.deletedAt) return;
    req.user = user;
    req.sessionId = row.id;
    // Extend on use, at most once an hour, and record last_seen.
    if (Date.now() - row.lastUsedAt.getTime() > 3600 * 1000) {
      void db
        .update(sessions)
        .set({ lastUsedAt: new Date(), expiresAt: new Date(Date.now() + config.limits.sessionDays * 86400 * 1000) })
        .where(eq(sessions.id, row.id));
      void db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
    }
  });

  app.decorate("requireUser", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      await reply.code(401).send({ error: { code: "unauthenticated", message: "Please log in." } });
    }
  });
}

export const sessionPlugin = fp(plugin, { name: "session" });
