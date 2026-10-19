import { config } from "../config.js";
import { assertPublicHost, parseUrl, UrlError } from "./url.js";
import { looksBlocked } from "./blocked.js";

export type FetchStatus = "ok" | "not_modified" | "thin" | "blocked" | "error";

export interface FetchResult {
  status: FetchStatus;
  httpStatus: number | null;
  finalUrl: string;
  html: string;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  ms: number;
  error?: string;
}

export interface FetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  acceptLanguage?: string;
  timeoutMs?: number;
}

export { looksBlocked };

/**
 * Fetch a page with a browser-like request, a size cap, redirect limit and SSRF checks on every hop.
 * Never throws for HTTP-level problems; returns status "error" / "blocked" instead.
 */
export async function fetchPage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? config.fetch.timeoutMs;
  let url: URL;
  try {
    url = parseUrl(rawUrl);
  } catch (e) {
    return fail(rawUrl, started, e instanceof Error ? e.message : "Invalid URL");
  }

  const headers: Record<string, string> = {
    "user-agent": config.fetch.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": opts.acceptLanguage ?? "en-US,en;q=0.9,es;q=0.8",
    "cache-control": "no-cache",
  };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    try {
      await assertPublicHost(current);
    } catch (e) {
      return fail(current.toString(), started, e instanceof UrlError ? e.message : "Refused host");
    }
    let res: Response;
    try {
      res = await fetch(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "TimeoutError" ? "Timed out" : e.message) : "Fetch failed";
      return fail(current.toString(), started, msg);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop === 3) return fail(current.toString(), started, "Too many redirects", res.status);
      try {
        current = new URL(location, current);
      } catch {
        return fail(current.toString(), started, "Bad redirect", res.status);
      }
      continue;
    }

    if (res.status === 304) {
      return {
        status: "not_modified",
        httpStatus: 304,
        finalUrl: current.toString(),
        html: "",
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        contentType: res.headers.get("content-type"),
        ms: Date.now() - started,
      };
    }

    const contentType = res.headers.get("content-type");
    let html: string;
    try {
      html = await readCapped(res, config.fetch.maxBytes);
    } catch (e) {
      return fail(current.toString(), started, e instanceof Error ? e.message : "Read failed", res.status);
    }

    const base = {
      httpStatus: res.status,
      finalUrl: current.toString(),
      html,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentType,
      ms: Date.now() - started,
    };

    if (looksBlocked(html, res.status)) return { status: "blocked", ...base };
    if (res.status >= 400) return { status: "error", error: `HTTP ${res.status}`, ...base };
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
      return { status: "error", error: `Not an HTML page (${contentType.split(";")[0]})`, ...base };
    }
    return { status: "ok", ...base };
  }
  return fail(current.toString(), started, "Too many redirects");
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        break;
      }
      chunks.push(value);
    }
  }
  const buf = Buffer.concat(chunks);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return buf.toString("utf-8");
  }
}

function fail(finalUrl: string, started: number, error: string, httpStatus: number | null = null): FetchResult {
  return {
    status: "error",
    error,
    httpStatus,
    finalUrl,
    html: "",
    etag: null,
    lastModified: null,
    contentType: null,
    ms: Date.now() - started,
  };
}
