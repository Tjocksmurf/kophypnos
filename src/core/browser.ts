/**
 * Headless-browser fallback for pages that render their content with JavaScript.
 * Playwright is imported lazily so the web service (which never needs it) starts without Chromium,
 * and the worker degrades gracefully when the browser isn't installed.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { assertPublicHost, parseUrl } from "./url.js";
import { looksBlocked, type FetchResult } from "./fetch.js";

type Browser = import("playwright").Browser;

let browserPromise: Promise<Browser | null> | null = null;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function getBrowser(): Promise<Browser | null> {
  if (!browserPromise) {
    browserPromise = (async () => {
      try {
        const { chromium } = await import("playwright");
        const b = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
        b.on("disconnected", () => {
          browserPromise = null;
        });
        return b;
      } catch (e) {
        logger.warn({ err: e }, "playwright unavailable; browser fetches disabled");
        return null;
      }
    })();
  }
  return browserPromise;
}

export async function browserAvailable(): Promise<boolean> {
  return (await getBrowser()) !== null;
}

async function acquire(): Promise<void> {
  if (inFlight < config.worker.browserConcurrency) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((r) => waiters.push(r));
  inFlight += 1;
}

function release(): void {
  inFlight -= 1;
  waiters.shift()?.();
}

/** Render the page in Chromium and return its DOM as HTML. Same result shape as fetchPage. */
export async function fetchWithBrowser(rawUrl: string, opts: { timeoutMs?: number } = {}): Promise<FetchResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const fail = (error: string, httpStatus: number | null = null): FetchResult => ({
    status: "error",
    error,
    httpStatus,
    finalUrl: rawUrl,
    html: "",
    etag: null,
    lastModified: null,
    contentType: null,
    ms: Date.now() - started,
  });

  let url: URL;
  try {
    url = parseUrl(rawUrl);
    await assertPublicHost(url);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Invalid URL");
  }
  const browser = await getBrowser();
  if (!browser) return fail("Headless browser is not available");

  await acquire();
  const context = await browser.newContext({
    userAgent: config.fetch.userAgent,
    locale: "en-US",
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
  });
  try {
    // Block heavy, irrelevant resources; keep scripts/xhr so the content renders.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      const target = route.request().url();
      if (["image", "media", "font"].includes(type)) return route.abort();
      try {
        const host = new URL(target).hostname;
        if (/doubleclick|googlesyndication|google-analytics|googletagmanager|facebook\.net|hotjar|segment\.io/.test(host)) return route.abort();
      } catch {
        /* ignore */
      }
      return route.continue();
    });
    const page = await context.newPage();
    let httpStatus: number | null = null;
    const resp = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    httpStatus = resp?.status() ?? null;
    // A short settle for client-side rendering; networkidle can hang on pages that poll.
    await page.waitForLoadState("networkidle", { timeout: Math.min(8_000, timeoutMs) }).catch(() => undefined);
    const html = await page.content();
    const finalUrl = page.url();
    const base = {
      httpStatus,
      finalUrl,
      html,
      etag: null,
      lastModified: null,
      contentType: "text/html",
      ms: Date.now() - started,
    };
    if (looksBlocked(html, httpStatus)) return { status: "blocked", ...base };
    if (httpStatus !== null && httpStatus >= 400) return { status: "error", error: `HTTP ${httpStatus}`, ...base };
    return { status: "ok", ...base };
  } catch (e) {
    return fail(e instanceof Error ? (e.name === "TimeoutError" ? "Timed out rendering the page" : e.message) : "Browser fetch failed");
  } finally {
    await context.close().catch(() => undefined);
    release();
  }
}

export async function closeBrowser(): Promise<void> {
  const b = browserPromise ? await browserPromise : null;
  await b?.close().catch(() => undefined);
  browserPromise = null;
}
