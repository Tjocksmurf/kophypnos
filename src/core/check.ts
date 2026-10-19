import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchPage } from "./fetch.js";
import { extractPage } from "./extract.js";
import { evaluate, observe, ruleSchema, type Rule } from "./rules.js";
import { diffLines, summariseDiff } from "./diff.js";
import { judgeDiff, relocateTarget, LlmUnavailable, type LlmUsage } from "./llm.js";
import { createMagicLink, notifyUser } from "./notify.js";
import { nextRunAt } from "./schedule.js";

const { monitors, rules, checks, snapshots, changes, users, llmCalls } = schema;

type Outcome = "unchanged" | "changed" | "changed_no_alert" | "stale" | "blocked" | "error";

export interface CheckResult {
  outcome: Outcome;
  value: string | null;
  alerted: boolean;
  error?: string;
}

const MAX_CONSECUTIVE_ERRORS = 20;
const NOTIFY_AFTER_ERRORS = 3;
const NOTIFY_AFTER_BLOCKS = 3;

/** Run one check for a monitor end to end. Safe to call from the worker or from "check now". */
export async function runCheck(monitorId: string, opts: { manual?: boolean } = {}): Promise<CheckResult> {
  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) });
  if (!monitor) return { outcome: "error", value: null, alerted: false, error: "Monitor not found" };
  const user = await db.query.users.findFirst({ where: eq(users.id, monitor.userId) });
  if (!user || user.deletedAt) return { outcome: "error", value: null, alerted: false, error: "User not found" };
  const ruleRow = await db.query.rules.findFirst({ where: and(eq(rules.monitorId, monitorId), eq(rules.active, true)) });
  const parsedRule = ruleRow ? ruleSchema.safeParse(ruleRow.json) : null;
  if (!ruleRow || !parsedRule?.success) return { outcome: "error", value: null, alerted: false, error: "No valid rule" };
  let rule: Rule = parsedRule.data;

  const [checkRow] = await db.insert(checks).values({ monitorId }).returning({ id: checks.id });
  const checkId = checkRow!.id;
  const log = logger.child({ monitorId, checkId });

  const finish = async (patch: Partial<typeof checks.$inferInsert>, mpatch: Partial<typeof monitors.$inferInsert>, result: CheckResult) => {
    await db.update(checks).set({ finishedAt: new Date(), ...patch }).where(eq(checks.id, checkId));
    const next = opts.manual
      ? {}
      : { nextRunAt: nextRunAt(monitor.interval, new Date(), { timezone: user.timezone, dailyAt: monitor.dailyAt }) };
    await db
      .update(monitors)
      .set({ lastCheckedAt: new Date(), lastOutcome: result.outcome, ...next, ...mpatch })
      .where(eq(monitors.id, monitorId));
    return result;
  };

  // ---- fetch (with one in-run retry for network errors / 5xx)
  let fetched = await fetchPage(monitor.url, { etag: monitor.etag, lastModified: monitor.lastModified });
  if (fetched.status === "error" && (fetched.httpStatus === null || fetched.httpStatus >= 500)) {
    await sleep(10_000);
    fetched = await fetchPage(monitor.url, { etag: monitor.etag, lastModified: monitor.lastModified });
  }

  if (fetched.status === "not_modified") {
    return finish(
      { outcome: "unchanged", httpStatus: 304, fetchMs: fetched.ms, observedValue: monitor.lastValue },
      { consecutiveErrors: 0, consecutiveBlocks: 0 },
      { outcome: "unchanged", value: monitor.lastValue, alerted: false },
    );
  }

  if (fetched.status === "blocked") {
    const blocks = monitor.consecutiveBlocks + 1;
    if (blocks === NOTIFY_AFTER_BLOCKS) {
      await notifyProblem(user.id, monitor.id, monitor.title ?? monitor.host, "the site is blocking automated checks");
    }
    return finish(
      { outcome: "blocked", httpStatus: fetched.httpStatus, fetchMs: fetched.ms, error: "blocked" },
      { consecutiveBlocks: blocks },
      { outcome: "blocked", value: monitor.lastValue, alerted: false },
    );
  }

  if (fetched.status === "error") {
    const errors = monitor.consecutiveErrors + 1;
    const mpatch: Partial<typeof monitors.$inferInsert> = { consecutiveErrors: errors };
    if (errors === NOTIFY_AFTER_ERRORS) {
      await notifyProblem(user.id, monitor.id, monitor.title ?? monitor.host, fetched.error ?? "fetch failed");
    }
    if (errors >= MAX_CONSECUTIVE_ERRORS) {
      mpatch.status = "paused_error";
      await notifyProblem(user.id, monitor.id, monitor.title ?? monitor.host, "paused after repeated errors; open to resume");
    }
    return finish(
      { outcome: "error", httpStatus: fetched.httpStatus, fetchMs: fetched.ms, error: fetched.error },
      mpatch,
      { outcome: "error", value: monitor.lastValue, alerted: false, error: fetched.error },
    );
  }

  // ---- extract + observe
  const page = extractPage(fetched.html, fetched.finalUrl);
  let obs = observe(rule, page.html, page.text);

  // ---- relocation when the selector is gone
  if (!obs.located && rule.target.kind === "selector") {
    try {
      const rel = await relocateTarget({ rule, lastValue: monitor.lastValue, outline: page.outline, html: page.html });
      await logLlm(user.id, monitor.id, "relocate", rel.usage);
      if (rel.css && rel.confidence >= 0.7) {
        const newRule: Rule = { ...rule, target: { ...rule.target, css: rel.css, text_anchor: rel.observedValue ?? rule.target.text_anchor } };
        const retry = observe(newRule, page.html, page.text);
        if (retry.located && plausible(monitor.lastValue, retry.value, rule)) {
          rule = newRule;
          obs = { ...retry, relocated: true };
          await db
            .update(rules)
            .set({ json: newRule, version: ruleRow.version + 1 })
            .where(eq(rules.id, ruleRow.id));
          log.info({ css: rel.css }, "rule relocated");
        }
      }
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) log.warn({ err: e }, "relocation failed");
    }
  }

  if (!obs.located) {
    const wasStale = monitor.status === "stale";
    if (!wasStale) {
      await notifyProblem(user.id, monitor.id, monitor.title ?? monitor.host, "the page layout changed and the rule may be stale");
    }
    return finish(
      { outcome: "stale", httpStatus: fetched.httpStatus, fetchMs: fetched.ms, textHash: page.textHash, error: "target not found" },
      { status: "stale", consecutiveErrors: 0, consecutiveBlocks: 0 },
      { outcome: "stale", value: monitor.lastValue, alerted: false },
    );
  }

  // ---- evaluate
  const ev = evaluate(rule, obs, monitor.lastValue);
  let summary = ev.reason;
  let met = ev.met;

  // Page-level rules: small diffs get a second opinion before alerting.
  if (rule.target.kind === "page" && ev.moved) {
    const prev = await db.query.snapshots.findFirst({ where: and(eq(snapshots.monitorId, monitorId), eq(snapshots.kind, "latest")) });
    const d = diffLines(prev?.readableText ?? monitor.lastValue ?? "", page.text);
    if (d.added.length === 0 && d.removed.length === 0) {
      met = false;
      summary = "Only noise changed";
    } else {
      summary = summariseDiff(d);
      if (d.ratio < 0.05) {
        try {
          const j = await judgeDiff({ summaryOfRule: rule.summary, removed: d.removed, added: d.added });
          await logLlm(user.id, monitor.id, "judge", j.usage);
          met = j.meaningful;
          summary = j.summary;
        } catch (e) {
          if (!(e instanceof LlmUnavailable)) log.warn({ err: e }, "judge failed");
        }
      }
    }
  }

  // ---- snapshots: rotate latest → previous
  await db.transaction(async (tx) => {
    await tx.delete(snapshots).where(and(eq(snapshots.monitorId, monitorId), eq(snapshots.kind, "previous")));
    await tx
      .update(snapshots)
      .set({ kind: "previous", html: null })
      .where(and(eq(snapshots.monitorId, monitorId), eq(snapshots.kind, "latest")));
    await tx.insert(snapshots).values({ monitorId, kind: "latest", readableText: page.text, html: page.html });
  });

  const moved = ev.moved;
  const outcome: Outcome = met ? "changed" : moved ? "changed_no_alert" : "unchanged";
  const mpatch: Partial<typeof monitors.$inferInsert> = {
    consecutiveErrors: 0,
    consecutiveBlocks: 0,
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    title: monitor.title ?? page.title,
    faviconUrl: monitor.faviconUrl ?? page.faviconUrl,
  };
  if (monitor.status === "stale") mpatch.status = "active";
  if (moved || monitor.lastValue === null) {
    mpatch.lastValue = obs.value;
    mpatch.previousValue = monitor.lastValue;
  }

  let alerted = false;
  if (moved || met) {
    await db.insert(changes).values({
      monitorId,
      checkId,
      oldValue: monitor.lastValue,
      newValue: obs.value,
      summary,
      alerted: false,
    });
  }

  if (met && monitor.lastValue !== null) {
    const tooSoon = monitor.lastAlertAt && Date.now() - monitor.lastAlertAt.getTime() < config.limits.minAlertGapMs;
    if (!tooSoon) {
      const link = await createMagicLink(user.id, monitor.id);
      const res = await notifyUser(user.id, "change_alert", { title: monitor.title ?? monitor.host, summary, link }, { monitorId });
      alerted = res.sent;
      if (res.sent) {
        mpatch.lastAlertAt = new Date();
        await db.update(changes).set({ alerted: true }).where(and(eq(changes.monitorId, monitorId), eq(changes.checkId, checkId)));
      }
    } else {
      log.info("alert suppressed: inside min gap");
    }
  }

  return finish(
    { outcome, httpStatus: fetched.httpStatus, fetchMs: fetched.ms, observedValue: obs.value, textHash: page.textHash },
    mpatch,
    { outcome, value: obs.value, alerted },
  );
}

/** Guard against the relocator picking something wildly different (e.g. a price of 12 where it was 1249). */
function plausible(lastValue: string | null, candidate: string, rule: Rule): boolean {
  if (lastValue === null) return true;
  if (rule.extract === "number") {
    const a = Number(lastValue);
    const b = Number(candidate);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    if (a === 0) return true;
    return Math.abs(b - a) / Math.abs(a) <= 0.5;
  }
  return true;
}

async function notifyProblem(userId: string, monitorId: string, title: string, reason: string): Promise<void> {
  const link = await createMagicLink(userId, monitorId);
  await notifyUser(userId, "monitor_problem", { title, reason, link }, { monitorId, bypassQuietHours: true });
}

export async function logLlm(userId: string | null, monitorId: string | null, purpose: "rule" | "judge" | "relocate", usage: LlmUsage): Promise<void> {
  await db.insert(llmCalls).values({
    userId,
    monitorId,
    purpose,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
