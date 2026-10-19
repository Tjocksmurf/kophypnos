import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closeDb, pool, runMigrations } from "./db/index.js";
import { sessionPlugin } from "./plugins/session.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { pageRoutes } from "./routes/pages.js";
import { monitorRoutes } from "./routes/monitors.js";
import { webhookRoutes } from "./routes/webhooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../client/dist");

export async function buildServer() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 64 * 1024 });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(formbody);
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.user?.id ?? req.ip,
    errorResponseBuilder: () => ({ error: { code: "rate_limited", message: "Too many requests. Slow down a little." } }),
  });
  await app.register(sessionPlugin);

  // CSRF: state-changing requests from the SPA must carry this header; browsers won't add it cross-site.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url.startsWith("/api/webhooks/")) return;
    if (["POST", "PATCH", "PUT", "DELETE"].includes(req.method) && req.headers["x-requested-with"] !== "fetch") {
      await reply.code(403).send({ error: { code: "csrf", message: "Missing request header." } });
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    void reply.code(status).send({
      error: { code: status >= 500 ? "internal" : "request_error", message: status >= 500 ? "Something went wrong." : (e.message ?? "Request error") },
    });
  });

  app.get("/health", async () => {
    await pool.query("select 1");
    return { ok: true, service: "web" };
  });

  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(meRoutes, { prefix: "/api/me" });
  await app.register(pageRoutes, { prefix: "/api/pages" });
  await app.register(monitorRoutes, { prefix: "/api/monitors" });
  await app.register(webhookRoutes, { prefix: "/api/webhooks" });

  // Built client (SPA) — any non-API path serves index.html.
  const hasClient = fs.existsSync(clientDir);
  if (hasClient) await app.register(fastifyStatic, { root: clientDir, prefix: "/", wildcard: false });
  else logger.warn({ clientDir }, "client build not found; API only");

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: { code: "not_found", message: "No such endpoint." } });
    if (hasClient) return reply.sendFile("index.html");
    return reply.code(404).send("Not found");
  });

  return app;
}

async function main() {
  await runMigrations();
  const app = await buildServer();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    logger.fatal({ err: e }, "server failed to start");
    process.exit(1);
  });
}
