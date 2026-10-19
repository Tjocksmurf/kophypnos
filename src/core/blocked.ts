/**
 * Bot-wall detection. Strong markers only appear on challenge / interstitial pages; weak markers also
 * appear on ordinary pages (a contact form with reCAPTCHA, a product called "Access Denied"), so they
 * only count on small pages that have little else in them.
 */

const STRONG_MARKERS = [
  // Cloudflare
  /cf-browser-verification/i,
  /cf_chl_opt/i,
  /challenge-platform/i,
  /__cf_chl_/i,
  /Attention Required!\s*\|\s*Cloudflare/i,
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  // Akamai Bot Manager
  /sec-if-cpt-container/i,
  /bm-verify/i,
  // PerimeterX / HUMAN, DataDome, Imperva/Incapsula
  /PerimeterX/i,
  /_px(?:hd|vid)/i,
  /captcha-delivery\.com/i,
  /Pardon Our Interruption/i,
  /_Incapsula_Resource/i,
];

const WEAK_MARKERS = [/g-recaptcha/i, /h-captcha/i, /are you a human/i, /Access Denied/i, /datadome/i];

/** Pages larger than this are real content even if they carry a captcha widget somewhere. */
const SMALL_PAGE_BYTES = 30_000;

export function looksBlocked(html: string, httpStatus: number | null): boolean {
  if (httpStatus === 403 || httpStatus === 429) return true;
  const head = html.slice(0, 20_000);
  if (STRONG_MARKERS.some((re) => re.test(head))) return true;
  return html.length < SMALL_PAGE_BYTES && WEAK_MARKERS.some((re) => re.test(head));
}
