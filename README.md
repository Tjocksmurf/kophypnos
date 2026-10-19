# Page Monitor (kophypnos)

Watch any public web page for a change you describe in plain words, and get a WhatsApp message when it happens.

Paste a URL → say what matters ("tell me when the price drops below $200") → approve the rule the system proposes → pick every 30 minutes, hourly or daily. Login is by WhatsApp code; there are no passwords.

Full spec: see the "Page Monitor — Product & Technical Spec" doc.

## Stack

- Node 22 + TypeScript, Fastify, Postgres via Drizzle ORM (pure JS, no engine binaries), Playwright for JS-rendered pages, Sentry optional
- One codebase, two Railway services: `web` (API + built React app) and `worker` (scheduler + fetcher)
- Twilio WhatsApp Business API for login codes and alerts
- Claude API (Anthropic SDK) for turning a sentence into a rule, judging ambiguous diffs, and relocating a target when a page layout changes
- React 19 + Vite client, single-column minimal design, light/dark via `prefers-color-scheme`

## Layout

```
src/
  server.ts         Fastify app: API + static client
  worker.ts         polling loop (SELECT … FOR UPDATE SKIP LOCKED), digests, housekeeping
  migrate.ts        applies drizzle/ migrations
  config.ts         env parsing (zod) and limits
  db/schema.ts      tables
  core/
    url.ts          URL normalisation + SSRF guard (private ranges refused on every hop)
    fetch.ts        browser-like fetch, size cap, redirects, ETag/304, block detection
    extract.ts      cleaned DOM with element ids, readable text, outline for the LLM, selector building
    rules.ts        rule schema, number parsing, observe (locate + extract), evaluate (conditions)
    diff.ts         line diff for page-level rules
    llm.ts          proposeRule / judgeDiff / relocateTarget (tool-use, temperature 0)
    check.ts        one monitor check end to end (fetch → observe → evaluate → snapshot → alert)
    notify.ts       WhatsApp sending with opt-out, quiet hours, daily cap, digests
    schedule.ts     intervals, jitter, daily-at in the user's timezone
    whatsapp.ts     Twilio client, templates, signature validation
  routes/           auth, me, pages (preview/propose/manual), monitors, webhooks
  plugins/session.ts
client/             Vite + React app
drizzle/            generated SQL migrations (commit these)
```

## Local development

```
cp .env.example .env            # defaults work with a local Postgres on 5432
npm install && npm --prefix client install
npm run migrate:dev
npm run dev                     # API on :3000 (serves client/dist if built)
npm run dev:worker              # scheduler loop
npm run dev:client              # Vite on :5173, proxies /api to :3000
npm test                        # unit tests for the pure core
```

With no Twilio credentials the app runs in dry-run mode: login codes and alerts are logged (and the login code is returned in the API response as `dev_code` outside production). With no `ANTHROPIC_API_KEY`, rule suggestions are off but manual rules (pick a line / whole page) still work.

## Railway

Two services from this repo plus the Postgres plugin:

| Service | Config file | Start command |
| --- | --- | --- |
| web | `railway.web.json` | `node dist/server.js` |
| worker | `railway.worker.json` | `node dist/worker.js` |

Set each service's *Config-as-code* path to the matching file (Service → Settings → Config-as-code). Both run `drizzle` migrations on boot, so no pre-deploy command is needed. Set the variables from `.env.example` on both services (`DATABASE_URL` comes from the Postgres plugin; `APP_URL` is the web service's public URL). The worker needs no public domain; give it `PORT` and point its health check at `/health`.

Twilio: create WhatsApp content templates matching the bodies in `src/core/whatsapp.ts`, submit them for approval, and put their `HX…` SIDs in the `TWILIO_TEMPLATE_*` variables. Point the inbound webhook at `/api/webhooks/twilio/inbound` and the status callback is set per message.

## Rules

A rule is JSON: a `target` (`selector` with CSS + text anchors, `region` between two text anchors, or `page`), an `extract` (`number`, `text`, `count`, `list`) and a `condition` (`changed`, `contains`, `not_contains`, `less_than`, `greater_than`, `equals`, `new_item`). Everything is evaluated in code; the LLM only creates rules, judges small page-level diffs, and relocates lost selectors. Threshold rules fire when the threshold is crossed, not on every check while it holds.

## JS-rendered pages

When the static HTML has almost no text, the preview retries with headless Chromium (Playwright). Monitors created from such a preview are marked `needs_browser` and always fetched with the browser, hourly or daily only, at most 2 per user, with `BROWSER_CONCURRENCY` contexts in flight at once. A monitor whose target disappears from the static DOM is also tried once in the browser before being marked stale. The runtime Docker image is Playwright's, so Chromium is present on Railway; locally, if Chromium isn't installed, browser fetches simply report "not available" and everything else works.

## Errors and staging

Set `SENTRY_DSN` to report unhandled errors from both services (tagged with `service`, `monitorId`, `userId`). For staging, create a second Railway environment from the `staging` branch with its own Postgres plugin and point `TWILIO_WHATSAPP_FROM` at the Twilio sandbox number; the same `railway.*.json` files apply.

## Rule-quality fixtures

`src/core/fixtures/*.html` are synthetic pages (product, listing, news) with tests in `src/core/fixtures.test.ts` that pin selector building, number parsing, list/new-item detection and noise handling. When a real page breaks a rule, add a reduced copy of its structure as a fixture and make it pass.

## Not yet built

- Richer conditions (percent change, hysteresis), multi-target rules
- Proxy rotation for sites that block datacenter IPs
- Paid plans / Stripe
