import dns from "node:dns/promises";
import net from "node:net";

export class UrlError extends Error {
  constructor(
    message: string,
    public code: "invalid" | "scheme" | "private" | "resolve",
  ) {
    super(message);
  }
}

/** Parse and normalise a user-supplied URL. Throws UrlError on anything we refuse to fetch. */
export function parseUrl(input: string): URL {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UrlError("That doesn't look like a valid URL.", "invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlError("Only http and https pages can be monitored.", "scheme");
  }
  if (url.username || url.password) {
    throw new UrlError("URLs with embedded credentials are not supported.", "invalid");
  }
  url.hash = "";
  // Strip common tracking parameters so two pastes of the same page collapse.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$|_hs)/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.slice(7)); // mapped v4
  if (lower.startsWith("2001:db8")) return true; // documentation
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

/** Resolve the host and refuse anything that lands on a private or special-purpose address. */
export async function assertPublicHost(url: URL): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new UrlError("Local and internal hosts can't be monitored.", "private");
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UrlError("Private network addresses can't be monitored.", "private");
    return [host];
  }
  let addresses: string[];
  try {
    const result = await dns.lookup(host, { all: true });
    addresses = result.map((r) => r.address);
  } catch {
    throw new UrlError("That host could not be found.", "resolve");
  }
  if (addresses.length === 0) throw new UrlError("That host could not be found.", "resolve");
  for (const a of addresses) {
    if (isPrivateAddress(a)) throw new UrlError("That host resolves to a private address.", "private");
  }
  return addresses;
}
