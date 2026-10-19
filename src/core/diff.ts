import { isNoiseLine } from "./rules.js";

export interface LineDiff {
  removed: string[];
  added: string[];
  /** share of lines that changed, 0..1, against the larger side */
  ratio: number;
}

/** Line-set diff: good enough for "what changed" on a page, cheap, order-insensitive. */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.split("\n").filter((l) => l.trim() && !isNoiseLine(l));
  const b = after.split("\n").filter((l) => l.trim() && !isNoiseLine(l));
  const aSet = new Map<string, number>();
  for (const l of a) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  const bSet = new Map<string, number>();
  for (const l of b) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [l, n] of aSet) {
    const m = bSet.get(l) ?? 0;
    for (let i = 0; i < n - m; i++) removed.push(l);
  }
  for (const [l, n] of bSet) {
    const m = aSet.get(l) ?? 0;
    for (let i = 0; i < n - m; i++) added.push(l);
  }
  const denom = Math.max(a.length, b.length, 1);
  return { removed, added, ratio: (removed.length + added.length) / (2 * denom) };
}

export function summariseDiff(d: LineDiff): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`+ ${short(d.added[0]!)}${d.added.length > 1 ? ` (+${d.added.length - 1} more)` : ""}`);
  if (d.removed.length) parts.push(`− ${short(d.removed[0]!)}${d.removed.length > 1 ? ` (+${d.removed.length - 1} more)` : ""}`);
  return parts.join("  ") || "The page changed.";
}

function short(s: string): string {
  return s.length > 70 ? `${s.slice(0, 67)}…` : s;
}
