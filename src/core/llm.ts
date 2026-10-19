import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import { conditionSchema, extractSchema, type Rule, ruleSchema, describeRule } from "./rules.js";
import { selectorForId, locateSelector } from "./extract.js";

const client = config.anthropic.apiKey ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Rough list prices per million tokens; only used for the per-user cap and the llm_calls log.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-opus-4-1": { in: 15, out: 75 },
};

function cost(model: string, inTok: number, outTok: number): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-4-5"]!;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

export class LlmUnavailable extends Error {}

// ---------- rule proposal ----------

const proposalToolSchema = {
  type: "object" as const,
  properties: {
    target_kind: { type: "string", enum: ["element", "region", "page"] },
    element_id: { type: "string", description: "The [id] of the element in the outline, when target_kind is element" },
    text_anchor: { type: "string", description: "The exact current text of the target, for relocation if the layout changes" },
    context_before: { type: "string", description: "Short exact text that appears just before the target on the page" },
    context_after: { type: "string", description: "Short exact text that appears just after the target on the page" },
    start_anchor: { type: "string", description: "For region: exact text where the region starts" },
    end_anchor: { type: "string", description: "For region: exact text where the region ends (optional)" },
    extract: { type: "string", enum: ["number", "text", "count", "list"] },
    condition: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["changed", "contains", "not_contains", "less_than", "greater_than", "equals", "new_item"] },
        value: { type: ["string", "number"] },
      },
      required: ["type"],
    },
    summary: { type: "string", description: "One sentence in the user's language: what will be watched and when they will be alerted" },
    observed_value: { type: "string", description: "The value currently on the page for this target" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    cannot_find: { type: "boolean", description: "true when nothing on the page matches what the user asked for" },
    note: { type: "string", description: "Short note for the user when confidence is low or cannot_find is true" },
  },
  required: ["target_kind", "extract", "condition", "summary", "confidence"],
};

const proposalOut = z.object({
  target_kind: z.enum(["element", "region", "page"]),
  element_id: z.string().optional(),
  text_anchor: z.string().optional(),
  context_before: z.string().optional(),
  context_after: z.string().optional(),
  start_anchor: z.string().optional(),
  end_anchor: z.string().optional(),
  extract: extractSchema,
  condition: conditionSchema,
  summary: z.string(),
  observed_value: z.string().optional(),
  confidence: z.number().min(0).max(1),
  cannot_find: z.boolean().optional(),
  note: z.string().optional(),
});

export interface Proposal {
  rule: Rule | null;
  observedValue: string | null;
  confidence: number;
  note: string | null;
  usage: LlmUsage;
}

const SYSTEM = `You turn a user's plain-language request into a precise rule for monitoring one web page.
You receive the page as an outline: one line per text-bearing element, "[id] tag.class: text".
Pick the single element whose text IS the value the user cares about (a price, a stock label, a headline, a date).
For "any change on the page" use target_kind "page". For "a new item appears in a list" pick the element that holds ONE
list entry's title and set extract "list" with condition "new_item" — the selector will be generalised to all entries.
For "a section changes" use target_kind "region" with start/end anchors copied exactly from the page.
Conditions: use less_than/greater_than for numeric thresholds, contains/not_contains for words ("back in stock",
"sold out"), changed when the user wants to know about any change to the value, equals for exact matches.
Always copy anchors and observed_value EXACTLY as they appear in the outline. Write summary in the same language the
user wrote in. If nothing on the page matches, set cannot_find=true and explain briefly in note.`;

export async function proposeRule(input: {
  url: string;
  title: string | null;
  outline: string;
  html: string;
  prompt: string;
}): Promise<Proposal> {
  if (!client) throw new LlmUnavailable("ANTHROPIC_API_KEY is not set");
  const outline = input.outline.slice(0, 48_000);
  const res = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM,
    tools: [{ name: "propose_rule", description: "Propose a monitoring rule", input_schema: proposalToolSchema }],
    tool_choice: { type: "tool", name: "propose_rule" },
    messages: [
      {
        role: "user",
        content: `URL: ${input.url}\nTitle: ${input.title ?? ""}\n\nUser request: ${input.prompt}\n\nPage outline:\n${outline}`,
      },
    ],
  });
  const usage: LlmUsage = {
    model: config.anthropic.model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    costUsd: cost(config.anthropic.model, res.usage.input_tokens, res.usage.output_tokens),
  };
  const block = res.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    return { rule: null, observedValue: null, confidence: 0, note: "The model did not return a rule.", usage };
  }
  const parsed = proposalOut.safeParse(block.input);
  if (!parsed.success) {
    return { rule: null, observedValue: null, confidence: 0, note: "The model returned an unusable rule.", usage };
  }
  const p = parsed.data;
  if (p.cannot_find) {
    return { rule: null, observedValue: null, confidence: p.confidence, note: p.note ?? "Nothing on the page matched that.", usage };
  }

  let rule: Rule | null = null;
  if (p.target_kind === "page") {
    rule = { target: { kind: "page" }, extract: p.extract === "number" ? "text" : p.extract, condition: p.condition, summary: p.summary };
  } else if (p.target_kind === "region" && p.start_anchor) {
    rule = {
      target: { kind: "region", start_anchor: p.start_anchor, end_anchor: p.end_anchor ?? null },
      extract: p.extract,
      condition: p.condition,
      summary: p.summary,
    };
  } else if (p.target_kind === "element" && p.element_id) {
    let css = selectorForId(input.html, p.element_id);
    if (css && (p.extract === "list" || p.condition.type === "new_item")) css = generaliseSelector(css, input.html);
    if (css) {
      rule = {
        target: {
          kind: "selector",
          css,
          text_anchor: p.text_anchor ?? p.observed_value ?? null,
          context_before: p.context_before ?? null,
          context_after: p.context_after ?? null,
        },
        extract: p.extract,
        condition: p.condition,
        summary: p.summary,
      };
    }
  }
  if (!rule) {
    return { rule: null, observedValue: null, confidence: 0, note: "Could not pin the target on the page. Try picking it manually.", usage };
  }
  const safe = ruleSchema.safeParse(rule);
  if (!safe.success) return { rule: null, observedValue: null, confidence: 0, note: "Rule failed validation.", usage };
  if (!safe.data.summary) safe.data.summary = describeRule(safe.data);
  return { rule: safe.data, observedValue: p.observed_value ?? null, confidence: p.confidence, note: p.note ?? null, usage };
}

/** Drop :nth-of-type from the last segment so a selector for one list entry matches all entries. */
export function generaliseSelector(css: string, html: string): string {
  const parts = css.split(" > ");
  for (let i = parts.length - 1; i >= 0; i--) {
    const stripped = parts[i]!.replace(/:nth-of-type\(\d+\)/, "");
    if (stripped !== parts[i]) {
      const candidate = [...parts.slice(0, i), stripped, ...parts.slice(i + 1)].join(" > ");
      const hit = locateSelector(html, candidate);
      if (hit && hit.count > 1) return candidate;
    }
  }
  return css;
}

// ---------- diff judging ----------

export interface Judgement {
  meaningful: boolean;
  summary: string;
  usage: LlmUsage;
}

export async function judgeDiff(input: { summaryOfRule: string; removed: string[]; added: string[] }): Promise<Judgement> {
  if (!client) throw new LlmUnavailable("ANTHROPIC_API_KEY is not set");
  const model = config.anthropic.model;
  const res = await client.messages.create({
    model,
    max_tokens: 300,
    temperature: 0,
    system:
      "You decide whether a change on a monitored web page is meaningful to a person who set up this watch, or just noise (timestamps, counters, ads, session ids, reordering). Reply with the tool call only.",
    tools: [
      {
        name: "judge",
        description: "Judge a page diff",
        input_schema: {
          type: "object",
          properties: {
            meaningful: { type: "boolean" },
            summary: { type: "string", description: "One short sentence describing the change, in the language of the rule" },
          },
          required: ["meaningful", "summary"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "judge" },
    messages: [
      {
        role: "user",
        content: `Rule: ${input.summaryOfRule}\n\nRemoved lines:\n${input.removed.slice(0, 60).join("\n")}\n\nAdded lines:\n${input.added.slice(0, 60).join("\n")}`,
      },
    ],
  });
  const usage: LlmUsage = {
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    costUsd: cost(model, res.usage.input_tokens, res.usage.output_tokens),
  };
  const block = res.content.find((b) => b.type === "tool_use");
  const parsed = z.object({ meaningful: z.boolean(), summary: z.string() }).safeParse(block && block.type === "tool_use" ? block.input : {});
  if (!parsed.success) return { meaningful: true, summary: "The page changed.", usage };
  return { ...parsed.data, usage };
}

// ---------- relocation ----------

export interface Relocation {
  css: string | null;
  observedValue: string | null;
  confidence: number;
  usage: LlmUsage;
}

/** When a selector no longer matches, ask the model to find the same thing on the new page. */
export async function relocateTarget(input: { rule: Rule; lastValue: string | null; outline: string; html: string }): Promise<Relocation> {
  if (!client) throw new LlmUnavailable("ANTHROPIC_API_KEY is not set");
  const model = config.anthropic.model;
  const res = await client.messages.create({
    model,
    max_tokens: 300,
    temperature: 0,
    system:
      "A page's layout changed and a monitoring rule lost its target. Find the element on the new outline that carries the same value the rule watched. Reply with the tool call only.",
    tools: [
      {
        name: "relocate",
        description: "Find the element again",
        input_schema: {
          type: "object",
          properties: {
            element_id: { type: "string" },
            observed_value: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            not_found: { type: "boolean" },
          },
          required: ["confidence"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "relocate" },
    messages: [
      {
        role: "user",
        content: `Rule: ${input.rule.summary}\nLast known value: ${input.lastValue ?? "(unknown)"}\nTarget: ${JSON.stringify(input.rule.target)}\n\nNew page outline:\n${input.outline.slice(0, 48_000)}`,
      },
    ],
  });
  const usage: LlmUsage = {
    model,
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    costUsd: cost(model, res.usage.input_tokens, res.usage.output_tokens),
  };
  const block = res.content.find((b) => b.type === "tool_use");
  const parsed = z
    .object({ element_id: z.string().optional(), observed_value: z.string().optional(), confidence: z.number(), not_found: z.boolean().optional() })
    .safeParse(block && block.type === "tool_use" ? block.input : {});
  if (!parsed.success || parsed.data.not_found || !parsed.data.element_id) return { css: null, observedValue: null, confidence: 0, usage };
  const css = selectorForId(input.html, parsed.data.element_id);
  return { css, observedValue: parsed.data.observed_value ?? null, confidence: parsed.data.confidence, usage };
}
