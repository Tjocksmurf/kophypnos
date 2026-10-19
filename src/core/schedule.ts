export type Interval = "30m" | "1h" | "1d";

const INTERVAL_MS: Record<Interval, number> = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

export function intervalMs(interval: Interval): number {
  return INTERVAL_MS[interval];
}

/** Random ±10% jitter so monitors on the same host do not line up. */
export function jitter(ms: number, rand: () => number = Math.random): number {
  return Math.round(ms * (0.9 + rand() * 0.2));
}

/**
 * Next run time. For daily monitors this is the next occurrence of `dailyAt` (minutes from midnight)
 * in the user's timezone, converted to UTC at scheduling time so DST shifts are handled per run.
 */
export function nextRunAt(
  interval: Interval,
  from: Date,
  opts: { timezone?: string; dailyAt?: number | null; rand?: () => number } = {},
): Date {
  if (interval !== "1d") return new Date(from.getTime() + jitter(intervalMs(interval), opts.rand));
  const tz = opts.timezone ?? "UTC";
  const minutes = opts.dailyAt ?? 8 * 60;
  const todayLocal = localDate(from, tz);
  let candidate = zonedTime(todayLocal.year, todayLocal.month, todayLocal.day, minutes, tz);
  if (candidate.getTime() <= from.getTime() + 60_000) {
    const next = new Date(Date.UTC(todayLocal.year, todayLocal.month - 1, todayLocal.day + 1));
    candidate = zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), minutes, tz);
  }
  // Small positive jitter (0–5 min) so all 08:00 monitors don't fire at once.
  return new Date(candidate.getTime() + Math.floor((opts.rand ?? Math.random)() * 5 * 60 * 1000));
}

function localDate(d: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Build a UTC Date for the given wall-clock time in a timezone (two-pass offset correction). */
export function zonedTime(year: number, month: number, day: number, minutes: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const offset1 = tzOffsetMs(new Date(guess), tz);
  const utc1 = guess - offset1;
  const offset2 = tzOffsetMs(new Date(utc1), tz);
  return new Date(guess - offset2);
}

function tzOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Is `now` inside the user's quiet window (minutes from local midnight, may wrap past midnight)? */
export function inQuietHours(now: Date, tz: string, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const m = get("hour") * 60 + get("minute");
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** When does the current quiet window end (UTC)? Only meaningful if inQuietHours is true. */
export function quietHoursEnd(now: Date, tz: string, end: number): Date {
  const today = localDate(now, tz);
  let candidate = zonedTime(today.year, today.month, today.day, end, tz);
  if (candidate.getTime() <= now.getTime()) {
    const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    candidate = zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), end, tz);
  }
  return candidate;
}
