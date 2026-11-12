# Roadmap — approved work

Owner: CJ (lead). Approved: 2026-11-12. Source of requests: Max (operations).

This is the single source of truth for what we are building next and the
decisions already made. The planner reads this before writing any spec.
Decisions marked **Decided** are not to be reopened in a spec; if the
planner finds a decision is unsafe or conflicts with the code, it raises it
in `docs/ROADMAP-REVIEW.md` or the spec's "Risks and open questions"
instead of silently changing it.

Every spec and plan must also pass `docs/HARDENING.md`.

---

## Status board

| ID | Slug | Feature | Size | Depends on | Status |
|---|---|---|---|---|---|
| S1 | `digest-auth` | Secure the daily report endpoint | S | — | In progress |
| F1 | `item-counting` | Count items separately from orders | S | — | Approved |
| F2 | `order-display` | Clearer order screen | S | — | Approved |
| F3 | `artwork-thumbnails` | Fast artwork images, auto-created | M | — | Approved |
| F4 | `box-auto-pick` | Remove box scan, app picks the box | M | — | Approved (needs box rules from Max) |
| F5 | `departments` | Departments managed by admins, people assigned | M | — | Approved |
| F6 | `scanner-stations` | Cordless scanners → one receiving tablet, scan-only framing | L | F5 | Approved |
| F7 | `dispatch-flow` | Dispatch scan flow with "Framed by" check | M | F5, F6 | Approved |
| F8 | `reports-v2` | Reports per person, department, period, trends, CSV | L | F1, F5 | Approved |
| F9 | `frame-timing` | Time per frame type | M | F6, F8 | Approved |
| F10 | `order-timeline` | Order timeline, phase 1 (Shopify + app events) | L | F6, F7 | Approved |
| F11 | `make-milestones` | Order timeline, phase 2 (Make pipeline milestones) | M | F10 | Approved |
| F12 | `print-confirmation` | "Mark printed" Slack button with fallback | M | F10, F11 | Approved |

Recommended build order: S1 → F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10 → F11 → F12.
The planner may propose a different order in the roadmap review, with reasons.

Manual (CJ, not code): release safety setup (staging Supabase, Vercel
preview variables, `main` branch protection, see `docs/RELEASING.md`) and
replacing the Make API token that is hard-coded in the "Check AU
cancellation registry" step of all six Make scenarios.

Not doing: changing Make Part 4's `planned_at` overwrite (declined by CJ).

---

## Cross-cutting decisions

These apply to several features. Specs must follow them.

1. **Production is live.** Every change follows `docs/RELEASING.md`:
   expand-then-contract migrations, staging first, instant rollback possible.
2. **Departments vs work types are different things.** Admins will manage
   *departments* (teams people belong to, F5). The app also routes order
   lines to fixed *work types* by SKU (`a0_framed`, `framed`, `unframed`,
   `dispatch`), which are hard-coded in code and in database CHECK
   constraints. The planner must design how these relate (for example, a
   department maps to one or more work types) without breaking SKU routing
   or historical events.
3. **Scanners are shared, not personal.** CJ is buying 3 cordless scanners.
   Any person can use any scanner. Identity comes from scanning a badge
   on the scanner; the app keeps an active person **per scanner**, not per
   device.
4. **One receiving device for now.** All scanners send to one plugged-in
   tablet. The design must allow more receiving devices later without a
   rewrite.
5. **Never lose or misattribute a scan.** A scan is either saved correctly,
   queued for retry, or rejected loudly. Silent loss and wrong credit are
   the two failure modes we design against.
6. **Automations must never block production.** Anything that reports to
   the app (Make, Slack, Shopify webhooks) must fail safe: production
   continues, and the app catches up or marks data as missing.
7. **History stays correct.** Events store the facts at the time (person,
   department, work type, quantities). Later admin changes never rewrite
   past credit.

---

## F1 · `item-counting` — Decided

- Orders and items are counted separately. Example: 2 × `INKA-S2BON0064-A1-UN` = **4 items, 1 order**.
- Set SKUs (`S2`, `S3`, …) multiply by their piece count, times quantity.
- **Unframed prints count as items** (today `isKpiEligibleSku` excludes `UN`; this changes).
- Gift cards, free prints and accessories stay excluded.
- Reports recompute from saved events, so past totals change. The release
  note must say so.
- The counting rule must live in one shared function used by Reports,
  Welcome, the live counter on the Production page and the daily digest.
  Today these have separate copies with different rules (see ARCHITECTURE).

## F2 · `order-display` — Decided

- Each line shows: product title (large), framed or unframed, size (bold),
  and the frame colour as a **large colour block** that's readable from 1 m.
- Frame colour is the most important visual. Natural, black and white must
  be unmistakable, including in dark mode.
- Images come from F3. Until F3 ships, the layout reserves the image space.

## F3 · `artwork-thumbnails` — Decided

- One small thumbnail per **artwork code** (`artworkCodeFromSku`), shared by
  every size and frame variant of that artwork. Use the artwork, not the
  Shopify product photo.
- Stored **permanently** in Supabase Storage; the path is recorded in the
  existing `artwork_images` table (new nullable column).
- The screen draws a border in the frame colour around the thumbnail.
- **New products must get a thumbnail automatically, right away.** No manual
  backfills after launch. Required triggers:
  1. When a product or variant is created or updated in **Shopify**.
  2. When a new artwork file lands in the **Dropbox** image folder.
  3. On demand: if an order shows an artwork with no thumbnail, create it
     then.
  4. A scheduled safety check that finds and fills anything the above missed.
- A one-time backfill of the existing catalogue is needed at launch only.
- If an artwork file is replaced in Dropbox, the thumbnail refreshes.
- Before building, check whether the packing-slip previews Make Part 6
  already makes (Dropbox `/Packing Slip Previews/`, with an index file)
  can be reused.
- Items with no artwork (gift cards, frame-only) show a clear placeholder.

## F4 · `box-auto-pick` — Decided

- Remove the box scan from every station. Done is no longer blocked by it.
- The app picks the box from the order contents and deducts it from stock,
  the same way it already auto-assigns mail tubes for unframed orders.
- Box rules (which contents → which box, mixed orders, multiple boxes) must
  be **editable by an admin in Settings**, not hard-coded. Max supplies the
  initial rules.
- Dispatch can override the picked box with one tap when reality differs.
- Old box scan data and code paths are kept (rollback-safe).
- Open: initial box rules from Max.

## F5 · `departments` — Decided

- Max or any super admin (owner role) can **create, rename and archive
  departments** and **assign people** to them in the app.
- Each person has one home department.
- Each event saves the department at that moment, so moving a person later
  doesn't rewrite history.
- See cross-cutting decision 2 (departments vs work types).

## F6 · `scanner-stations` — Decided

Hardware: 3 cordless barcode scanners, shared by anyone, sending to one
plugged-in tablet (receiving device). The framing benches have no power.

- **Scan-only framing.** Scanning a packing slip saves all framing lines of
  that order for the active person on that scanner. No tapping.
- **Per-scanner identity.** Each scanner is configured with a unique
  prefix. The app keeps one active person per scanner. Scanning a badge on
  a scanner makes that person active on it.
- **Forgotten badge scans.** The design must reduce wrong credit when
  someone picks up a scanner without scanning their badge (for example an
  idle timeout that ends a scanner session and requires a badge scan).
  The planner proposes the rule.
- **Mixed-up scans.** Several scanners typing into one device can interleave.
  Every scan must match a strict format (prefix plus start and end markers),
  and anything else is rejected with an error sound, never saved.
- **Automatic sign-in.** No confirm pop-ups on scan-only screens.
- **Offline safety.** If the network drops, scans are queued on the device
  with their scan time and saved when it returns. Duplicates must not be
  created on retry.
- **Kiosk mode.** Screen stays on, app reopens on start-up, the station
  stays signed in as a kiosk account.
- **Wall screen.** Large confirmation per scan ("✓ Ben · #10491 · 5 × A1"),
  distinct error sound, and a clear warning when the page can't receive
  scans (lost focus, offline, signed out).
- **Health.** An alert when the station goes silent during work hours.
- Hardware requirements for purchase (the spec lists them): configurable
  prefix and suffix, enough range to reach the tablet, multi-day battery.
  Prefer models that also support a non-keyboard (HID POS) mode for a
  later upgrade.

## F7 · `dispatch-flow` — Decided (keep it simple)

- Dispatcher scans their badge once per shift, then only order slips.
- The order screen shows "Framed by: <name> ✓" for framed lines, or a
  warning if no framing scan exists, with a quick name picker to assign
  the framer manually (flagged as manual in reports).
- No new screens beyond what's needed.

## F8 · `reports-v2` — Decided

- Per person and per department, for a day, week, month or custom period.
- Orders and items (F1 rules), trends over time, and summary CSV exports
  (not only raw events).
- Builds on the existing Reports page.
- Must stay fast over months of data.

## F9 · `frame-timing` — Decided

- With scanner data: time per frame type measured from the gaps between a
  framer's consecutive scans, divided across the items scanned. Gaps over a
  break threshold (currently 30 minutes) are ignored.
- Fallback where scans are missing: Max's method (6 h 45 min of work per
  7.5 h shift ÷ size-weighted items).
- Show the method used next to each figure.

## F10 · `order-timeline` — Decided (build properly)

- One timeline per order from **Shopify** (ordered, shipped, delivered where
  the carrier reports it) and **app events** (framed, dispatched).
- Reports: where orders wait longest between stages, order-to-ship time
  (median and slowest 10%), per site (AU/UK/US), and late orders now.
- Milestones are stored as their own records with a source and time, so
  F11 and F12 add stages without schema rewrites.
- Ingestion is idempotent and safe to replay.

## F11 · `make-milestones` — Decided (build properly)

- Each Make part adds one HTTP step that reports a milestone to the app:
  submitted (Part 1), files found (Part 2), planned (Part 3), images ready
  (Part 5), packing slips ready (Part 6).
- The step uses an **Ignore** error handler so the print pipeline never
  stops because of the app.
- The app endpoint is authenticated, validates input, and is idempotent.
- Batch-level milestones (Parts 3–6) are mapped to orders through the batch
  ID and the order list sent by Part 1.
- Missing milestones are shown as missing, never guessed silently.

## F12 · `print-confirmation` — Decided

- Part 5's "Images ready" Slack message gets a **"Mark printed"** button.
- Clicking records the printed time for that batch (who clicked, when).
  Clicking twice or late is harmless.
- **If nobody clicks, nothing breaks and we still have data.** The printed
  stage is then filled from the evidence that printing must already have
  happened (for example the first framing or dispatch scan of an order in
  that batch), marked **inferred** rather than confirmed. Reports show
  confirmed and inferred times differently.
- Optional: one reminder in Slack if the button hasn't been clicked after a
  set time. The planner decides whether it's worth it.
- The planner must confirm how the Slack button reaches the app (Slack app
  interactivity endpoint, signature verification).
