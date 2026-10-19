export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "fetch",
    },
    credentials: "same-origin",
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

// ---------- types mirrored from the server ----------

export interface User {
  id: string;
  phone: string;
  timezone: string;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  whatsapp_opted_out: boolean;
  plan: "free" | "paid";
}

export type Interval = "30m" | "1h" | "1d";
export type MonitorStatus = "active" | "paused" | "paused_error" | "stale";
export type Outcome = "unchanged" | "changed" | "changed_no_alert" | "stale" | "blocked" | "error";

export interface Condition {
  type: "changed" | "contains" | "not_contains" | "less_than" | "greater_than" | "equals" | "new_item";
  value?: string | number;
}

export interface Rule {
  target:
    | { kind: "selector"; css: string; text_anchor?: string | null; context_before?: string | null; context_after?: string | null }
    | { kind: "region"; start_anchor: string; end_anchor?: string | null }
    | { kind: "page" };
  extract: "number" | "text" | "count" | "list";
  condition: Condition;
  summary: string;
}

export interface MonitorSummary {
  id: string;
  url: string;
  host: string;
  title: string;
  favicon_url: string | null;
  status: MonitorStatus;
  interval: Interval;
  daily_at: number | null;
  rule_summary: string | null;
  last_checked_at: string | null;
  last_outcome: Outcome | null;
  last_alert_at: string | null;
  last_value: string | null;
  previous_value: string | null;
  next_run_at: string;
  needs_browser: boolean;
  consecutive_errors: number;
  consecutive_blocks: number;
  created_at: string;
}

export interface Change {
  id: string;
  old_value: string | null;
  new_value: string | null;
  summary: string | null;
  alerted: boolean;
  created_at: string;
}

export interface MonitorDetail extends MonitorSummary {
  rule: Rule | null;
  rule_version: number | null;
  rule_confidence: number | null;
  last_error: string | null;
  last_http_status: number | null;
  changes: Change[];
}

export interface Preview {
  preview_id: string;
  url: string;
  title: string | null;
  favicon_url: string | null;
  excerpt: string;
  text_length: number;
  fetch_status: "ok" | "thin" | "blocked";
  needs_browser: boolean;
  http_status: number | null;
  message: string | null;
}

export interface Proposal {
  rule: Rule | null;
  summary?: string;
  observed_value?: string | null;
  observed_items?: string[];
  located?: boolean;
  confidence: number;
  note: string | null;
  highlight?: string | null;
}
