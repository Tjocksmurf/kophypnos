import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { createHash } from "node:crypto";

export const PM_ID = "data-pm-id";

const DROP_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "svg",
  "canvas",
  "video",
  "audio",
  "object",
  "embed",
  "link",
  "meta",
  "nav",
  "footer",
  "header nav",
  "[aria-hidden='true']",
  "[hidden]",
  "[role='dialog']",
  "[role='alertdialog']",
  "[id*='cookie' i]",
  "[class*='cookie' i]",
  "[id*='consent' i]",
  "[class*='consent' i]",
  "[class*='gdpr' i]",
  "[id*='newsletter-popup' i]",
  ".sr-only",
  ".visually-hidden",
  ".skip-link",
].join(",");

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "aside", "header", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "td", "th", "dl", "dt", "dd", "blockquote",
  "pre", "figure", "figcaption", "form", "fieldset", "label", "address", "hr", "br", "summary", "details",
]);

export interface ExtractedPage {
  title: string | null;
  faviconUrl: string | null;
  /** Body HTML after cleaning, with data-pm-id on every text-bearing element. */
  html: string;
  /** Plain readable text, block-separated by newlines. */
  text: string;
  /** Compact outline for the LLM: one line per text-bearing element. */
  outline: string;
  textHash: string;
  elementCount: number;
}

export function extractPage(rawHtml: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(rawHtml, { xml: false });
  const title = cleanWs($("title").first().text()) || cleanWs($("h1").first().text()) || null;
  const faviconUrl = findFavicon($, pageUrl);

  $(DROP_SELECTORS).remove();
  $("*").each((_, node) => {
    // Strip attributes we never need; keeps the stored html small and selectors stable.
    if (node.type !== "tag") return;
    const el = node as Element;
    const attribs = el.attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (!["id", "class", "href", "src", "alt", "title", "name", "type", "value", "datetime", "itemprop", "data-testid", "aria-label"].includes(name)) {
        delete el.attribs[name];
      }
    }
  });

  let counter = 0;
  const lines: string[] = [];
  $("body")
    .find("*")
    .each((_, node) => {
      if (counter >= 2000 || node.type !== "tag") return;
      const el = node as Element;
      const own = ownText($, el);
      if (!own) return;
      counter += 1;
      const id = String(counter);
      $(el).attr(PM_ID, id);
      const tag = el.tagName.toLowerCase();
      const cls = (el.attribs?.class ?? "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
      const label = cls ? `${tag}.${cls}` : tag;
      lines.push(`[${id}] ${label}: ${own.slice(0, 200)}`);
    });

  const text = toText($, $("body"));
  const html = $("body").html() ?? "";
  return {
    title,
    faviconUrl,
    html,
    text,
    outline: lines.join("\n"),
    textHash: hashText(text),
    elementCount: counter,
  };
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function cleanWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Text directly inside an element (its own text nodes), not descendants. */
function ownText($: CheerioAPI, el: Element): string {
  let out = "";
  for (const child of el.children) {
    if (child.type === "text") out += (child as { data: string }).data;
  }
  return cleanWs(out);
}

/** Readable text with newlines between block-level elements. */
export function toText($: CheerioAPI, root: Cheerio<AnyNode>): string {
  const parts: string[] = [];
  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      parts.push((node as { data: string }).data.replace(/\s+/g, " "));
      return;
    }
    if (node.type !== "tag") return;
    const el = node as Element;
    const block = BLOCK_TAGS.has(el.tagName.toLowerCase());
    if (block) parts.push("\n");
    for (const c of el.children) walk(c);
    if (block) parts.push("\n");
  };
  root.each((_, n) => walk(n));
  return parts
    .join("")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l.length > 0 && l !== arr[i - 1])
    .join("\n");
}

function findFavicon($: CheerioAPI, pageUrl: string): string | null {
  const candidates = [
    $("link[rel='icon']").attr("href"),
    $("link[rel='shortcut icon']").attr("href"),
    $("link[rel='apple-touch-icon']").attr("href"),
  ].filter(Boolean) as string[];
  const href = candidates[0] ?? "/favicon.ico";
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

// ---------- selectors ----------

const DYNAMIC_CLASS = /\d{3,}|^(css|sc|jsx|emotion|chakra)-|^[a-z]{1,3}[-_][a-z0-9]{5,}$/i;

/** Build a CSS selector for the element carrying data-pm-id=id, unique within the document. */
export function selectorForId(html: string, id: string): string | null {
  const $ = cheerio.load(`<body>${html}</body>`);
  const target = $(`[${PM_ID}="${id}"]`).first() as Cheerio<Element>;
  if (target.length === 0) return null;
  return buildSelector($, target);
}

export function buildSelector($: CheerioAPI, target: Cheerio<Element>): string {
  const parts: string[] = [];
  let node = target;
  while (node.length && node[0]!.tagName.toLowerCase() !== "body" && node[0]!.tagName.toLowerCase() !== "html") {
    const el = node[0]!;
    const tag = el.tagName.toLowerCase();
    let part = tag;
    const idAttr = el.attribs?.id;
    if (idAttr && /^[A-Za-z_][\w-]*$/.test(idAttr) && !DYNAMIC_CLASS.test(idAttr) && $(`#${cssEscape(idAttr)}`).length === 1) {
      parts.unshift(`#${cssEscape(idAttr)}`);
      break;
    }
    const classes = (el.attribs?.class ?? "")
      .split(/\s+/)
      .filter((c) => c && !DYNAMIC_CLASS.test(c))
      .slice(0, 2);
    if (classes.length) part += classes.map((c) => `.${cssEscape(c)}`).join("");
    const parent = node.parent();
    const sameTag = parent.children(tag);
    if (sameTag.length > 1) {
      const idx = sameTag.index(node) + 1;
      part += `:nth-of-type(${idx})`;
    }
    parts.unshift(part);
    const candidate = parts.join(" > ");
    if ($(candidate).length === 1) return candidate;
    node = parent as Cheerio<Element>;
  }
  return parts.join(" > ");
}

function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, "\\$1");
}

export interface Located {
  text: string;
  count: number;
  texts: string[];
}

/** Find a selector in cleaned HTML and return its text(s). */
export function locateSelector(html: string, selector: string): Located | null {
  const $ = cheerio.load(`<body>${html}</body>`);
  let matched: Cheerio<AnyNode>;
  try {
    matched = $(selector);
  } catch {
    return null;
  }
  if (matched.length === 0) return null;
  const texts = matched.map((_, el) => cleanWs($(el).text())).get();
  return { text: texts[0] ?? "", count: matched.length, texts };
}

/** Fallback: find a text anchor (with optional surrounding context) in the readable text. */
export function locateByAnchor(text: string, anchor: string, before?: string | null, after?: string | null): string | null {
  if (!anchor) return null;
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(anchor));
  if (idx === -1) {
    // try the context: find the line after `before`
    if (before) {
      const b = lines.findIndex((l) => l.includes(before));
      if (b !== -1 && lines[b + 1]) return lines[b + 1]!;
    }
    if (after) {
      const a = lines.findIndex((l) => l.includes(after));
      if (a > 0) return lines[a - 1]!;
    }
    return null;
  }
  return lines[idx]!;
}

/** Text between two anchors in the readable text (region rules). */
export function locateRegion(text: string, startAnchor: string, endAnchor: string | null): string | null {
  const start = text.indexOf(startAnchor);
  if (start === -1) return null;
  if (!endAnchor) return text.slice(start, start + 2000).trim();
  const end = text.indexOf(endAnchor, start + startAnchor.length);
  if (end === -1) return text.slice(start, start + 2000).trim();
  return text.slice(start, end).trim();
}
