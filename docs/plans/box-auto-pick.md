# Plan: Remove box scan, app picks the box

- Slug: `box-auto-pick` · Spec: `docs/specs/box-auto-pick.md`
- Branch: `feature/box-auto-pick` (created 2026-11-22 from
  `origin/feature/station-screen-redesign` at `7b05828`; PR #10 still open)
- Status: approved by CJ on 2026-11-22 (with the spec's recorded decisions:
  managers edit rules, unframed-in-framed goes in the box, no destination
  rules so Task 14 is dropped)
- Author: Claude Fable 5.2 at CJ's request (2026-11-22); Astra review
  recommended before approval.

## Approach

**Base.** Create `feature/box-auto-pick` from `main` once PR #10
(`feature/station-screen-redesign`) is merged; if CJ wants to start before
that, branch from `origin/feature/station-screen-redesign` and rebase after
it merges. File paths below assume PR #10 is present
(`src/components/production/station/`).

**Shape.** Three layers, each testable on its own:

1. *Pure domain* (`src/lib/domain/packaging/`): contents model, rule-set
   schema (zod), evaluator, reconcile-delta maths. No I/O. This is where the
   tests live, following `skuRouting.ts` / `stationScreenModel.ts`.
2. *Database* (one additive migration): four site-scoped tables with RLS and
   five `SECURITY DEFINER` functions that authenticate, authorise and do all
   writes. Stock moves through one internal reconcile routine
   (`target − posted`), so apply, override and retry share the same
   exactly-once behaviour. Modelled on the location/role checks in `0001`
   and `0028`, deliberately not on `0031`.
3. *Client integration*: a thin Supabase module, a device queue, one hook
   (`useOrderPackaging`) that `Production.tsx` calls, one panel component
   used by both station screens, a Settings card, and report adjustments.

**Why not extend `deduct_inventory_for_event`.** Its key (order + code)
cannot express a changed box or quantity, it has no caller checks, and
RELEASING forbids changing what an existing function returns. It stays
byte-identical and remains the `scan`-mode path and the component path.

**Why not one "complete order" transaction now.** That is the shared
`production-write-safety` contract with F6/F7 and would change how events
are inserted while F1 is editing the same code. Instead: idempotent apply
keyed by pick, a visible device queue, and a "completion without pick"
report. The internal routine is callable from a future transaction.

**Switch.** `packaging_settings.mode` per site (`scan` default). No env
variable; the old deployment ignores the new tables entirely.

**No new dependencies.**

## Tasks

Each task is one commit and ends with `npx tsc -b` and
`npm run test -- --run` passing. All test data is synthetic (made-up product
ids, rule sets and order numbers).

### [x] Task 1: Packaging contents model

- Files: `src/lib/domain/packaging/contents.ts`,
  `src/lib/domain/packaging/__tests__/contents.test.ts`
- Do: `packingPointsForOrder(lines)` assigning each line a packing point
  per the spec's Terms (order-aware: unframed, free prints and accessories
  travel with the framed parcel; gift card → none) and
  `packagingContents(lines, packingPoint)` → pieces grouped by
  `{ kind, size }` with counts using the existing set multiplier, plus a
  list of lines it could not classify (unparseable, canvas).
- Done when: tests cover single, set (`2 × S2…` = 4), picture frame, free
  print, accessory, gift card, unparseable, canvas, and a mixed A0 + A1
  order producing two packing points.

### [x] Task 2: Rule-set schema and evaluator

- Files: `src/lib/domain/packaging/ruleSet.ts`,
  `src/lib/domain/packaging/evaluate.ts`,
  `src/lib/domain/packaging/__tests__/evaluate.test.ts`
- Do: zod schema for `{ schema_version: 1, catalogue[], rules[], examples[] }`
  as in the spec (rule: `id`, `packing_point`, `kinds`, `sizes`, optional
  `min_pieces`, `max_pieces`, `contains_sizes`, and output
  `{ mode: "fixed", packages[] } | { mode: "per_capacity", capacity, package }`).
  `evaluatePackaging(ruleSet, contents, ctx)` → `{ status: "resolved" |
  "unresolved", packages, firedRuleIds, unassigned }`. Deterministic,
  top-to-bottom, removes matched pieces, all-or-nothing on remainder.
  `runExamples(ruleSet)` → pass/fail per example. Structural validation:
  duplicate ids, package keys missing from the catalogue, capacity < 1.
- Done when: table-driven tests cover fixed and capacity outputs, priority
  order, contains-size, remainder → unresolved,
  empty contents, unclassified lines → unresolved, invalid rule sets
  rejected.

### [x] Task 3: Parity with today's tube choice

- Files: `src/lib/domain/packaging/__tests__/tubeParity.test.ts`
- Do: a synthetic two-rule set (any A0 unframed/free print → large tube,
  else small tube) and a generated matrix of unframed orders; assert the
  evaluator equals `autoMailTubeForUnframedOrder` for every case.
- Done when: the parity test passes and documents any case that differs
  (stop and write an Open question if one does).

### [x] Task 4: Reconcile maths

- Files: `src/lib/domain/packaging/reconcile.ts`,
  `src/lib/domain/packaging/__tests__/reconcile.test.ts`
- Do: `packagingDeltas(target, posted)` → per-product signed deltas, and
  `isOverride(predicted, target)`. This is the reference the SQL mirrors and
  the UI uses to preview an override.
- Done when: tests cover first apply, swap box, raise and lower quantity,
  remove all, no-op, and repeated application converging to zero deltas.

### [x] Task 5: Migration

- Files: `supabase/migrations/0047_packaging_auto_pick.sql` (provisional
  number: use the next free number after every migration already on the
  base branch and after item-counting's `0046`; confirm with CJ before
  committing)
- Do, all additive, wrapped in one transaction, safe to re-run:
  - `packaging_settings (location PK → locations, mode CHECK IN
    ('scan','auto') DEFAULT 'scan', updated_by, updated_at)`.
  - `packaging_rule_sets (location, id, version INT, status CHECK IN
    ('draft','active','retired'), body JSONB, note, created_by, created_at,
    activated_by, activated_at, PK (location,id), UNIQUE (location,version))`
    plus a unique partial index on `(location) WHERE status = 'active'`.
  - `packaging_picks (location, id, order_number, packing_point CHECK IN
    ('a0_framed','unframed','dispatch'), shipment_key, state CHECK IN
    ('auto','overridden','unresolved','legacy_scan'), stock_state CHECK IN
    ('posted','short','unposted'), rule_set_id, rule_set_version,
    input_snapshot JSONB, predicted JSONB, target JSONB, posted JSONB,
    revision INT, source_event_id, staff_id, created_by, created_at,
    updated_at, PK (location,id), UNIQUE (location, order_number,
    packing_point, shipment_key))`, index `(location, created_at DESC)`.
  - `packaging_pick_changes (location, id, pick_id, revision, request_id,
    kind CHECK IN ('apply','override','retry'), actor, staff_id, reason,
    before JSONB, after JSONB, deltas JSONB, result JSONB, created_at,
    PK (location,id), UNIQUE (location, request_id))`.
  - `CREATE UNIQUE INDEX … ON ledger (location, source_id) WHERE source_id
    LIKE 'pkg:%'`.
  - RLS on all four: `SELECT USING (can_access_location(location))`; no
    INSERT/UPDATE/DELETE policies.
  - Functions (`SECURITY DEFINER`, `SET search_path = public`; each starts
    with `auth.uid() IS NOT NULL` and `can_access_location(p_location)`;
    `REVOKE ALL … FROM PUBLIC, anon; GRANT EXECUTE … TO authenticated`):
    - `packaging_save_rule_set(p_location, p_id, p_body, p_note)` — manager
      or higher; draft only; validates catalogue product ids exist at the site.
    - `packaging_activate_rule_set(p_location, p_id)` — manager or higher; retires
      the current active one in the same transaction.
    - `packaging_set_mode(p_location, p_mode)` — manager or higher; `auto` needs
      an active rule set.
    - `packaging_apply(p_location, p_request_id, p_order_number,
      p_packing_point, p_shipment_key, p_event_id, p_staff_id, p_state,
      p_rule_set_id, p_input_snapshot, p_predicted, p_target)` — kiosk or
      higher, or `p_staff_id = auth.uid()`; validates the event (exists at
      `(location,id)`, same order, type completed/dispatched, department =
      packing point, `cs_case_id` consistent with the shipment key),
      catalogue membership, integer quantities 1–20, at most 10 lines.
      Order of work: replay check on `request_id`; advisory transaction
      lock on the pick key; insert pick `ON CONFLICT DO NOTHING` (existing
      pick → return it, `already_applied`); adopt legacy `prod:order_…`
      ledger rows for catalogue products into `posted`; reconcile.
    - `packaging_override(p_location, p_request_id, p_pick_id,
      p_expected_revision, p_target, p_reason, p_staff_id)` — same role
      rule; stale revision → `conflict` with the current pick; otherwise
      set target, bump revision, reconcile, audit.
    - `packaging_retry(p_location, p_request_id, p_pick_id)` — manager or
      higher; reconcile only.
    - internal `packaging_reconcile_(…)` (not granted): for each product in
      id order compute `target − posted`; `UPDATE products` inside a
      sub-block that catches `check_violation` (leave unposted); insert the
      ledger row (`reason 'sale'`, `source_id 'pkg:<pick>:<rev>:<product>'`,
      `parent_event_id NULL`); update `posted`; set `stock_state`.
  - `NOTIFY pgrst, 'reload schema'`.
- Done when: the file passes a local syntax read-through checklist in the
  commit message (no DROP/ALTER of existing objects, no edits to earlier
  migrations, every function has the three guards and the grants), and CI's
  append-only check passes. Not applied anywhere by the coder.

### [ ] Task 6: Staging verification scripts

- Files: `supabase/staging/box-auto-pick/README.md`,
  `supabase/staging/box-auto-pick/01-verify.sql` (`/supabase/` is already
  whitelisted in `.gitignore`)
- Do: one script, `BEGIN … ROLLBACK`, creating a synthetic site-scoped
  product set, rule set and events, then asserting with `RAISE EXCEPTION`
  on failure: replayed apply; second apply different request id; override
  swap and quantity change deltas; stale revision; shortage on both
  constraint variants; legacy adoption; wrong-site, wrong-role and
  non-catalogue refusals; ledger unique index. The README lists the
  two-session steps for the concurrent-apply check (cannot be done in one
  transaction) and states "staging only, never production".
- Done when: files exist and the README says who runs them (CJ, or Astra by
  delegation) and what output means pass. Running them is a release step,
  not a coder step.

### [ ] Task 7: Supabase module and device queue

- Files: `src/lib/repository/supabase/orderPackaging.ts`,
  `src/lib/state/packagingOutbox.ts`,
  `src/lib/repository/supabase/__tests__/orderPackaging.test.ts`,
  `src/lib/state/__tests__/packagingOutbox.test.ts`
- Do: typed wrappers for the functions with zod-parsed results and a
  discriminated outcome (`applied | already_applied | conflict | rejected |
  network_error`); `loadPackagingConfig(location)` (mode + active rule set,
  parsed; a rule set that fails to parse behaves as `scan` with a visible
  warning). Outbox in `localStorage` keyed by request id: enqueue on
  `network_error`, drain with backoff and on load, drop on any definitive
  server answer, cap size and age, expose pending count. Request id for
  apply is derived from the completion event id.
- Done when: tests cover result parsing, malformed responses, enqueue /
  drain / replay-safe drop, corrupted storage, and the cap.

### [ ] Task 8: Complete-blocking rule and station hook

- Files: `src/components/production/station/stationScreenModel.ts` (+ its
  tests), `src/lib/hooks/useOrderPackaging.ts`, `src/pages/Production.tsx`
- Do: add a `packagingMode` argument to `stationNeedsPackaging` /
  `packagingBlocksComplete` / `completeBlockReason` (`scan` = today,
  `auto` = never blocks); the classic `OrderActionBar` keeps using the same
  predicate. `useOrderPackaging` owns: config load, prediction for the
  current order and packing point, local pre-Complete override state,
  apply-after-event, outbox, existing-pick lookup on order load. In
  `handleCompleteOrder`: in `auto` mode leave packages out of the old
  `p_lines` and make one call into the hook after the event insert; in
  `scan` mode the code path is unchanged. Keep the diff inside
  `handleCompleteOrder` to that branch (F1 edits the same function).
- Done when: model tests cover both modes for all four work types; a hook
  test (mocked module) shows scan mode makes no new calls and auto mode
  applies once per completion event.

### [ ] Task 9: Packaging panel on both station screens

- Files: `src/components/production/PackagingPanel.tsx` (+ test),
  `src/components/production/station/StationOrderScreen.tsx`,
  `src/pages/Production.tsx` (classic `ActiveScreen`)
- Do: in `auto` mode replace the "scan a box" panel with: predicted
  packages (label "auto"), unresolved flag, one-tap alternatives from the
  catalogue for this packing point, +/− per line, "not saved yet (n)"
  notice. Legacy box barcode scans route to the same override setter
  through `legacy_barcode` instead of `packageFromBarcode`. `scan` mode
  renders the existing panel untouched. Works in dark mode and at tablet
  width; buttons have accessible names.
- Done when: component tests cover auto, overridden, unresolved, pending
  and scan-mode rendering, and the one-tap swap.

### [ ] Task 10: Correct a pick after completion

- Files: `src/lib/hooks/useOrderPackaging.ts`,
  `src/components/production/PackagingPanel.tsx`, tests
- Do: when a loaded order already has a pick at this packing point and
  shipment key, show it as saved with "Change box"; confirming calls
  `packaging_override` with the seen revision and a reason (preset list +
  optional note); on `conflict` show the current pick. Completing the order
  again never creates a second pick.
- Done when: tests cover success, conflict and replay.

### [ ] Task 11: Settings — mode, versions and catalogue

- Files: `src/components/PackagingRulesCard.tsx`, `src/pages/Settings.tsx`
- Do: owner/manager card (hidden for other roles),
  Supabase-only like `ProductionBenchmarksCard`: site mode switch with a
  confirmation naming the site; list of versions with status, who, when;
  "New draft from this version"; catalogue editor choosing from the site's
  products, with label and optional legacy barcode.
- Done when: component tests cover role gating, the `auto` guard without an
  active set, and draft creation.

### [ ] Task 12: Settings — rule editor, examples and simulator

- Files: `src/components/packaging/RuleEditor.tsx`,
  `src/components/packaging/RuleSimulator.tsx`,
  `src/components/PackagingRulesCard.tsx`, tests
- Do: ordered rule list (add, edit, move, delete) bound to the Task 2
  schema with inline validation; examples table with pass/fail from
  `runExamples`; simulator (type contents → packages, fired rules,
  unassigned). Activate is disabled until there is at least one example and
  all pass. Start this task only after Max's table (spec R1/R7) has been
  checked against the rule shape; if it does not fit, stop and write an
  Open question.
- Done when: tests cover validation errors, example failure blocking
  activation, and simulator output for a synthetic set.

### [ ] Task 13: Reports — net usage and attention list

- Files: `src/components/PackageUsageCard.tsx`,
  `src/components/PackageHistoryCard.tsx`,
  `src/components/PackagingAttentionCard.tsx`, `src/pages/Reports.tsx`,
  `src/lib/domain/packaging/usage.ts` (+ tests)
- Do: package product ids = hard-coded list ∪ every catalogue of the site's
  rule sets; usage nets positive `pkg:` reversal rows against negatives
  (pure function, tested); attention card (manager and owner): unresolved
  picks, `short`/`unposted` picks with "Retry", and completed/dispatched
  events at a packing point in the period with no pick (only for periods
  after the site entered `auto`), all bounded by the selected range and
  paged. `api/reports/daily-digest.ts` is not touched.
- Done when: tests cover netting (swap, quantity change, no corrections)
  and the missing-pick derivation.

### Task 14: dropped (CJ, 2026-11-22: no rule depends on destination)

Original text kept for the record; not to be implemented.


- Files: `api/shopify/order.ts`, `src/pages/Production.tsx` (order mapping),
  `src/lib/hooks/useOrderPackaging.ts`
- Do: add `shippingAddress { countryCodeV2 }` to the GraphQL query and the
  REST fallback; return `shipping_country_code` only; pass it as evaluator
  context. Missing country + a rule that needs it → unresolved.
- Done when: evaluator context test passes and the endpoint type-checks
  (note: `tsc -b` does not cover `api/`; check it the way `typecheck:digest`
  does).

### [ ] Task 15: Release notes and full check

- Files: `docs/RELEASING.md` (short "Packaging auto-pick" section: mode
  switch, verification scripts, rollback), this plan's log
- Do: write the runbook section; run `npx tsc -b`, `npm run test -- --run`,
  `npm run build`.
- Done when: all three pass and the section matches "Release and rollback"
  below.

## Hardening in the plan

- Retry / double save / lost response → Task 5 (request id, pick key,
  reconcile), Task 7 (outbox), verified in Task 6.
- Two devices at once → Task 5 (advisory lock, unique constraints, revision
  check), Task 6 two-session check, Task 10 (conflict UI).
- Bad input (unknown SKU, cancelled, other site, non-catalogue product) →
  Tasks 1–2 (unresolved), Task 5 (rejections), Task 6.
- Worker sees failures and recovers → Tasks 9–10 (states and pending
  notice), Task 13 (attention list, Retry).
- History stays correct → Task 5 (immutable rule versions, snapshots,
  append-only audit), Task 12 (activation gate).
- Inferred vs measured → `state` and `stock_state` (Task 5), shown in Tasks
  9 and 13.
- RLS, roles, per-site access, no public execute → Task 5, Task 6, Task 11.
- Flag without deploy → `packaging_settings` (Tasks 5, 8, 11).
- Old client on new schema → Task 5 is additive; Task 8 keeps `scan`
  unchanged; staging step 1 below.
- Performance → indexes in Task 5; bounded queries in Task 13; config cached
  per session in Task 8.
- Inventory tests for old and new behaviour → Tasks 3, 4, 6, 8.

## Release and rollback

- Migration: one file, additive only (four tables, one partial unique index
  on `ledger` that matches no existing row, new functions, policies,
  grants). It changes no existing table definition, function, policy or
  grant, so old code is unaffected. The index build takes a brief write
  lock on `ledger`; apply at a quiet time.
- Rolling back the app leaves the database usable by the old code: yes. The
  old build never reads the new tables and keeps the scan path. Picks and
  `pkg:` ledger rows written before the rollback stay valid. Known edge:
  spec R3 (old client re-completing an order already deducted in auto
  mode).
- Softer rollback without a deploy: owner sets the site to `scan`.
- Manual steps for CJ, in order:
  1. Read-only check of production's `products.current_on_hand` constraint
     and that the box/tube products exist at each site (spec R4, R6).
  2. Staging: apply the migration; confirm the *previous* preview build
     still completes with a box scan; run
     `supabase/staging/box-auto-pick/01-verify.sql` and the two-session
     check. Coordinate with F3/F5 so only one feature's migration goes to
     shared staging at a time.
  3. Preview: run the spec's staging test plan with synthetic rules.
  4. Batch release (per CJ's standing rule, with the other waiting PRs):
     back up, apply the migration to production, merge, deploy. All sites
     start in `scan`; nothing changes for staff.
  5. Enter Max's rules and examples per site as a draft, pass the examples,
     activate, then switch one site (suggest AU) to `auto`. Watch the
     attention list and box stock for a few days before the other sites.
- Follow-ups later (separate, after proof in production): net the digest's
  box counts once F1 is merged; decide R2 (`production-write-safety`);
  only after F6/F7, consider retiring `PACKAGE_TYPES`, the tube constants
  and the scan panel (contract release).

## Out of scope

- Changing `deduct_inventory_for_event`, component deduction, event
  insertion or event schema.
- `api/reports/daily-digest.ts`, item-counting files, department snapshots,
  scanner sessions, the F7 dispatch screen.
- Dexie support for packaging; `Repository.ts` changes.
- Writing or guessing production rules; applying SQL; merging; deploying.

## Open questions

Coder writes here when it hits something the plan didn't foresee. Planner or
CJ answers inline.

- (pre-implementation) Answered by CJ on 2026-11-22 except spec Q2
  (replacement contents; proposed default in force) and R1 (Max's rules).
  Tasks 1–10 and 13 do not depend on Max's rules; any `auto` activation
  does.

## Implementation log

Coder adds one line per task.

- Task 1: contents.ts + 14 tests. Order-aware packing points per CJ Q4: travellers (unframed, free print, accessory, unclassified) ride the dispatch parcel, else A0, else unframed if any flat print, else dispatch.
- Task 2: ruleSet.ts (zod + structural checks), evaluate.ts, 20 tests. Country condition omitted per CJ Q5. Added per-pick bounds (20 per item, 10 items) shared with the SQL.
- Task 3: 512-combination parity with autoMailTubeForUnframedOrder for orders without a framed parcel; no differences. Documented the one deliberate difference (CJ Q4: prints go in the box when a framed parcel exists).
- Task 4: reconcile.ts + 11 tests (deltas, convergence, partial posting).
- Task 5: 0047_packaging_auto_pick.sql (number provisional, not confirmed with CJ yet; see Open questions). Additive only: the only DROP/ALTER statements are DROP POLICY IF EXISTS / ENABLE RLS on the four new tables. Differences from the plan text: apply derives order, packing point, shipment key and staff from the event instead of taking them as arguments; state is derived server-side from p_resolved/predicted/target; ledger key uses a per-pick posting counter (post_seq) rather than revision so a retry can never reuse a key; added mode_changed_at. Ran migration twice + verify script in a local in-memory Postgres (PGlite, scratch dir, not a project dependency) against both on-hand floor variants: all checks pass. Not applied to any real database.
