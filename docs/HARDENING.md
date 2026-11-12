# Hardening checklist

The app runs a live business. Every spec and plan answers each question
below that applies (write "n/a" with a reason when one doesn't). Every
review checks the code against the same list. A plan that skips this
checklist is not ready for approval.

## 1. Failure modes

- What happens if the network, Supabase, Shopify, Dropbox, Slack or Make is
  down or slow? Does the worker see it? Is anything lost?
- What happens on retry? Can the same action be saved twice? (Idempotency:
  every write that can be retried needs a natural key or idempotency key.)
- What happens if two people or two devices do the same thing at once?
- What happens with bad input: unknown barcode, malformed scan, missing SKU,
  cancelled order, order from another site?
- What does the user see when it fails, and how do they recover?

## 2. Data correctness

- Can this misattribute work to the wrong person or department? How is that
  prevented?
- Are counts (orders, items, sets) computed by the one shared rule?
- Does history stay correct when people, departments or settings change
  later?
- Are times stored in UTC and shown in the site's local time zone (AU, UK,
  US)?
- Are inferred or manual values marked as such, separately from measured
  ones?

## 3. Security

- Does every new endpoint authenticate the caller (Supabase JWT, signed
  webhook, or shared secret) and validate its input?
- Do new tables have RLS policies consistent with existing roles (owner,
  manager, staff, kiosk, cs)?
- Do secrets stay server-side (`process.env`, never `VITE_*`), and are they
  absent from code, logs and Make/Slack messages?
- Can a caller trigger cost, spam or data exposure (emails, API rate limits,
  other people's data)?

## 4. Release and rollback

- Migrations are expand-only for this release. Can the previous app version
  run against the new schema?
- Is there a feature flag or setting to switch the new behaviour off without
  a deploy, where the change affects the shop floor?
- What exactly does CJ do at release (env vars, SQL, Make/Slack/Shopify
  settings), and in what order?
- What is the staging test plan, per role?

## 5. Performance

- Does any query scan months of events? Is it indexed or pre-aggregated?
- Does any screen call an external API per item? Batch or cache it.
- Will it still work with 2 years of data and 3 sites?

## 6. Operations

- How will we know it's broken in production? (Logs, a health indicator,
  an alert, a report of missing data.)
- Is there a manual fallback for the shop floor if it breaks?
- Is there anything to monitor or maintain over time (storage growth,
  webhook subscriptions, tokens that expire)?

## 7. Tests

- Pure logic (counting, routing, timing, parsing scans, box rules) has unit
  tests, including edge cases from section 1.
- Anything touching inventory, credit or money has tests for the old and
  new behaviour.
