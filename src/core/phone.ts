import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface ParsedPhone {
  e164: string;
  country: string | null;
}

/** Normalise user input to E.164. Returns null for anything that is not a plausible mobile number. */
export function parsePhone(input: string, defaultCountry?: string | null): ParsedPhone | null {
  const cleaned = input.replace(/[^\d+]/g, "");
  if (cleaned.length < 6) return null;
  const parsed = parsePhoneNumberFromString(
    cleaned.startsWith("+") ? cleaned : `+${cleaned}`,
    (defaultCountry ?? undefined) as CountryCode | undefined,
  ) ?? parsePhoneNumberFromString(cleaned, (defaultCountry ?? undefined) as CountryCode | undefined);
  if (!parsed || !parsed.isValid()) return null;
  return { e164: parsed.number, country: parsed.country ?? null };
}

export function maskPhone(e164: string): string {
  return e164.length > 6 ? `${e164.slice(0, 4)}…${e164.slice(-3)}` : e164;
}
