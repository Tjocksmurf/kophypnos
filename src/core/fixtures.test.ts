/**
 * Rule-quality fixtures: synthetic pages that exercise selector building, number parsing,
 * list detection and noise handling without calling the LLM. Add a fixture whenever a real
 * page breaks a rule, then make it pass.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPage, generaliseSelector, locateSelector, selectorForId } from "./extract.js";
import { evaluate, observe, type Rule } from "./rules.js";
import { diffLines } from "./diff.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");

function idOf(outline: string, needle: string): string {
  const line = outline.split("\n").find((l) => l.includes(needle));
  if (!line) throw new Error(`no outline line with ${needle}`);
  return /^\[(\d+)\]/.exec(line)![1]!;
}

describe("product page", () => {
  const html = fixture("product");
  const page = extractPage(html, "https://store.example/p/trail-runner-3");

  it("drops cookie banner, nav, footer, scripts", () => {
    expect(page.text).not.toContain("We use cookies");
    expect(page.text).not.toContain("Sale");
    expect(page.text).not.toContain("__state");
    expect(page.text).not.toContain("Viewed 5,311");
  });

  it("builds a selector that skips hashed classes", () => {
    const id = idOf(page.outline, "€129,95");
    const css = selectorForId(page.html, id)!;
    expect(css).not.toMatch(/css-1x2y3z4/);
    expect(css).toMatch(/price-current/);
    expect(locateSelector(page.html, css)?.text).toBe("€129,95");
  });

  it("parses a European price and fires when it crosses the threshold", () => {
    const rule: Rule = {
      target: { kind: "selector", css: "span.price-current", text_anchor: "€129,95", context_before: "Price" },
      extract: "number",
      condition: { type: "less_than", value: 100 },
      summary: "price below 100",
    };
    const o = observe(rule, page.html, page.text);
    expect(o.number).toBe(129.95);
    expect(evaluate(rule, o, null).met).toBe(false);
    const cheaper = extractPage(html.replace("€129,95", "€99,00"), "https://store.example");
    const o2 = observe(rule, cheaper.html, cheaper.text);
    expect(o2.number).toBe(99);
    expect(evaluate(rule, o2, "129.95").met).toBe(true);
  });

  it("stock text: contains fires once", () => {
    const rule: Rule = {
      target: { kind: "selector", css: "p.availability" },
      extract: "text",
      condition: { type: "contains", value: "in stock" },
      summary: "back in stock",
    };
    const o = observe(rule, page.html, page.text);
    expect(o.value).toBe("Only 3 left in stock");
    expect(evaluate(rule, o, "Sold out").met).toBe(true);
    expect(evaluate(rule, o, "Only 5 left in stock").met).toBe(false);
  });

  it("relocates by anchor when a class is renamed", () => {
    const rule: Rule = {
      target: { kind: "selector", css: "span.price-current", text_anchor: "€129,95", context_before: "Price", context_after: "€159,95" },
      extract: "number",
      condition: { type: "changed" },
      summary: "price changes",
    };
    const renamed = extractPage(html.replace("price-current", "price-now"), "https://store.example");
    const o = observe(rule, renamed.html, renamed.text);
    expect(o.located).toBe(true);
    expect(o.relocated).toBe(true);
    expect(o.number).toBe(129.95);
  });
});

describe("listing page", () => {
  const html = fixture("listing");
  const page = extractPage(html, "https://inmuebles.example/manabi");

  it("generalises a single card selector to all cards", () => {
    const id = idOf(page.outline, "Lote en San Jacinto");
    const one = selectorForId(page.html, id)!;
    expect(locateSelector(page.html, one)?.count).toBe(1);
    const all = generaliseSelector(one, page.html);
    expect(locateSelector(page.html, all)?.count).toBe(3);
  });

  it("new_item fires only for genuinely new entries, in any order", () => {
    const rule: Rule = {
      target: { kind: "selector", css: "ul.results > li.card > a.card-title" },
      extract: "list",
      condition: { type: "new_item" },
      summary: "nuevo terreno",
    };
    const before = observe(rule, page.html, page.text);
    expect(before.items).toHaveLength(3);
    // reordered, nothing new
    const reordered = extractPage(
      html.replace(/<li class="card"><a class="card-title" href="\/t\/101">.*?<\/li>\n/, "").replace("</ul>", '<li class="card"><a class="card-title" href="/t/101">Terreno frente al mar, Crucita, 800 m²</a><span class="card-price">$ 45.000</span></li></ul>'),
      "https://x",
    );
    const same = observe(rule, reordered.html, reordered.text);
    expect(evaluate(rule, same, before.value).met).toBe(false);
    // one new
    const added = extractPage(html.replace("</ul>", '<li class="card"><a class="card-title" href="/t/104">Casa con terreno, Manta</a><span class="card-price">$ 120.000</span></li></ul>'), "https://x");
    const ev = evaluate(rule, observe(rule, added.html, added.text), before.value);
    expect(ev.met).toBe(true);
    expect(ev.reason).toContain("Casa con terreno");
  });

  it("count extract tracks the number of results", () => {
    const rule: Rule = { target: { kind: "selector", css: "li.card" }, extract: "count", condition: { type: "greater_than", value: 3 }, summary: "more than 3" };
    const o = observe(rule, page.html, page.text);
    expect(o.value).toBe("3");
    expect(evaluate(rule, o, null).met).toBe(false);
  });

  it("parses dotted thousands prices", () => {
    const rule: Rule = { target: { kind: "selector", css: "li.card:nth-of-type(1) span.card-price" }, extract: "number", condition: { type: "changed" }, summary: "" };
    expect(observe(rule, page.html, page.text).number).toBe(45000);
  });
});

describe("news page noise", () => {
  const html = fixture("news");
  const page = extractPage(html, "https://harbour.example/notices");
  const pageRule: Rule = { target: { kind: "page" }, extract: "text", condition: { type: "changed" }, summary: "any change" };

  it("ignores clocks, relative times and view counters", () => {
    const later = extractPage(
      html.replace("14:02:11", "14:07:40").replace("3 hours ago · 412 views", "3 hours ago · 419 views").replace("1 day ago · 98 views", "1 day ago · 101 views"),
      "https://harbour.example/notices",
    );
    const a = observe(pageRule, page.html, page.text);
    const b = observe(pageRule, later.html, later.text);
    expect(a.value).toBe(b.value);
    expect(evaluate(pageRule, b, a.value).met).toBe(false);
  });

  it("catches a real new notice and the diff names it", () => {
    const added = extractPage(html.replace("<main>", '<main><article class="notice"><h2 class="headline">Storm warning tonight</h2><p>Secure all vessels.</p></article>'), "https://x");
    const a = observe(pageRule, page.html, page.text);
    const b = observe(pageRule, added.html, added.text);
    expect(evaluate(pageRule, b, a.value).met).toBe(true);
    const d = diffLines(a.value, b.value);
    expect(d.added).toContain("Storm warning tonight");
    expect(d.removed).toHaveLength(0);
  });

  it("headline rule only fires on the headline", () => {
    const rule: Rule = { target: { kind: "selector", css: "article.notice:nth-of-type(1) h2.headline" }, extract: "text", condition: { type: "changed" }, summary: "" };
    const o = observe(rule, page.html, page.text);
    expect(o.value).toBe("Marina closed for dredging until Friday");
  });
});
