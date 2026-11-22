# Spec: Remove box scan, app picks the box

- Slug: `box-auto-pick` · Roadmap ID: `F4` (see `docs/ROADMAP.md`)
- Status: draft (awaiting CJ review; not approved)
- Author: Claude Fable 5.2, in a dedicated discovery session CJ requested on
  2026-11-22. This is an exception to the usual "planner writes specs" rule;
  an Astra review of this spec and its plan is recommended before approval.
- Discovery baseline: `origin/main` at `8519ac9`, plus read-only inspection of
  `origin/feature/station-screen-redesign` (`7b05828`, PR #10),
  `feature/item-counting` (`3fd8b49`, PR #7 draft) and the staging schema
  (catalogue metadata only, no rows changed).

## Problem

A0 Framed and Dispatch cannot press Complete until someone scans a box
barcode, and Unframed is blocked until its auto-assigned mail tube is set.
The scan is a tap-and-reach step that F6 (scan-only stations) cannot have,
and the box catalogue and tube choice are hard-coded in
`src/lib/domain/skuRouting.ts`, so Max cannot change them.

The stock side is also unsafe today (migration `0031`,
`deduct_inventory_for_event`):

1. Idempotency is "order + supplied code". Changing the box after completion
   deducts both boxes; raising the quantity of the same box is skipped.
2. The duplicate check is `EXISTS` then insert, with no unique constraint, so
   two simultaneous calls can both deduct.
3. The function is `SECURITY DEFINER`, never checks the caller or location,
   and on staging its execute right is granted to `PUBLIC`.
4. Completion is saved first and the deduction is a second call whose failure
   is only written to the browser console. A lost call is invisible.
5. Replacement (CS case) work skips the whole call, so replacement packaging
   is never deducted.

Workers feel the blocked button; Max and managers feel wrong box stock.

## Goals

- No station needs a box scan. Complete is never blocked by packaging.
- The app predicts the packaging from the order contents using rules an
  owner edits in Settings. Rules are versioned; every pick records the rule
  version and the inputs it used.
- Packaging is deducted exactly once per shipment, safely under retries, two
  devices and lost responses.
- Dispatch (and any packing station) can override the pick with one tap. An
  override stores who, when, why, before and after, and moves stock by the
  difference only.
- Unmatched contents never invent a box: the order completes, nothing is
  deducted, and the order is flagged for follow-up.
- Everything can be switched back to scanning per site without a deploy, and
  an app rollback finds the old scan path and data untouched.

## Non-goals

- No change to how frames, prints and other components are deducted.
  `deduct_inventory_for_event` stays byte-identical (see Risks R2).
- No new event types and no new columns on `production_events`.
- No scan-only completion, per-scanner identity or general offline queue
  (F6), and no new dispatch screen (F7).
- No bin-packing or carrier-rate optimisation. Rules are a priority-ordered
  table, not a solver.
- No production rules are written by an agent. The initial rule set is
  entered from Max's table and must pass Max's examples before activation.
- Dexie backend: out of scope. `/production` already requires Supabase and
  bypasses `Repository.ts`; no Repository interface change is made.

## Terms

- **Packing point**: the station where a shipment is physically packed.
  Unframed prints → `unframed`; A0 framed → `a0_framed`; everything else →
  `dispatch`. This mirrors `shouldDeductAtDept` today. A mixed order (for
  example A0 framed + A1 framed) has two packing points and two picks.
- **Shipment key**: `orig` for the original order, `cs:<case id>` for a
  replacement packed under a CS case.
- **Pick**: the packaging record for one (site, order, packing point,
  shipment key). There is at most one.
- **Catalogue**: the list of packaging stock items (boxes, tubes) a rule set
  may use, each pointing at a product at that site.

## User stories / flows

- As a kiosk worker at A0 Framed or Unframed, I verify my lines and press
  Complete. The screen shows "Box: A0 Single (auto)" and I never scan a box.
- As a dispatcher, I see the predicted box on the order. If I used a
  different one I tap that box (or scan its old barcode) and Complete. If I
  notice after completing, I scan the slip again and change it.
- As a worker on an order no rule covers, I see "No box rule — flagged" and
  Complete still works.
- As an owner, I edit rules in Settings as a draft, run Max's examples and my
  own in a simulator, and activate the draft. I can go back to an earlier
  version or switch the site back to scanning.
- As a manager, I see packaging used (net of corrections) and a short list
  of orders needing attention: flagged, short stock, or completed with no
  packaging record.
- As a cs user, nothing changes.

## Design summary

### Rules (per site, versioned)

A rule set belongs to one site (stock is per site) and holds:

- `catalogue`: packaging items `{ key, product_id, label, legacy_barcode? }`.
  This replaces the hard-coded `PACKAGE_TYPES` and tube IDs when auto mode
  is on. `legacy_barcode` keeps the printed `+48=` style codes working.
- `rules`: evaluated top to bottom. A rule has
  - `packing_point`,
  - which pieces it takes: `kinds` (framed, unframed, picture frame, free
    print, accessory) and `sizes` (A0–A4),
  - optional conditions: piece-count range, "contains size", destination
    country list,
  - output: packages, either a fixed list for all matched pieces, or one
    package per N pieces (capacity).
  A rule that fires removes its pieces; evaluation continues on what is
  left. Pieces left at the end make the whole pick **unresolved** (nothing
  is deducted automatically; partial guesses are not applied).
- `examples`: contents → expected packages. Max's examples live here.
- `schema_version`, so the rule shape can grow without rewriting history.

Pieces are counted with the existing set multiplier
(`2 × S2…A1` = 4 pieces). Gift cards never need packaging. Accessories only
orders, canvas and unparseable SKUs are unresolved unless a rule covers them.

Lifecycle: `draft` → `active` → `retired`. Only drafts are editable.
Activating requires every stored example to pass in the simulator; the
previous active version is retired, never deleted or edited. Rolling back a
rule change is "activate a copy of the old version".

This rule shape is a proposal sized to the current seven boxes and two
tubes. It is confirmed or adjusted against Max's table before approval of
any activation (Risk R1).

### Site mode

`packaging_settings.mode` per site: `scan` (default, today's behaviour
exactly) or `auto`. Stations read it when an order loads, so an owner can
switch a site without a deploy. `auto` cannot be selected without an active
rule set.

### At the station (auto mode)

- On order load the app evaluates the active rule set for this packing
  point and shows the result. Evaluation is a pure function; it needs no
  network once the rule set is cached for the session.
- Complete is never blocked by packaging. Other Complete rules (verified
  lines) are unchanged.
- The worker may change the pick before Complete: tap another catalogue
  item (replaces a single-box pick in one tap), or use +/− for multi-box. A
  scanned legacy box barcode is treated as the same override, not an error.
- On Complete, the completion event is saved as today, then the packaging is
  applied through the new call. The saved pick records `auto`,
  `overridden` (differs from the prediction) or `unresolved`.
- Framed has no packing point and shows no packaging.
- Replacement work (active CS case): packaging is applied under shipment key
  `cs:<case id>`, so it is deducted once per case and never collides with
  the original order's pick. Component stock stays owned by the CS case, as
  today.

### Applying and correcting stock

One state-based routine does all stock movement for a pick:

- The pick stores `target` (packages that should be consumed) and `posted`
  (what the ledger already reflects). Reconcile posts `target − posted` per
  product and updates `posted`. Calling it any number of times moves stock
  at most once.
- **Apply** creates the pick. Unique on (site, order, packing point,
  shipment key); a second apply from a retry or another device returns the
  existing pick and deducts nothing.
- **Override** sets a new target on an existing pick, with the revision the
  client last saw. A stale revision is refused and the current pick
  returned. The before, after, per-product deltas, actor, staff member and
  reason are appended to an audit table. Overriding A1 Single → A1 Double
  Wide returns one and takes one; 1 → 2 of the same box takes one more.
- Every call carries a client-generated request id; a replay returns the
  stored result.
- Calls take a per-pick advisory lock, lock product rows in a fixed order,
  and are backed by unique constraints (pick key, request id, and a unique
  ledger source key for the new `pkg:` prefix).
- **Shortage**: packaging was physically used, so it is recorded. On-hand
  may go negative where the schema allows it (staging allows it; the
  recovered `0001` did not — Risk R4). The pick is marked `short` and shown
  to managers. If the database refuses the negative, that product stays
  unposted on the pick and a later reconcile (manager "Retry" or the next
  call) posts it. Completion is never blocked.
- **Adopting old scans**: if the old path already deducted packaging for
  this order (`prod:order_<n>:<code>` ledger rows for catalogue products),
  apply records them as already posted instead of deducting again.

The server validates the caller (signed in, site access, kiosk or higher, or
the staff member themself), that the completion event exists at that site
for that order and packing point, that every product is in the referenced
rule set's catalogue at that site, and that quantities are whole numbers in
a small range. The rule evaluation itself runs in the browser, as the tube
choice does today; the server stores the rule version and the inputs as the
snapshot.

### When the apply call fails

The completion is already saved. The apply request is kept in a small
on-device queue (same request id), retried automatically and on reload, and
a "packaging not saved yet (n)" notice stays visible. Independently, the
attention list shows any completion at a packing point with no pick, so a
lost device does not hide a missing deduction.

## Acceptance criteria

Site mode and rollback

- [ ] With no settings row, or mode `scan`, every station behaves exactly as
      before this feature (box scan required where it was, same deduction
      call, same ledger keys).
- [ ] An owner can switch a site between `scan` and `auto` in Settings;
      stations pick it up on the next order load without a deploy.
- [ ] `auto` cannot be selected while the site has no active rule set.
- [ ] The previous app version runs unchanged against the new schema.

Stations (auto mode)

- [ ] A0 Framed, Unframed and Dispatch can Complete without any box scan, on
      both the new and the classic station screen.
- [ ] The predicted packaging is visible before Complete, labelled auto.
- [ ] Contents with no matching rule show a clear flag; Complete works;
      nothing is deducted; the order appears in the attention list.
- [ ] Scanning a legacy box barcode in auto mode changes the pick to that
      box and raises no error.

Rules

- [ ] Only an owner with access to the site can create, edit, activate or
      retire rule sets and change the mode. Managers can view. Kiosk, staff
      and cs cannot change them (enforced in the database, not only the UI).
- [ ] An active or retired rule set cannot be edited or deleted.
- [ ] Activation is refused while any stored example fails.
- [ ] The simulator shows, for typed-in contents, the packages, the rules
      that fired and any unassigned pieces.
- [ ] Editing or activating rules later does not change any existing pick,
      ledger row or report total.

Stock

- [ ] Completing the same order at the same packing point twice (double tap,
      retry, second device, replayed request) deducts packaging once.
- [ ] Two simultaneous applies for the same pick produce one pick and one
      set of ledger rows.
- [ ] Override before Complete: only the final choice is deducted, the
      prediction is kept on the pick, state is `overridden`.
- [ ] Override after Complete moves stock by the per-product difference only
      and writes one audit row with actor, staff member, reason, before,
      after and deltas. Repeating the same override request changes nothing.
- [ ] An override made from a stale screen is refused and shows the current
      pick.
- [ ] Insufficient stock never blocks Complete; the pick is marked short (or
      unposted) and appears in the attention list; "Retry" posts it once
      stock allows.
- [ ] A replacement packed under a CS case deducts its packaging once per
      case and does not affect the original order's pick.
- [ ] A user without access to a site cannot read or write that site's
      rules, picks or audit rows, and cannot call any packaging function for
      it. An anonymous caller is refused.
- [ ] An order whose box was already scanned and deducted by the old path is
      not deducted again when completed in auto mode.

Reports

- [ ] "Packages used" and package history show net quantities (a corrected
      box is not counted twice) and use the site's catalogue.
- [ ] The attention list shows unresolved picks, short/unposted picks and
      packing-point completions with no pick, for the selected period.

## Data and backend impact

- Tables / migrations (one new, expand-only migration; next free number
  after item-counting's `0046`, provisionally `0047` — see Dependencies):
  - `packaging_settings` (site mode)
  - `packaging_rule_sets` (versioned rules, catalogue, examples)
  - `packaging_picks` (one per pick; predicted, target, posted, state, rule
    version and input snapshot)
  - `packaging_pick_changes` (append-only audit, request ids)
  - unique partial index on `ledger (location, source_id)` for
    `source_id LIKE 'pkg:%'` only (no existing row matches)
  - functions: save/activate rule set, set mode, apply, override, retry
  - no change to `production_events`, `products`, `ledger` columns, or any
    existing function, policy or grant
- Ledger rows written by this feature use reason `sale` (as packaging does
  today), source key `pkg:<pick>:<revision>:<product>`, and no
  `parent_event_id` (so the Reports "delete event" action cannot silently
  remove packaging audit rows; the link to the event lives on the pick).
- Repository interface changes: none (Supabase-only production path, stated
  out of scope for Dexie).
- `api/` endpoints touched: none required. Only if Max's rules depend on
  destination (the "NZ" box suggests they may): `api/shopify/order.ts`
  additionally returns the shipping **country code** (no other address
  data). `api/reports/daily-digest.ts` is not changed in this feature
  (see Dependencies, F1).
- RLS / role access: all four tables are site-scoped with
  `can_access_location`. Read: any role with site access (stations need the
  mode, active rule set and their picks). Direct writes: none; all writes go
  through functions that check `auth.uid()`, site access and role. Functions
  are revoked from `PUBLIC`/`anon` and granted to `authenticated`.

## Staging test plan

Synthetic data only: fake packaging products, a synthetic rule set and
made-up order numbers. No production data, no shared-staging migration until
CJ schedules it (see Dependencies).

Before the preview test (CJ or delegated to Astra, staging only):

1. Apply the migration to staging. Confirm the old preview build still
   completes an order with a box scan (old code on new schema).
2. Run the SQL verification scripts under `supabase/staging/box-auto-pick/`
   (each runs in a transaction and rolls back): replay, concurrent apply,
   override deltas, stale revision, shortage, legacy adoption, cross-site
   and anonymous refusal.

On the Vercel preview:

- Owner: create packaging products and a draft rule set; add examples; see
  activation refused with a failing example, then succeed; switch the site
  to `auto`; switch back to `scan` and confirm stations revert; edit rules
  after picks exist and confirm old picks and totals do not move.
- Manager: can view rules, cannot edit; sees packages used (net) and the
  attention list; "Retry" on a short pick.
- Kiosk at A0 Framed, Unframed (new screen and `?ui=classic`) and Dispatch:
  complete without scanning; unmatched order completes with a flag; scan a
  legacy box code as an override; double-tap Complete and check one
  deduction; turn the network off during Complete, see the pending notice,
  turn it on and check one deduction; override after completion by
  rescanning the slip; two tabs overriding the same pick (one is refused).
- Staff: can complete own work as before; cannot open rule editing.
- cs: pages unchanged; replacement packed under a case deducts packaging
  once.
- Mixed order (A0 framed + A1 framed): one pick at each packing point.

Smoke-test items most at risk: "Production: record a production event,
verify" and "Stock: an order deducts inventory exactly once".

## Hardening

1. **Failure modes.** Supabase down or slow at Complete: the event insert
   fails loudly as today; if the event saved but packaging did not, the
   request is queued on the device, retried, and visible; the attention list
   catches completions with no pick. Retry and double save: request id plus
   unique pick key plus state-based reconcile. Two devices: advisory lock,
   unique constraints, revision check on override. Bad input: unknown
   product, product outside the catalogue, wrong site, missing or
   mismatching event, out-of-range quantity are rejected with a reason;
   unknown or unparseable SKUs and cancelled orders make the pick unresolved
   rather than guessed. Shopify, Dropbox, Slack, Make: not involved (order
   lines are already loaded). The worker always sees one of: auto, changed,
   flagged, not saved yet.
2. **Data correctness.** Picks store the staff member and the signed-in
   account separately, plus packing point; nothing is attributed to a
   department beyond the existing work type. Piece counts use the existing
   set multiplier in one shared function (aligned with F1's item rule when
   it merges; packaging does not use KPI eligibility). History: picks keep
   the rule version and input snapshot; rule sets are immutable once active;
   ledger rows are append-only. Times are `timestamptz` (UTC) and shown in
   site-local time by the existing report helpers. Auto, overridden,
   unresolved and adopted-from-scan are stored as distinct states.
3. **Security.** No new HTTP endpoint. New functions authenticate and check
   site and role; new tables have RLS; no direct table writes. No secrets.
   A caller cannot move stock for another site, for products outside the
   catalogue, or in unbounded quantities. The existing unguarded deduction
   function is a known exposure that this feature does not widen; fixing it
   is proposed separately (R2).
4. **Release and rollback.** One additive migration. Old code ignores the
   new tables and keeps scanning. Per-site mode switch without deploy.
   Release order and rollback are in the plan. Picks, audit rows and ledger
   rows written in auto mode stay valid after a rollback.
5. **Performance.** Per order: one cached settings/rule read and one
   function call. Picks are indexed by (site, order) and (site, created);
   the attention list is a bounded, period-filtered query, not a scan of all
   events. Rule sets are small JSON documents. Fine at two years and three
   sites.
6. **Operations.** Attention list (unresolved, short, unposted, missing
   pick) and the on-device pending notice. Manual fallback: switch the site
   to `scan`, or correct a pick by override; stock itself can still be
   adjusted in the existing stock screens. To maintain: rules when box types
   change; nothing expires.
7. **Tests.** Table-driven unit tests for the rule evaluator (set
   multipliers, mixed sizes, capacity, contains-size, country, unassigned
   remainder, gift cards, unparseable SKUs), parity tests proving a
   synthetic rule set reproduces today's tube choice, reconcile delta tests,
   Complete-blocking rule tests for old and new behaviour, queue tests, and
   SQL scripts for the concurrency and authorisation cases.

## Roadmap decisions honoured

- *Remove the box scan from every station; Done is not blocked.* Auto mode
  removes the block on A0 Framed, Dispatch and Unframed, on both station
  screens.
- *The app picks the box and deducts it, like mail tubes today.* Rules cover
  boxes and tubes; the tube choice becomes two rules.
- *Rules editable by an admin in Settings, not hard-coded; Max supplies the
  initial rules.* Owner-edited, versioned rule sets with a simulator; no
  rules are shipped in code or invented.
- *Dispatch can override with one tap.* Tap another catalogue item before or
  after completion; audited deltas.
- *Old box scan data and code paths are kept.* `scan` mode is the unchanged
  old path; old ledger rows and the old function are untouched; legacy
  barcodes still work.
- Roadmap review, F4/5–6 (CJ, 2026-11-12): *test Max's examples before
  activation* → activation gate; *deduct once at the final packing point,
  including replacement packaging* → pick per packing point and shipment
  key; *unresolved rules flag without blocking* → unresolved state.
- Cross-cutting 5 and 7: no silent loss (queue + attention list); history
  stays correct (snapshots, immutable versions).

## Dependencies and shared contracts

- **Integration base.** `feature/box-auto-pick` should start from `main`
  after PR #10 (station screen redesign) merges, or from that branch if CJ
  wants to start sooner. F4 changes the same Complete-blocking helpers and
  packages panel that PR #10 introduces, so building on plain `main` would
  be rewritten.
- **F1 `item-counting` (PR #7, draft).** Owns migrations `0034`–`0046`,
  rewrites `api/reports/daily-digest.ts`, and edits `handleCompleteOrder`
  in `Production.tsx`. F4: numbers its migration after `0046`; keeps its
  edit to `handleCompleteOrder` to a single call into a new hook; does not
  touch the digest. Consequence: until a small follow-up after F1 merges,
  the daily digest counts gross boxes (a box corrected *after* completion
  counts twice there; corrections before Complete are unaffected).
- **F3 / F5 (parallel sessions).** No shared tables. Shared files:
  `Settings.tsx` (each adds a card) and the next migration number. CJ
  assigns final migration numbers at integration; only one feature's
  migration is applied to shared staging at a time.
- **F6 `scanner-stations`.** Needs completion that does not depend on a box.
  F4 provides it. The apply call is idempotent by request id and by pick
  key, so F6's device queue can call it as is; the evaluator is pure and
  works offline with a cached rule set.
- **F7 `dispatch-flow`.** The packaging panel is a self-contained component
  the F7 screen can reuse.
- **`production-write-safety` (proposed in the roadmap review, not yet a
  spec).** F4 does not make completion + deduction one transaction and does
  not change `deduct_inventory_for_event`. The internal apply routine is
  written so a future single "complete order" transaction can call it.

## Risks and open questions

Business inputs still missing (not invented here):

- **R1. Max's box rules.** No rule table or examples exist in the repo, any
  branch, the roadmap documents or project notes. Needed from Max, per site
  (AU, UK, US), using Appendix A. Until then the feature can be built and
  tested with synthetic rules, but no site can be switched to `auto`.
  Questions the table must answer: which box per size and count; mixed
  sizes; when a second box is needed; sets; picture frames; accessories;
  what the "NZ" box depends on; whether UK and US use the same boxes.

Decisions for CJ:

- **Q1. Who edits rules?** Proposed: owner only (the roadmap says "admin";
  the roadmap review said owner-managed). Alternative: managers too.
- **Q2. Replacement contents.** For a replacement under a CS case, should
  the pick be evaluated on the case's replacement lines (proposed, if the
  station has them) or on what the worker verified in that session? If
  neither is reliable the pick is unresolved and the worker taps the box.
- **Q3. Mixed A0 + smaller framed orders.** Proposed: two picks, one at A0
  Framed and one at Dispatch, because they are packed at two benches today.
  Confirm they really ship as separate parcels.
- **Q4. Unframed lines inside a framed order.** `isLineMyDept` says Framed
  handles these end to end, but stock for them deducts at Unframed. Proposed
  packing point: wherever the tube is actually used; Max to confirm whether
  such prints go in the box (no tube) or in a tube at Unframed.
- **Q5. Destination.** If any rule depends on destination, approve adding
  the shipping country code to the Shopify order lookup.
- **Q6. Partial matches.** Proposed: if any piece is unassigned, deduct
  nothing and flag the order. Alternative: deduct the matched part and flag
  the rest.
- **Q7. Post-completion override rights.** Proposed: any signed-in station
  account at that site (kiosk or higher), with the audit row; managers can
  also correct from Reports.

Technical risks:

- **R2. The existing deduction function stays unguarded.** It is shared with
  component stock on every station and with F6/F7. Recommended: a separate
  small `production-write-safety` spec. Alternative: add a caller/site guard
  in this feature (old clients would still pass). CJ to choose.
- **R3. Old and new clients on the same order.** New code adopts earlier
  scan deductions. The reverse (an old client completing an order again
  after auto mode already deducted) can deduct a second box. It needs the
  same order completed twice across a rollback and is visible in the
  ledger; accepted.
- **R4. Negative stock.** Staging allows on-hand down to −1,000,000; the
  recovered `0001` forbids negatives. The design handles both, but CJ should
  confirm production's constraint with a read-only check before release.
- **R5. Rules are evaluated in the browser.** The server bounds and audits
  the result but does not re-derive it. Same trust level as today's
  client-supplied quantities, now authorised and site-checked.
- **R6. Catalogue products must exist per site.** Staging has no packaging
  products; UK/US may not have the AU box codes. Rule sets validate product
  ids on save.
- **R7. Rule shape may not fit Max's real rules.** `schema_version` allows
  extension; confirm against Appendix A answers before building the editor
  UI (plan task order allows this).

## Appendix A — rule intake template for Max

One sheet per site (AU / UK / US). Nothing here is pre-filled on purpose.

Packaging items

| Box / tube name | Stock code in the app | Used at (A0 Framed / Dispatch / Unframed) | Holds what, at most |
|---|---|---|---|
| | | | |

Rules, most specific first

| # | Packed at | Contents (framed / unframed / picture frame / accessory; sizes) | How many pieces | Other condition (destination, contains A0, …) | Packaging to use (name × qty) |
|---|---|---|---|---|---|
| | | | | | |

Examples (at least: one per box, two mixed-size orders, one set, one order
that needs two boxes, one that should have no automatic box)

| Order contents (as on the slip) | Packed at | Expected packaging |
|---|---|---|
| e.g. 2 × A1 framed + 1 × A3 framed | Dispatch | ? |
| e.g. 1 × set of 3 A2 framed | Dispatch | ? |
| e.g. 1 × A0 framed + 1 × A1 framed | A0 Framed / Dispatch | ? |
| e.g. 3 × A2 unframed + 1 × A0 unframed | Unframed | ? |
| e.g. hooks only | Dispatch | ? |

Also needed: what should never be auto-picked, and who at each site decides
when reality differs.
