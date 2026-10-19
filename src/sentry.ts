import * as Sentry from "@sentry/node";
import { config } from "./config.js";

/** Initialise Sentry when SENTRY_DSN is set; a no-op otherwise. Call before anything else in an entry point. */
export function initSentry(service: "web" | "worker"): void {
  if (!config.sentryDsn) return;
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.env,
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? undefined,
    tracesSampleRate: 0.05,
    initialScope: { tags: { service } },
  });
}

export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  if (!config.sentryDsn) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) scope.setTag(k, String(v));
    Sentry.captureException(err);
  });
}

export { Sentry };
