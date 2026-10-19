import { z } from "zod";
import { locateByAnchor, locateRegion, locateSelector, cleanWs } from "./extract.js";

// ---------- rule shape ----------

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("selector"),
    css: z.string().min(1),
    text_anchor: z.string().nullable().optional(),
    context_before: z.string().nullable().optional(),
    context_after: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("region"),
    start_anchor: z.string().min(1),
    end_anchor: z.string().nullable().optional(),
  }),
  z.object({ kind: z.literal("page") }),
]);

export const extractSchema = z.enum(["number", "text", "count", "list"]);

export const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed") }),
  z.object({ type: z.literal("contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("not_contains"), value: z.string().min(1) }),
  z.object({ type: z.literal("less_than"), value: z.number() }),
  z.object({ type: z.literal("greater_than"), value: z.number() }),
  z.object({ type: z.literal("equals"), value: z.union([z.string(), z.number()]) }),
  z.object({ type: z.literal("new_item") }),
]);

export const ruleSchema = z.object({
  target: targetSchema,
  extract: extractSchema,
  condition: conditionSchema,
  summary: z.string().min(1).max(300),
});

export type Rule = z.infer<typeof ruleSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Condition = z.infer<typeof conditionSchema>;

// ---------- normalisation ----------

const NOISE_LINE = [
  /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i,
  /\bhace\s+\d+\s+(segundo|minuto|hora|día|dia|semana|mes|año)s?\b/i,
  /\b(last )?updated\b/i,
  /\bactualizado\b/i,
  /\b(19|20)\d\d-\d\d-\d\dT\d\d:\d\d/,
  /\b\d{1,2}:\d\d(:\d\d)?\s*(am|pm)?\b/i,
  /\bsession|csrf|token|nonce\b/i,
  /\bviews?\b.*\b\d+\b|\b\d+\b.*\bviews?\b/i,
];

export function isNoiseLine(line: string): boolean {
  return NOISE_LINE.some((re) => re.test(line));
}

export function normaliseText(s: string): string {
  return cleanWs(s)
    .replace(/\b\d+\s+(seconds?|minutes?|hours?|days?)\s+ago\b/gi, "")
    .replace(/\bhace\s+\d+\s+\w+\b/gi, "")
    .trim();
}

/**
 * Parse a number out of a string that may carry currency symbols, thousands separators
 * and either decimal convention. "$1,249.00" → 1249, "1.249,50 €" → 1249.5, "12 999 kr" → 12999.
 */
export function parseNumber(s: string): number | null {
  const m = s.match(/-?\d[\d.,\s\u00a0']*\d|-?\d/);
  if (!m) return null;
  let raw = m[0].replace(/[\s\u00a0']/g, "");
  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the later one is the decimal separator.
    raw = lastComma > lastDot ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  } else if (lastComma !== -1 || lastDot !== -1) {
    const sep = lastComma !== -1 ? "," : ".";
    const count = raw.split(sep).length - 1;
    const after = raw.length - raw.lastIndexOf(sep) - 1;
    // Several separators, or exactly three digits after a single one \u2192 thousands grouping.
    const thousands = count > 1 || after === 3;
    raw = thousands ? raw.split(sep).join("") : raw.replace(sep, ".");
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------- locating + extracting ----------

export interface Observation {
  /** The canonical observed value as stored and compared. */
  value: string;
  number: number | null;
  items: string[];
  located: boolean;
  /** true when the primary locator failed and a fallback anchor found the value */
  relocated: boolean;
}

export function observe(rule: Rule, html: string, text: string): Observation {
  const t = rule.target;
  let items: string[] = [];
  let located = false;
  let relocated = false;

  if (t.kind === "selector") {
    const hit = locateSelector(html, t.css);
    if (hit) {
      located = true;
      items = hit.texts;
    } else {
      const fallback = locateByAnchor(text, t.text_anchor ?? "", t.context_before, t.context_after);
      if (fallback !== null) {
        located = true;
        relocated = true;
        items = [fallback];
      }
    }
  } else if (t.kind === "region") {
    const region = locateRegion(text, t.start_anchor, t.end_anchor ?? null);
    if (region !== null) {
      located = true;
      items = region.split("\n").filter((l) => l.trim().length > 0);
    }
  } else {
    located = true;
    items = text.split("\n").filter((l) => l.trim().length > 0 && !isNoiseLine(l));
  }

  const normalised = items.map(normaliseText).filter(Boolean);
  let value: string;
  let num: number | null = null;
  switch (rule.extract) {
    case "number": {
      const first = normalised.find((s) => parseNumber(s) !== null) ?? normalised[0] ?? "";
      num = parseNumber(first);
      value = num === null ? first : String(num);
      break;
    }
    case "count":
      num = normalised.length;
      value = String(num);
      break;
    case "list":
      value = normalised.join("\n");
      break;
    case "text":
    default:
      value = t.kind === "page" ? normalised.join("\n") : (normalised[0] ?? "");
      break;
  }
  return { value, number: num, items: normalised, located, relocated };
}

// ---------- evaluating ----------

export interface Evaluation {
  /** The value moved compared to the previous observation. */
  moved: boolean;
  /** The condition is satisfied → alert. */
  met: boolean;
  /** One-line human explanation. */
  reason: string;
}

export function evaluate(rule: Rule, current: Observation, previousValue: string | null): Evaluation {
  const moved = previousValue !== null && previousValue !== current.value;
  const c = rule.condition;
  const cur = current.value;
  const num = current.number ?? parseNumber(cur);

  switch (c.type) {
    case "changed":
      return { moved, met: moved, reason: moved ? `Changed from "${short(previousValue)}" to "${short(cur)}"` : "No change" };
    case "contains": {
      const met = cur.toLowerCase().includes(c.value.toLowerCase());
      return { moved, met: met && (moved || previousValue === null), reason: met ? `Now contains "${c.value}"` : `Does not contain "${c.value}"` };
    }
    case "not_contains": {
      const met = !cur.toLowerCase().includes(c.value.toLowerCase());
      return { moved, met: met && (moved || previousValue === null), reason: met ? `No longer contains "${c.value}"` : `Still contains "${c.value}"` };
    }
    case "less_than": {
      const met = num !== null && num < c.value;
      return { moved, met: met && crossed(previousValue, num, (p) => p < c.value), reason: met ? `${num} is below ${c.value}` : `${num ?? cur} is not below ${c.value}` };
    }
    case "greater_than": {
      const met = num !== null && num > c.value;
      return { moved, met: met && crossed(previousValue, num, (p) => p > c.value), reason: met ? `${num} is above ${c.value}` : `${num ?? cur} is not above ${c.value}` };
    }
    case "equals": {
      const met = typeof c.value === "number" ? num === c.value : cur.toLowerCase() === String(c.value).toLowerCase();
      return { moved, met: met && (moved || previousValue === null), reason: met ? `Equals ${c.value}` : `Is "${short(cur)}", not ${c.value}` };
    }
    case "new_item": {
      if (previousValue === null) return { moved, met: false, reason: "First observation" };
      const prev = new Set(previousValue.split("\n"));
      const fresh = current.items.filter((i) => !prev.has(i));
      return { moved, met: fresh.length > 0, reason: fresh.length ? `New: ${short(fresh[0] ?? "")}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ""}` : "No new items" };
    }
  }
}

/** A threshold rule alerts when the condition becomes true, not on every check while it stays true. */
function crossed(previousValue: string | null, _num: number | null, test: (p: number) => boolean): boolean {
  if (previousValue === null) return true;
  const p = parseNumber(previousValue);
  if (p === null) return true;
  return !test(p);
}

function short(s: string | null): string {
  if (!s) return "";
  const one = s.replace(/\n/g, " / ");
  return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

/** Plain-language description of a rule, used when the LLM summary is missing. */
export function describeRule(rule: Rule): string {
  const what =
    rule.target.kind === "page" ? "the page" : rule.target.kind === "region" ? "the selected section" : "the selected element";
  const c = rule.condition;
  switch (c.type) {
    case "changed":
      return `Alert when ${what} changes`;
    case "contains":
      return `Alert when ${what} contains "${c.value}"`;
    case "not_contains":
      return `Alert when ${what} no longer contains "${c.value}"`;
    case "less_than":
      return `Alert when the number in ${what} drops below ${c.value}`;
    case "greater_than":
      return `Alert when the number in ${what} rises above ${c.value}`;
    case "equals":
      return `Alert when ${what} equals ${c.value}`;
    case "new_item":
      return `Alert when a new item appears in ${what}`;
  }
}
