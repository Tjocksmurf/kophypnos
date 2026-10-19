import { initSentry, captureError } from "./sentry.js";
initSentry("worker");
import http from "node:http";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { closeDb, db, pool, runMigrations } from "./db/index.js";
import { runCheck } from "./core/check.js";
import { flushDigests } from "./core/notify.js";
import { intervalMs } from "./core/schedule.js";
import { closeBrowser } from "./core/browser.js";

const log = logger.child({ service: "worker" });
let stopping = false;
let lastLoopAt = Date.now();

interface Due {
  id: string;
  host: string;
  interval: "30m" | "1h" | "1d";
}

/**
 * Claim a batch of due monitors. next_run_at is pushed forward inside the same transaction so a crash
 * mid-run never double-fires; the real next_run_at is set again when the check finishes.
 */
async function claimDue(limit: number): Promise<Due[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      select id, host, interval from monitors
      where status in ('active', 'stale') and next_run_at <= now()
      order by next_run_at
      limit ${limit}
      for update skip locked
    `);
    const due = rows.rows as unknown as Due[];
    if (due.length === 0) return [];
    const ids = due.map((d) => d.id);
    // Push far enough that a slow check can't be re-claimed by the next poll; finish() will correct it.
    await tx.execute(sql`
      update monitors set next_run_at = now() + interval '10 minutes'
      where id in ${ids}
    `);
    return due;
  });
}

async function runBatch(due: Due[]): Promise<void> {
  // Space checks against the same host by ≥5 s: group by host, then run groups concurrently.
  const byHost = new Map<string, Due[]>();
  for (const d of due) byHost.set(d.host, [...(byHost.get(d.host) ?? []), d]);
  const groups = [...byHost.values()];
  await pooled(groups, config.worker.concurrency, async (group) => {
    for (let i = 0; i < group.length; i++) {
      const m = group[i]!;
      const started = Date.now();
      try {
        const r = await runCheck(m.id);
        log.info({ monitorId: m.id, outcome: r.outcome, alerted: r.alerted, ms: Date.now() - started }, "check");
      } catch (e) {
        log.error({ err: e, monitorId: m.id }, "check crashed");
        captureError(e, { monitorId: m.id });
        const minutes = Math.round(intervalMs(m.interval) / 60000);
        await db.execute(sql`update monitors set next_run_at = now() + (${minutes} * interval '1 minute') where id = ${m.id}`);
      }
      if (i < group.length - 1) await sleep(5000);
    }
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length && !stopping) {
      const item = items[idx++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function loop(): Promise<void> {
  while (!stopping) {
    lastLoopAt = Date.now();
    try {
      const due = await claimDue(50);
      if (due.length) {
        log.info({ n: due.length }, "due monitors");
        await runBatch(due);
      }
      const flushed = await flushDigests();
      if (flushed) log.info({ flushed }, "digests sent");
      await housekeeping();
    } catch (e) {
      log.error({ err: e }, "loop error");
      captureError(e, { where: "loop" });
    }
    await sleep(config.worker.pollMs);
  }
}

let lastHousekeeping = 0;
async function housekeeping(): Promise<void> {
  if (Date.now() - lastHousekeeping < 6 * 3600 * 1000) return;
  lastHousekeeping = Date.now();
  await db.execute(sql`delete from checks where started_at < now() - interval '90 days'`);
  await db.execute(sql`delete from previews where created_at < now() - interval '1 day'`);
  await db.execute(sql`delete from login_codes where created_at < now() - interval '1 day'`);
  await db.execute(sql`delete from magic_tokens where expires_at < now() - interval '7 days'`);
  await db.execute(sql`delete from sessions where expires_at < now()`);
  await db.execute(sql`delete from changes where created_at < now() - interval '1 year'`);
  await db.execute(sql`delete from notifications where created_at < now() - interval '1 year'`);
  log.info("housekeeping done");
}

function startHealthServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    try {
      const oldest = await db.execute(sql`select min(next_run_at) as t from monitors where status in ('active','stale')`);
      const t = (oldest.rows[0] as { t: Date | string | null } | undefined)?.t;
      const lagMs = t ? Date.now() - new Date(t).getTime() : 0;
      const loopAge = Date.now() - lastLoopAt;
      const ok = loopAge < config.worker.pollMs * 4 && lagMs < 15 * 60 * 1000;
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, service: "worker", loop_age_ms: loopAge, oldest_due_lag_ms: Math.max(0, lagMs) }));
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  });
  server.listen(config.port, "0.0.0.0", () => log.info({ port: config.port }, "worker health endpoint up"));
  return server;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  await runMigrations();
  await pool.query("select 1");
  const health = startHealthServer();
  log.info({ concurrency: config.worker.concurrency, pollMs: config.worker.pollMs }, "worker started");
  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker stopping");
    stopping = true;
    health.close();
    await closeBrowser();
    setTimeout(async () => {
      await closeDb();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  await loop();
  await closeDb();
}

main().catch((e) => {
  log.fatal({ err: e }, "worker failed");
  process.exit(1);
});
