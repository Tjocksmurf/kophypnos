import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, count, sum } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { fetchPage } from "../core/fetch.js";
import { fetchWithBrowser } from "../core/browser.js";
import { extractPage, selectorForId, locateSelector } from "../core/extract.js";
import { parseUrl, UrlError } from "../core/url.js";
import { proposeRule, LlmUnavailable } from "../core/llm.js";
import { conditionSchema, describeRule, observe, ruleSchema, type Rule } from "../core/rules.js";
import { logLlm } from "../core/check.js";
import { logger } from "../logger.js";

const { previews, llmCalls } = schema;

export const EXCERPT_CHARS = 2500;

export async function pageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.requireUser);

  // ---- preview: fetch a URL and keep the page around for rule creation
  app.post("/preview", { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } }, async (req, reply) => {
    const body = z.object({ url: z.string().min(4).max(2000) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Paste a URL." } });
    let url: URL;
    try {
      url = parseUrl(body.data.url);
    } catch (e) {
      return reply.code(400).send({ error: { code: "bad_url", message: e instanceof UrlError ? e.message : "Invalid URL." } });
    }
    let fetched = await fetchPage(url.toString());
    if (fetched.status === "error" || fetched.status === "not_modified") {
      return reply.code(422).send({
        error: { code: "fetch_failed", message: fetched.error ?? "Could not fetch that page.", http_status: fetched.httpStatus },
      });
    }
    let page = extractPage(fetched.html, fetched.finalUrl);
    let needsBrowser = false;
    // Thin static DOM → the content is probably rendered client-side; try a headless browser once.
    if (fetched.status === "ok" && page.text.length < 200) {
      const rendered = await fetchWithBrowser(fetched.finalUrl);
      if (rendered.status === "ok") {
        const rpage = extractPage(rendered.html, rendered.finalUrl);
        if (rpage.text.length > page.text.length * 2 && rpage.text.length >= 200) {
          fetched = rendered;
          page = rpage;
          needsBrowser = true;
        }
      }
    }
    const fetchStatus = fetched.status === "blocked" ? "blocked" : page.text.length < 200 ? "thin" : "ok";
    const [row] = await db
      .insert(previews)
      .values({
        userId: req.user!.id,
        url: fetched.finalUrl,
        host: new URL(fetched.finalUrl).hostname,
        title: page.title,
        faviconUrl: page.faviconUrl,
        readableText: page.text,
        html: page.html,
        httpStatus: fetched.httpStatus,
        fetchStatus,
        needsBrowser,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      })
      .returning({ id: previews.id });
    return {
      preview_id: row!.id,
      url: fetched.finalUrl,
      title: page.title,
      favicon_url: page.faviconUrl,
      excerpt: page.text.slice(0, EXCERPT_CHARS),
      text_length: page.text.length,
      fetch_status: fetchStatus,
      needs_browser: needsBrowser,
      http_status: fetched.httpStatus,
      fetch_ms: fetched.ms,
      message:
        fetchStatus === "blocked"
          ? "This site seems to block automated checks. You can still try, but checks may fail."
          : fetchStatus === "thin"
            ? "This page has very little readable text. It may load its content with JavaScript in a way that can't be rendered here."
            : needsBrowser
              ? "This page renders in the browser, so it's checked with a headless browser: hourly or daily only."
              : null,
    };
  });

  // ---- propose a rule from a sentence
  app.post("/propose", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
    const body = z.object({ preview_id: z.string(), prompt: z.string().min(2).max(500) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Describe what to watch for." } });
    const preview = await db.query.previews.findFirst({ where: and(eq(previews.id, body.data.preview_id), eq(previews.userId, req.user!.id)) });
    if (!preview) return reply.code(404).send({ error: { code: "not_found", message: "That preview has expired. Paste the URL again." } });

    const cap = await llmCapExceeded(req.user!.id);
    if (cap) return reply.code(429).send({ error: { code: "llm_cap", message: "You've reached today's limit for rule proposals. Try again tomorrow or pick the target manually." } });

    // Re-derive the outline from stored html (cheap) so the LLM sees ids that map to selectors.
    const page = extractPage(`<html><body>${preview.html}</body></html>`, preview.url);
    try {
      const p = await proposeRule({ url: preview.url, title: preview.title, outline: page.outline, html: page.html, prompt: body.data.prompt });
      await logLlm(req.user!.id, null, "rule", p.usage);
      if (!p.rule) return reply.send({ rule: null, note: p.note, confidence: p.confidence });
      const obs = observe(p.rule, page.html, page.text);
      return reply.send({
        rule: p.rule,
        summary: p.rule.summary || describeRule(p.rule),
        observed_value: obs.located ? obs.value : (p.observedValue ?? null),
        observed_items: obs.items.slice(0, 20),
        located: obs.located,
        confidence: p.confidence,
        note: p.note,
        highlight: highlightFor(p.rule, obs.items[0] ?? p.observedValue ?? null),
      });
    } catch (e) {
      if (e instanceof LlmUnavailable) {
        return reply.code(503).send({ error: { code: "llm_unavailable", message: "Rule suggestions are not available right now. Pick the target manually." } });
      }
      logger.error({ err: e }, "propose failed");
      return reply.code(502).send({ error: { code: "llm_error", message: "Couldn't work out a rule. Try rewording, or pick the target manually." } });
    }
  });

  // ---- manual rule: the user picked a line of the excerpt (region) or an element id
  app.post("/manual", async (req, reply) => {
    const body = z
      .object({
        preview_id: z.string(),
        text: z.string().min(1).max(500).optional(),
        element_id: z.string().optional(),
        extract: z.enum(["number", "text", "count", "list"]).default("text"),
        condition: conditionSchema.default({ type: "changed" }),
        whole_page: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: { code: "bad_request", message: "Pick something to watch." } });
    const preview = await db.query.previews.findFirst({ where: and(eq(previews.id, body.data.preview_id), eq(previews.userId, req.user!.id)) });
    if (!preview) return reply.code(404).send({ error: { code: "not_found", message: "That preview has expired. Paste the URL again." } });
    const page = extractPage(`<html><body>${preview.html}</body></html>`, preview.url);

    let rule: Rule;
    if (body.data.whole_page) {
      rule = { target: { kind: "page" }, extract: "text", condition: { type: "changed" }, summary: "Alert when anything on the page changes" };
    } else if (body.data.element_id) {
      const css = selectorForId(page.html, body.data.element_id);
      if (!css) return reply.code(400).send({ error: { code: "bad_element", message: "That element could not be found." } });
      const hit = locateSelector(page.html, css);
      rule = {
        target: { kind: "selector", css, text_anchor: hit?.text ?? null },
        extract: body.data.extract,
        condition: body.data.condition,
        summary: "",
      };
      rule.summary = describeRule(rule);
    } else if (body.data.text) {
      const line = page.text.split("\n").find((l) => l.includes(body.data.text!.trim())) ?? body.data.text.trim();
      rule = {
        target: { kind: "region", start_anchor: line, end_anchor: null },
        extract: body.data.extract,
        condition: body.data.condition,
        summary: "",
      };
      rule.summary = describeRule(rule);
    } else {
      return reply.code(400).send({ error: { code: "bad_request", message: "Pick something to watch." } });
    }
    const safe = ruleSchema.safeParse(rule);
    if (!safe.success) return reply.code(400).send({ error: { code: "bad_rule", message: "That rule isn't valid." } });
    const obs = observe(safe.data, page.html, page.text);
    return reply.send({
      rule: safe.data,
      summary: safe.data.summary,
      observed_value: obs.located ? obs.value : null,
      observed_items: obs.items.slice(0, 20),
      located: obs.located,
      confidence: 1,
      note: null,
      highlight: highlightFor(safe.data, obs.items[0] ?? null),
    });
  });

  // ---- outline for manual picking (element ids + text)
  app.get("/:id/outline", async (req, reply) => {
    const { id } = req.params as { id: string };
    const preview = await db.query.previews.findFirst({ where: and(eq(previews.id, id), eq(previews.userId, req.user!.id)) });
    if (!preview) return reply.code(404).send({ error: { code: "not_found", message: "Preview expired." } });
    const page = extractPage(`<html><body>${preview.html}</body></html>`, preview.url);
    const items = page.outline
      .split("\n")
      .slice(0, 400)
      .map((l) => {
        const m = /^\[(\d+)\] ([^:]+): (.*)$/.exec(l);
        return m ? { id: m[1], label: m[2], text: m[3] } : null;
      })
      .filter(Boolean);
    return { items };
  });
}

function highlightFor(rule: Rule, observed: string | null): string | null {
  if (rule.target.kind === "selector") return rule.target.text_anchor ?? observed;
  if (rule.target.kind === "region") return rule.target.start_anchor;
  return null;
}

async function llmCapExceeded(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [row] = await db
    .select({ n: count(), usd: sum(llmCalls.costUsd) })
    .from(llmCalls)
    .where(and(eq(llmCalls.userId, userId), eq(llmCalls.purpose, "rule"), gte(llmCalls.createdAt, since)));
  if ((row?.n ?? 0) >= config.limits.proposalsPerDay) return true;
  return Number(row?.usd ?? 0) >= config.anthropic.dailyCapUsd;
}
