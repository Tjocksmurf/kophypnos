import { describe, expect, it } from "vitest";
import { evaluate, observe, parseNumber, type Rule } from "./rules.js";
import { extractPage, selectorForId, locateSelector } from "./extract.js";
import { diffLines } from "./diff.js";
import { isPrivateAddress, parseUrl } from "./url.js";
import { nextRunAt, inQuietHours, zonedTime } from "./schedule.js";

describe("parseNumber", () => {
  it("handles currencies and separators", () => {
    expect(parseNumber("$1,249.00")).toBe(1249);
    expect(parseNumber("1.249,50 €")).toBe(1249.5);
    expect(parseNumber("12 999 kr")).toBe(12999);
    expect(parseNumber("US$ 249")).toBe(249);
    expect(parseNumber("12,50")).toBe(12.5);
    expect(parseNumber("1.249")).toBe(1249);
    expect(parseNumber("3.5 kg")).toBe(3.5);
    expect(parseNumber("1,234,567")).toBe(1234567);
    expect(parseNumber("no digits")).toBeNull();
  });
});

const PAGE = `<!doctype html><html><head><title>Sony WH-1000XM5 | Shop</title>
<link rel="icon" href="/fav.png"></head><body>
<nav>Home | Deals</nav>
<script>var x=1</script>
<div class="product">
  <h1>Sony WH-1000XM5</h1>
  <div class="price-box"><span class="label">Price</span> <span class="price">$249.00</span></div>
  <p class="stock">In stock</p>
  <button>Add to cart</button>
</div>
<ul class="related">
  <li class="item"><a href="/a">Alpha</a></li>
  <li class="item"><a href="/b">Beta</a></li>
</ul>
<footer>© 2026</footer>
<p class="updated">Updated 3 minutes ago</p>
</body></html>`;

describe("extractPage", () => {
  const page = extractPage(PAGE, "https://shop.example.com/p/1");
  it("gets title and favicon", () => {
    expect(page.title).toBe("Sony WH-1000XM5 | Shop");
    expect(page.faviconUrl).toBe("https://shop.example.com/fav.png");
  });
  it("drops nav/script/footer and keeps content", () => {
    expect(page.text).not.toContain("Home | Deals");
    expect(page.text).not.toContain("var x");
    expect(page.text).toContain("$249.00");
  });
  it("produces an outline with ids and stable selectors", () => {
    const line = page.outline.split("\n").find((l) => l.includes("$249.00"));
    expect(line).toBeDefined();
    const id = /^\[(\d+)\]/.exec(line!)![1]!;
    const css = selectorForId(page.html, id)!;
    expect(css).toContain("span.price");
    expect(locateSelector(page.html, css)?.text).toBe("$249.00");
  });
});

describe("observe + evaluate", () => {
  const page = extractPage(PAGE, "https://shop.example.com/p/1");
  const priceRule: Rule = {
    target: { kind: "selector", css: "span.price", text_anchor: "$249.00", context_before: "Price", context_after: "Add to cart" },
    extract: "number",
    condition: { type: "less_than", value: 200 },
    summary: "Alert when the price drops below $200",
  };

  it("observes a number", () => {
    const o = observe(priceRule, page.html, page.text);
    expect(o.located).toBe(true);
    expect(o.number).toBe(249);
    expect(o.value).toBe("249");
  });

  it("alerts only when the threshold is crossed", () => {
    const o = observe(priceRule, page.html, page.text);
    expect(evaluate(priceRule, o, null).met).toBe(false);
    const cheaper = extractPage(PAGE.replace("$249.00", "$189.00"), "https://shop.example.com/p/1");
    const o2 = observe(priceRule, cheaper.html, cheaper.text);
    expect(evaluate(priceRule, o2, "249").met).toBe(true);
    // already below: no repeat alert
    expect(evaluate(priceRule, o2, "190").met).toBe(false);
  });

  it("falls back to the text anchor when the selector breaks", () => {
    const moved = extractPage(PAGE.replace('class="price"', 'class="amount"'), "https://x.com");
    const o = observe(priceRule, moved.html, moved.text);
    expect(o.located).toBe(true);
    expect(o.relocated).toBe(true);
    expect(o.number).toBe(249);
  });

  it("detects new list items", () => {
    const listRule: Rule = {
      target: { kind: "selector", css: "ul.related > li.item" },
      extract: "list",
      condition: { type: "new_item" },
      summary: "New related item",
    };
    const o1 = observe(listRule, page.html, page.text);
    expect(o1.items).toEqual(["Alpha", "Beta"]);
    const more = extractPage(PAGE.replace("</ul>", '<li class="item"><a href="/c">Gamma</a></li></ul>'), "https://x.com");
    const o2 = observe(listRule, more.html, more.text);
    const ev = evaluate(listRule, o2, o1.value);
    expect(ev.met).toBe(true);
    expect(ev.reason).toContain("Gamma");
  });

  it("contains fires once on transition", () => {
    const stockRule: Rule = {
      target: { kind: "selector", css: "p.stock" },
      extract: "text",
      condition: { type: "contains", value: "in stock" },
      summary: "Back in stock",
    };
    const o = observe(stockRule, page.html, page.text);
    expect(evaluate(stockRule, o, "Sold out").met).toBe(true);
    expect(evaluate(stockRule, o, "In stock").met).toBe(false);
  });

  it("page rules ignore noise lines", () => {
    const pageRule: Rule = { target: { kind: "page" }, extract: "text", condition: { type: "changed" }, summary: "Any change" };
    const o1 = observe(pageRule, page.html, page.text);
    const later = extractPage(PAGE.replace("3 minutes ago", "9 minutes ago"), "https://x.com");
    const o2 = observe(pageRule, later.html, later.text);
    expect(o1.value).toBe(o2.value);
  });
});

describe("diffLines", () => {
  it("reports added and removed lines and a ratio", () => {
    const d = diffLines("a\nb\nc", "a\nc\nd");
    expect(d.removed).toEqual(["b"]);
    expect(d.added).toEqual(["d"]);
    expect(d.ratio).toBeCloseTo(2 / 6);
  });
});

describe("url guard", () => {
  it("normalises and strips tracking params", () => {
    const u = parseUrl("example.com/p?utm_source=x&id=5#top");
    expect(u.toString()).toBe("https://example.com/p?id=5");
  });
  it("refuses bad schemes", () => {
    expect(() => parseUrl("ftp://example.com")).toThrow();
  });
  it("flags private addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
});

describe("schedule", () => {
  it("jitters hourly runs within ±10%", () => {
    const from = new Date("2026-10-19T12:00:00Z");
    const next = nextRunAt("1h", from, { rand: () => 0.5 });
    expect(next.getTime() - from.getTime()).toBe(60 * 60 * 1000);
    const lo = nextRunAt("30m", from, { rand: () => 0 });
    expect(lo.getTime() - from.getTime()).toBe(27 * 60 * 1000);
  });
  it("schedules daily at local time", () => {
    const from = new Date("2026-10-19T14:00:00Z"); // 09:00 in Guayaquil
    const next = nextRunAt("1d", from, { timezone: "America/Guayaquil", dailyAt: 8 * 60, rand: () => 0 });
    expect(next.toISOString()).toBe("2026-10-20T13:00:00.000Z");
    const earlier = new Date("2026-10-19T12:00:00Z"); // 07:00 local → today at 08:00
    expect(nextRunAt("1d", earlier, { timezone: "America/Guayaquil", dailyAt: 8 * 60, rand: () => 0 }).toISOString()).toBe(
      "2026-10-19T13:00:00.000Z",
    );
  });
  it("handles DST zones", () => {
    expect(zonedTime(2026, 7, 1, 8 * 60, "Europe/Stockholm").toISOString()).toBe("2026-07-01T06:00:00.000Z");
    expect(zonedTime(2026, 1, 1, 8 * 60, "Europe/Stockholm").toISOString()).toBe("2026-01-01T07:00:00.000Z");
  });
  it("quiet hours wrap past midnight", () => {
    const night = new Date("2026-10-19T04:00:00Z"); // 23:00 Guayaquil
    expect(inQuietHours(night, "America/Guayaquil", 22 * 60, 7 * 60)).toBe(true);
    const day = new Date("2026-10-19T17:00:00Z"); // 12:00
    expect(inQuietHours(day, "America/Guayaquil", 22 * 60, 7 * 60)).toBe(false);
  });
});
