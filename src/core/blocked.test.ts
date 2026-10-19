import { describe, expect, it } from "vitest";
import { looksBlocked } from "./blocked.js";

const bigPage = (inner: string) => `<html><body>${inner}${"<p>Waxed cotton jacket, 4 500 kr.</p>".repeat(1000)}</body></html>`;

describe("looksBlocked", () => {
  it("treats 403 and 429 as blocked", () => {
    expect(looksBlocked("", 403)).toBe(true);
    expect(looksBlocked("", 429)).toBe(true);
  });

  it("does not treat a plain 503 as blocked", () => {
    expect(looksBlocked("<html><body>Service Unavailable</body></html>", 503)).toBe(false);
  });

  it("detects the Akamai challenge served with 200", () => {
    const html = `<!DOCTYPE html><html><body><script src="/frpPiif39/x?v=1"></script><div id="sec-if-cpt-container" role="main"></div></body></html>`;
    expect(looksBlocked(html, 200)).toBe(true);
  });

  it("detects a Cloudflare interstitial", () => {
    expect(looksBlocked("<html><head><title>Just a moment...</title></head></html>", 503)).toBe(true);
  });

  it("detects a small Access Denied page", () => {
    expect(looksBlocked("<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18</BODY></HTML>", 200)).toBe(true);
  });

  it("ignores a captcha widget on a full page", () => {
    expect(looksBlocked(bigPage(`<form><div class="g-recaptcha" data-sitekey="x"></div></form>`), 200)).toBe(false);
  });

  it("ignores 'Just a moment...' in ordinary copy", () => {
    expect(looksBlocked(bigPage("<p>Just a moment... and your order ships.</p>"), 200)).toBe(false);
  });
});
