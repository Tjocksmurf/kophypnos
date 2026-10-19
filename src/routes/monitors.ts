import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq, count } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { ruleSchema, observe, describeRule } from "../core/rules.js";
import { nextRunAt } from "../core/schedule.js";
import { runCheck, logLlm } from "../core/check.js";
import { extractPage } from "../core/extract.js";
import { proposeRule, LlmUnavailable } from "../core/llm.js";
import { logger } from "../logger.js";

const { monitors, rules, previews, changes, checks, snapshots } = schema;

const intervalSchema = z.enum(["30m", "1h", "1d"]);

export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireUser);

  // ---- create
  app.post("/", async (req, reply) => {
    const body = z
      .object({
        preview_id: z.string(),
        rule: ruleSchema,
        interval: intervalSchema.default("1h"),
        daily_at: z.number().int().min(0).max(1439).optional(),
        confidence: z.number().min(0).max(1).optional(),
        created_by: z.enum(["llm", "user"]).default("llm"),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Invalid monitor." } });
    const user = req.user!;
    const preview = await db.query.previews.findFirst({ where: and(eq(previews.id, body.data.preview_id), eq(previews.userId, user.id)) });
    if (!preview) return reply.code(404).send({ error: { code: "not_found", message: "That preview has expired. Paste the URL again." } });

    // Limits
    const mine = await db.select({ interval: monitors.interval }).from(monitors).where(eq(monitors.userId, user.id));
    if (mine.length >= config.limits.monitorsPerUser) {
      return reply.code(403).send({ error: { code: "limit", message: `You can have up to ${config.limits.monitorsPerUser} monitors.` } });
    }
    if (body.data.interval === "30m" && mine.filter((m) => m.interval === "30m").length >= config.limits.fastMonitorsPerUser) {
      return reply.code(403).send({ error: { code: "limit", message: `Up to ${config.limits.fastMonitorsPerUser} monitors can run every 30 minutes.` } });
    }

    const page = extractPage(`<html><body>${preview.html}</body></html>`, preview.url);
    const obs = observe(body.data.rule, page.html, page.text);
    const summary = body.data.rule.summary || describeRule(body.data.rule);

    const created = await db.transaction(async (tx) => {
      const [m] = await tx
        .insert(monitors)
        .values({
          userId: user.id,
          url: preview.url,
          host: preview.host,
          title: preview.title,
          faviconUrl: preview.faviconUrl,
          interval: body.data.interval,
          dailyAt: body.data.interval === "1d" ? (body.data.daily_at ?? 8 * 60) : null,
          nextRunAt: new Date(), // first check right away
          lastValue: obs.located ? obs.value : null,
          etag: preview.etag,
          lastModified: preview.lastModified,
        })
        .returning();
      await tx.insert(rules).values({
        monitorId: m!.id,
        json: body.data.rule,
        summary,
        confidence: body.data.confidence ?? null,
        createdBy: body.data.created_by,
        approvedAt: new Date(),
      });
      await tx.insert(snapshots).values({ monitorId: m!.id, kind: "latest", readableText: page.text, html: page.html });
      await tx.delete(previews).where(eq(previews.id, preview.id));
      return m!;
    });
    // The worker picks it up within a poll; the UI polls the monitor for the first result.
    return reply.code(201).send({ monitor: await serialise(created.id) });
  });

  // ---- list
  app.get("/", async (req) => {
    const rows = await db.query.monitors.findMany({ where: eq(monitors.userId, req.user!.id), orderBy: [desc(monitors.createdAt)] });
    const out = [];
    for (const m of rows) {
      const rule = await db.query.rules.findFirst({ where: and(eq(rules.monitorId, m.id), eq(rules.active, true)) });
      out.push(summarise(m, rule));
    }
    return { monitors: out };
  });

  // ---- detail
  app.get("/:id", async (req, reply) => {
    const m = await owned(req.user!.id, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "Monitor not found." } });
    return { monitor: await serialise(m.id) };
  });

  // ---- update
  app.patch("/:id", async (req, reply) => {
    const m = await owned(req.user!.id, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "Monitor not found." } });
    const body = z
      .object({
        interval: intervalSchema.optional(),
        daily_at: z.number().int().min(0).max(1439).nullable().optional(),
        status: z.enum(["active", "paused"]).optional(),
        rule: ruleSchema.optional(),
        title: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Invalid update." } });
    const patch: Partial<typeof monitors.$inferInsert> = {};
    const d = body.data;
    if (d.title) patch.title = d.title;
    if (d.interval || d.daily_at !== undefined) {
      const interval = d.interval ?? m.interval;
      if (interval === "30m" && m.interval !== "30m") {
        const [fast] = await db.select({ n: count() }).from(monitors).where(and(eq(monitors.userId, req.user!.id), eq(monitors.interval, "30m")));
        if ((fast?.n ?? 0) >= config.limits.fastMonitorsPerUser) {
          return reply.code(403).send({ error: { code: "limit", message: `Up to ${config.limits.fastMonitorsPerUser} monitors can run every 30 minutes.` } });
        }
      }
      patch.interval = interval;
      patch.dailyAt = interval === "1d" ? (d.daily_at ?? m.dailyAt ?? 8 * 60) : null;
      patch.nextRunAt = nextRunAt(interval, new Date(), { timezone: req.user!.timezone, dailyAt: patch.dailyAt });
    }
    if (d.status === "paused") patch.status = "paused";
    if (d.status === "active") {
      patch.status = "active";
      patch.consecutiveErrors = 0;
      patch.consecutiveBlocks = 0;
      patch.nextRunAt = new Date();
    }
    if (d.rule) {
      const summary = d.rule.summary || describeRule(d.rule);
      const current = await db.query.rules.findFirst({ where: and(eq(rules.monitorId, m.id), eq(rules.active, true)) });
      await db.transaction(async (tx) => {
        await tx.update(rules).set({ active: false }).where(eq(rules.monitorId, m.id));
        await tx.insert(rules).values({
          monitorId: m.id,
          version: (current?.version ?? 0) + 1,
          json: d.rule,
          summary,
          createdBy: "user",
          approvedAt: new Date(),
        });
      });
      // Re-baseline against the latest snapshot so the new rule doesn't fire on its first run.
      const snap = await db.query.snapshots.findFirst({ where: and(eq(snapshots.monitorId, m.id), eq(snapshots.kind, "latest")) });
      if (snap) {
        const obs = observe(d.rule, snap.html ?? "", snap.readableText);
        patch.lastValue = obs.located ? obs.value : null;
        patch.previousValue = null;
      }
      if (m.status === "stale") patch.status = "active";
    }
    await db.update(monitors).set(patch).where(eq(monitors.id, m.id));
    return { monitor: await serialise(m.id) };
  });

  // ---- check now
  app.post("/:id/check", async (req, reply) => {
    const m = await owned(req.user!.id, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "Monitor not found." } });
    if (m.lastCheckedAt && Date.now() - m.lastCheckedAt.getTime() < config.limits.checkNowGapMs) {
      return reply.code(429).send({ error: { code: "too_soon", message: "Checked less than a minute ago." } });
    }
    const result = await runCheck(m.id, { manual: true });
    return { result, monitor: await serialise(m.id) };
  });

  // ---- re-derive the rule against the latest snapshot
  app.post("/:id/repropose", async (req, reply) => {
    const m = await owned(req.user!.id, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "Monitor not found." } });
    const current = await db.query.rules.findFirst({ where: and(eq(rules.monitorId, m.id), eq(rules.active, true)) });
    const snap = await db.query.snapshots.findFirst({ where: and(eq(snapshots.monitorId, m.id), eq(snapshots.kind, "latest")) });
    if (!current || !snap?.html) return reply.code(409).send({ error: { code: "no_snapshot", message: "No recent page to work from. Run a check first." } });
    const body = z.object({ prompt: z.string().min(2).max(500).optional() }).safeParse(req.body ?? {});
    const page = extractPage(`<html><body>${snap.html}</body></html>`, m.url);
    try {
      const p = await proposeRule({ url: m.url, title: m.title, outline: page.outline, html: page.html, prompt: body.success && body.data.prompt ? body.data.prompt : current.summary });
      await logLlm(req.user!.id, m.id, "rule", p.usage);
      if (!p.rule) return reply.send({ rule: null, note: p.note, confidence: p.confidence });
      const obs = observe(p.rule, page.html, page.text);
      return reply.send({ rule: p.rule, summary: p.rule.summary, observed_value: obs.located ? obs.value : null, located: obs.located, confidence: p.confidence, note: p.note });
    } catch (e) {
      if (e instanceof LlmUnavailable) return reply.code(503).send({ error: { code: "llm_unavailable", message: "Rule suggestions are not available right now." } });
      logger.error({ err: e }, "repropose failed");
      return reply.code(502).send({ error: { code: "llm_error", message: "Couldn't work out a new rule." } });
    }
  });

  // ---- delete
  app.delete("/:id", async (req, reply) => {
    const m = await owned(req.user!.id, (req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: { code: "not_found", message: "Monitor not found." } });
    await db.delete(monitors).where(eq(monitors.id, m.id));
    return { ok: true };
  });
}

async function owned(userId: string, id: string) {
  return db.query.monitors.findFirst({ where: and(eq(monitors.id, id), eq(monitors.userId, userId)) });
}

function summarise(m: schema.Monitor, rule: schema.Rule | undefined) {
  return {
    id: m.id,
    url: m.url,
    host: m.host,
    title: m.title ?? m.host,
    favicon_url: m.faviconUrl,
    status: m.status,
    interval: m.interval,
    daily_at: m.dailyAt,
    rule_summary: rule?.summary ?? null,
    last_checked_at: m.lastCheckedAt,
    last_outcome: m.lastOutcome,
    last_alert_at: m.lastAlertAt,
    last_value: m.lastValue,
    previous_value: m.previousValue,
    next_run_at: m.nextRunAt,
    consecutive_errors: m.consecutiveErrors,
    consecutive_blocks: m.consecutiveBlocks,
    created_at: m.createdAt,
  };
}

async function serialise(id: string) {
  const m = (await db.query.monitors.findFirst({ where: eq(monitors.id, id) }))!;
  const rule = await db.query.rules.findFirst({ where: and(eq(rules.monitorId, id), eq(rules.active, true)) });
  const history = await db.query.changes.findMany({ where: eq(changes.monitorId, id), orderBy: [desc(changes.createdAt)], limit: 50 });
  const lastCheck = await db.query.checks.findFirst({ where: eq(checks.monitorId, id), orderBy: [desc(checks.startedAt)] });
  return {
    ...summarise(m, rule),
    rule: rule?.json ?? null,
    rule_version: rule?.version ?? null,
    rule_confidence: rule?.confidence ?? null,
    last_error: lastCheck?.error ?? null,
    last_http_status: lastCheck?.httpStatus ?? null,
    changes: history.map((c) => ({ id: c.id, old_value: c.oldValue, new_value: c.newValue, summary: c.summary, alerted: c.alerted, created_at: c.createdAt })),
  };
}
