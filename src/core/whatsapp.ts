import twilio from "twilio";
import { config } from "../config.js";
import { logger } from "../logger.js";

export type TemplateName = keyof typeof config.twilio.templates;

export interface SendResult {
  sid: string | null;
  body: string;
  dryRun: boolean;
}

const client =
  config.twilio.accountSid && config.twilio.authToken ? twilio(config.twilio.accountSid, config.twilio.authToken) : null;

/**
 * Plain-text bodies, used in dry-run mode, in the Twilio sandbox, and as the stored copy of what was sent.
 * In production Twilio's content templates (contentSid + contentVariables) carry the same wording.
 */
export const bodies = {
  login_code: (v: { code: string }) => `Your Page Monitor code is ${v.code}. It expires in 10 minutes.`,
  change_alert: (v: { title: string; summary: string; link: string }) => `${v.title}: ${v.summary}\nView: ${v.link}`,
  monitor_problem: (v: { title: string; reason: string; link: string }) =>
    `We can't read "${v.title}" any more (${v.reason}). Open to fix: ${v.link}`,
  digest: (v: { count: string; link: string }) => `${v.count} changes during your quiet hours. View: ${v.link}`,
  account_deleted: () => `Your account and monitors have been deleted.`,
  help: (v: { link: string }) => `This number sends your Page Monitor alerts. Manage them at ${v.link}`,
} as const;

export async function sendWhatsApp(
  toE164: string,
  template: TemplateName | "help",
  variables: Record<string, string>,
): Promise<SendResult> {
  const render = bodies[template] as (v: Record<string, string>) => string;
  const body = render(variables);
  if (config.twilio.dryRun || !client || !config.twilio.from) {
    logger.info({ to: toE164, template, body }, "whatsapp dry-run");
    return { sid: null, body, dryRun: true };
  }
  const contentSid = template === "help" ? undefined : config.twilio.templates[template];
  const base = {
    from: config.twilio.from,
    to: `whatsapp:${toE164}`,
    statusCallback: `${config.appUrl}/api/webhooks/twilio/status`,
  };
  const msg = await client.messages.create(
    contentSid
      ? { ...base, contentSid, contentVariables: JSON.stringify(numberedVariables(template, variables)) }
      : { ...base, body },
  );
  return { sid: msg.sid, body, dryRun: false };
}

/** Twilio content templates take positional variables {{1}}, {{2}} … in the order the template was defined. */
const VARIABLE_ORDER: Record<string, string[]> = {
  login_code: ["code"],
  change_alert: ["title", "summary", "link"],
  monitor_problem: ["title", "reason", "link"],
  digest: ["count", "link"],
  account_deleted: [],
};

function numberedVariables(template: string, variables: Record<string, string>): Record<string, string> {
  const order = VARIABLE_ORDER[template] ?? Object.keys(variables);
  const out: Record<string, string> = {};
  order.forEach((key, i) => {
    out[String(i + 1)] = variables[key] ?? "";
  });
  return out;
}

export function validateTwilioSignature(url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!config.twilio.authToken) return config.twilio.dryRun; // allow in dev without Twilio
  if (!signature) return false;
  return twilio.validateRequest(config.twilio.authToken, signature, url, params);
}
