# Spec: Shared scanner station tuning

- Slug: `scanner-stations-tuning` · Roadmap ID: `F6`
- Status: Draft - awaiting CJ approval
- Author: planner (GPT-6 Astra)

## Problem

CJ's 2026-11-25 test on the `inka-staging-2` Preview, using a wired scanner and printed barcodes containing `<S1>...</S1>`, confirmed badge activation, clock-in deduplication, framing saves and duplicate refusal. Corrupt input currently signs everybody out; unrelated order lines can block framing; the ten-minute timeout is too short; workers need to sign out one scanner without touching the tablet.

This follows [the shipped F6 spec](scanner-stations.md). CJ's four decisions below supersede its corruption, line-selection and idle rules. Other F6 guarantees remain. The checked-in implementation also shares controller/session code with F7 Dispatch: keep mode boundaries explicit.

## Goals

- Reject corrupt scans loudly while preserving scanner identities.
- Save only framing work, ignoring unrelated lines without a warning.
- Use a 15-minute Framing idle timeout and a deliberate three-badge sign-out gesture.

## Non-goals

- No classic-station redesign, Dispatch order/shift changes, clock-out automation, new reporting, dependencies or hardware purchases.
- No schema, Repository, global SKU grammar or general packaging-rule changes; no historical reclassification.

## User stories / flows

### 1. Recover from a garbled scan (CJ: decided)

Every strict-parser rejection, including uncertain source, unknown scanner ID, interleaved/mismatched markers, stray text and invalid payload characters, saves/enqueues nothing and credits nobody **for that rejected input**. Do not clear any identity or pending activation because of corruption, or refresh idle timers. Keep the parser's length/timing limits, whole-frame validation and 400 ms quiet-boundary recovery; never extract a usable substring.

Play the existing error sound and show a large, persistent message:

> That scan didn't come through. Nothing was saved from that scan. Whoever just scanned: scan it again. If it was your badge, scan your badge again before your order.

For an unknown scanner ID, add: “This scanner isn't set up here. Ask a manager to check its scanner ID.” Do not claim to know which worker caused an uncertain burst. Keep the recovery message visible independently of the ordinary result panel until a **subsequent good scan**: successful badge activation, deliberate sign-out, or an order durably queued after normal identity checks. A mere well-formed frame that is refused is not good; duplicate-read suppression is not good. Earlier queue deliveries, earlier activation replies, timer expiry and heartbeat updates must not erase the message. They can update their usual status separately. A good scan on another scanner can clear it; this is a receiver-wide message. A new receiver session starts fresh.

Normal idle expiry, account/site/mode resets and valid-but-unusable/offline badge handling still apply independently. The change is to parser-error consequences, not badge authorization. Apply this corruption behavior in both shared-scanner modes; Dispatch's order and shift rules stay unchanged.

### 2. Scan an order containing framing and other lines (CJ: decided)

Keep whole-order preflight first: complete/exact Shopify response, not cancelled, no edit-warning tags or open replacement/CS case, and existing line-count bound. Classify without mutating the fetched order. Use the current strict parser and work types: single/set framed prints with `FB`, `FW` or `FN`, sizes A0–A4 and existing supported set/GW forms; A0 → `a0_framed`, others → `framed`. Aggregate raw quantities by SKU; preserve existing set-piece multiplication and server-confirmed totals.

Silently exclude accessories (including `INKA-AUXMFL`), hooks, free samples/prints, gift bags/cards/certificates, unframed prints, canvas (`-SC`), frame-only products and other unknown non-framing lines. They produce no framing credit, ignored-line count or warning. Check quantity bounds only for selected framing lines; unrelated quantities must not block framing. All original lines remain in Shopify and available to later order workflows.

**Planner choice: reject suspicious framing lines atomically.** Before treating an unknown/blank SKU as ignorable, check for framing intent: an `FB/FW/FN` suffix; an INKA single/set artwork stem followed by a size/variant tail that fails the strict grammar; or the standalone word “framed” in the title/variant (not “unframed”). Explicit non-framing categories above take precedence; a zero price alone does not mean “free sample.” Pin this classifier with fixtures, including missing size, bad size/variant, legacy SKU and blank SKU with a framed title. Do not repair or infer a SKU. If framing intent exists but it is not a valid current framed SKU, reject the **whole scan**, with no partial credit: “This order has a framed print we couldn't identify: <line>. Nothing was saved. Ask a manager to check it on the classic station.” This prevents a typo silently losing framing credit while allowing arbitrary accessory SKUs.

“Current SKU” means the existing supported SKU grammar, not membership of the local stock catalogue: that catalogue contains components such as `A0-Black`, not every Shopify artwork variant. Retain existing A0 routing/component-existence checks. Do not invent a finished-product catalogue lookup or claim to detect a syntactically valid artwork-code typo.

If selection is empty, reject with “Nothing to frame on this order. Nothing was saved.” Existing duplicate/partial-recorded, quantity, missing required stock and packaging refusals remain.

**Planner choice: scope the A0 payload to framing too.** `order.ts` currently routes accessories into A0 deductions and passes all lines into packaging prediction; simply skipping them for credit still lets unknown/canvas lines block the order. For newly prepared Framing jobs, derive A0 components and F4 packaging input from the selected framing subset, using existing helpers/rules. Ordinary framed stock still deducts at Dispatch. Ignored lines cause no deductions at this shared Framing step and cannot make its box prediction unresolved. A0 still requires automatic mode, a resolved box pick, and atomic component/packaging posting. Do not alter shared packaging helpers or Dispatch preparation. The packing consequence is called out under Risks.

### 3. Keep Framing identity for 15 minutes (CJ: decided)

Set `IDENTITY_IDLE_MS` to `15 * 60 * 1000`; update setup, wall countdown and rejection text together. Retain the existing activity basis: successful badge activation and order acceptance into the session's enqueue path. Parser errors, suppressed reads and background delivery do not extend it. Preserve the existing `> IDENTITY_IDLE_MS` boundary and periodic expiry check; an order arriving after the limit is refused immediately. Dispatch retains its absolute next-site-04:00 / maximum-12-hour expiry.

### 4. Sign out just this scanner (CJ: decided; timing/guard are planner choices)

In **Framing mode**, an already active worker scans their own badge three additional times on the same scanner within **10 seconds from the first repeat to the third**, inclusive. The initial activating scan does not count. All three must be that slot's active badge, with no intervening different scan on that scanner. Other scanners do not affect the sequence.

- Require at least **1 second since the last complete read of that same badge on that scanner** for each counted repeat. Every rapid duplicate updates that last-read time, but does not count, call activation, refresh idle expiry or extend the 10-second window. Retain suppression through pending activation and immediately after sign-out so a held badge cannot rapidly sign back in. Show “Remove the badge, wait one second, then scan again” locally when suppressed.
- First and second counted repeats use the existing online activation RPC and its clock-in deduplication; show `S2 · Ben · Sign out 1/3` then `2/3`, with “Remove badge; wait one second before scanning again.” No new clock-in while already clocked in. Count only successful checks, using scan-arrival times for the window. No order is allowed during pending activation, as today.
- The third qualifying repeat clears only S2's identity, pending state and gesture state, invalidates stale replies, and shows **“S2 signed out”**, “Ben is still clocked in. Scan a badge to use S2.” Use a confirmation tone; no activation/clock-out RPC. Other slots and already captured/queued orders remain untouched.
- Timeout, identity expiry/change, any different scan (even refused), activation failure, or a non-suppressed scan while activation is pending cancels the sequence. A protocol error cancels that scanner's gesture, or all gesture counters when its source is uncertain, **without clearing identities**. Reload/account/site/mode changes clear gesture state. After a timed-out sequence, the next qualifying own-badge repeat starts at 1/3.
- Keep existing offline badge refusal/clearing behavior; the gesture requires online operation. Do not reinterpret an ambiguous eight-digit order as a gesture unless it matches this scanner's already verified active badge. Dispatch keeps its existing badge flow and has no new triple-scan gesture.

Sign-out is local scanner unbinding, **not clock-out**. Clock-out stays in its existing flow. This avoids changing timesheets when a worker merely puts down a scanner.

## Acceptance criteria

- [ ] Every parser error saves nothing from that input, plays an error sound, retains identities and leaves recovery text visible until a subsequent good scan, including across delayed deliveries/activation replies.
- [ ] Mixed regular/A0/set orders save exactly their framing lines. Canvas, `INKA-AUXMFL` and all listed exclusions are silent, including in A0 preparation; no-framing and suspicious-framing orders save nothing with the specified explanation.
- [ ] Raw quantities, piece totals, A0 components/boxes, all-or-nothing failure and duplicate refusal are correct; unchanged refusals still hold.
- [ ] Framing works after ten minutes and expires after fifteen; all displayed copy agrees. Dispatch shift/selection behavior is unchanged.
- [ ] Three deliberate own-badge repeats sign out only that scanner, with visible progress/confirmation, no duplicate clock-in or clock-out, no queued-work reassignment and no stale-response revival. Rapid repeated reads do not advance the gesture or immediately sign back in.

## Data and backend impact

- **Tables / migrations:** none. Keep `0055_scanner_stations.sql` and later migrations untouched; existing RPC contracts already accept the selected framed payload. No SQL deployment. If implementation discovers a required schema change, stop and record it in the plan; any subsequently agreed migration must be new and expand-only.
- **Repository interface (Dexie and Supabase):** no changes to either implementation or `Repository.ts`. Scanner mode remains Supabase-only; existing Dexie outbox is device storage, not a new backend implementation.
- **API endpoints:** none. Reuse current Shopify lookup and scanner RPCs. Likely changes are `session.ts`, `station.ts`, `order.ts`, wall/setup/hook wiring and their tests; keep strict parser acceptance unchanged.
- **RLS / roles:** unchanged owner/manager/kiosk operation within site; staff/CS/anonymous cannot invoke scanner writes. No new secrets or dependencies.
- Preserve outbox schema and exact prepared payloads/request IDs, including old and uncertain jobs. New filtering applies only when preparing an unprepared job; never rewrite a possibly sent payload on retry or upgrade.

## Staging test plan

CJ runs the new Preview against **inka-staging-2**, never production, with a wired scanner and printed badge/order barcodes containing `<S1>...</S1>` plus Enter. Use printed S2/S3 frames to exercise independent slots on one wired scanner; true simultaneous hardware remains a separate commissioning check.

1. **Kiosk:** repeat the proven activation/save/duplicate flow. Bind different people to S1/S2; scan printed malformed/mismatched/unknown-ID examples and inject interleaved/timeout input. Verify no new job/event, unchanged people and persistent audible/visible recovery; let an earlier delivery finish before rescanning a good badge/order.
2. **Kiosk + owner inspection:** use synthetic regular, A0 and set orders mixed with every excluded category, especially canvas and `INKA-AUXMFL`. Verify exact credit, components and box payload; original order lines remain. Test exclusions-only, framed typo/blank-framed SKU, invalid framing quantity, cancelled/edit-tag/open-case/already-recorded/incomplete-response refusals. Use controlled fixtures for response faults unavailable through printed slips.
3. **Kiosk:** deliberately scan an active badge at 0/2/4 seconds; confirm progress and only that scanner signs out. Test held-badge rapid reads, intervening order/different badge, other-scanner traffic, >10-second gap, pending/late replies and offline operation. Inspect clock events: no extra clock-in during repeats, no clock-out. Existing clock-out still works.
4. **Kiosk:** check a real 10–15-minute idle interval and >15-minute refusal; verify countdown/copy. Switch to Dispatch and confirm shift expiry and existing order flow. Queue offline work, reload/rebind, retry a lost response and race two receivers/classic against one order: one credit/deduction, original person retained. Test storage failure and retained old prepared jobs.
5. **Owner/manager:** confirm health/queue visibility and classic fallback. **Staff/CS/anonymous/cross-site caller:** verify existing UI and RPC denial. Run [release smoke tests](../RELEASING.md#2-smoke-test-staging-preview-about-10-minutes), especially clock events, production verification, exactly-once stock, Shopify lookup and Reports; also check shipments/CS/returns and dashboard. Record outcomes before release.

## Hardening

1. **Failure modes:** network/Supabase/Shopify delays retain the scoped durable queue; badges remain online-only. Storage failure rejects visibly. Dropbox/Slack/Make are n/a: no calls added. Existing request IDs, immutable retries, leases and server order locks handle retries/concurrent devices. Bad-input behavior is defined above; worker/caller site membership remains enforced, never inferred from shipping country. Recovery distinguishes definitely refused work (classic available) from uncertain commits (retry same job; do not record again).
2. **Data correctness:** capture person before awaits; sign-out never rebinds queued work. F5 department snapshots/history remain unchanged. Use existing raw-quantity/set rules and server totals, without a parallel counting formula. Original scan times remain UTC; site-zone displays and workday calculation remain AU/UK/US-aware. Gesture intervals use elapsed time, not site dates. No new inferred/manual output or timing measurement; existing Dispatch manual labels stay intact. Accepted corruption attribution risk is below.
3. **Security:** no new endpoints/tables, so new authentication/RLS is n/a; retain existing JWT, role/site, badge and bounded RPC validation. No secrets in browser/code/logs/messages. Bounded frame/order/queue sizes remain; debounce adds no per-read external call. No emails, new exposure, provider writes or new API-per-item cost.
4. **Release and rollback:** no migration; previous app/schema and outbox remain compatible. Existing “Classic station” exit disables shared capture without deployment and retains pending jobs. After CJ approves spec/plan, coder implements and obtains green CI/review; CJ runs staging above, records the current deployment, then merges/releases at a quiet time. No new env vars, SQL, Shopify, Make or Slack settings. Refresh receivers after deployment. Roll back through Vercel to the prior app or use classic; keep receipts/events/queues, resolve uncertain work first. Old code restores old filtering/timeout/corruption rules for new scans, without undoing saved work. Agents do not merge, deploy or apply SQL.
5. **Performance:** bounded per-frame/per-order local classification and at most three gesture counters; reuse existing bounded/indexed site/order/request reads. No months-of-events scan or external API per line. Data growth over two years/three sites does not change this work's complexity.
6. **Operations:** use existing heartbeat/queue/blocked-job indicators, browser errors and RPC logs; no new remote alert claimed. Classic remains fallback for definite refusals. Monitor blocked/uncertain jobs, stock and packing outcomes after release; never clear browser storage to recover. Existing receipt/storage growth and token/session maintenance remain; no new subscriptions or retention store.
7. **Tests:** add pure classifier/session/controller tests for exclusions, suspicious SKUs, A0 payloads, set totals, all gesture boundaries/resets/debounce, malformed input and delayed-message races. Add wall tests for persistent text/progress/15-minute copy. Preserve parser, Dispatch, outbox/replay, old/new credit and inventory regressions, including A0 rollback on packaging failure and concurrent classic/shared saves. Before implementation review run `npx tsc -b`, `npm run test -- --run`, `npm run build` and CI; staging proves actual RPC/ledger behavior. These are implementation gates, not tests claimed by this documentation task.

## Roadmap decisions honoured

- **Scan-only / automatic sign-in:** badge then order, all framing lines, no confirmation pop-ups; sign-out also scan-only.
- **Shared identities / forgotten badges:** three shared scanners, independent badge-bound people and 15-minute Framing expiry; receiver identity/scope retained for future receivers.
- **Mixed-up scans / offline safety:** unchanged strict framed protocol, loud rejection, durable scoped jobs and exact-once retry. CJ's explicit retain-identity decision replaces F6's clear-all response.
- **Kiosk / wall / health:** retain wake/audio start, kiosk login/startup guidance, large results, focus/offline/auth warnings and current heartbeat/silence indicator.
- **Hardware:** configurable prefix/suffix, range, multi-day battery and preference for future HID POS remain commissioning requirements; wired testing does not prove cordless range/interleaving.
- **Cross-cutting:** staging-first rollback, fixed work types distinct from managed departments, immutable historical credit, and no automation dependency added. CJ's four 2026-11-25 decisions are followed; planner choices above remain draft.

## Risks and open questions

- **Accepted by CJ:** a garbled badge leaves the previous person active. Someone who ignores the recovery instruction can credit a later order to that person; retaining identities cannot eliminate this risk. Fifteen minutes also lengthens the unattended handover window.
- **Planner proposal for CJ's review:** framing-only A0 packaging/deductions exclude accessories and canvas that may physically travel with the parcel. Their handling remains outside this shared save; an A0-only order may have no later Dispatch step. Confirm the operational packing/stock procedure before enabling this change; do not silently restore whole-order rejection or invent accessory deductions. Classic fallback must not duplicate already saved framing.
- A syntactically valid but wrong artwork ID cannot be detected by the component catalogue. Unknown lines without framing evidence are intentionally ignored; titles are only a refusal safeguard, never a basis for credit.
- A keyboard wedge cannot prove trigger release. The rolling one-second guard blocks rapid held-barcode repeats, but a device that rereads at slower intervals can still satisfy the gesture. Commission trigger/same-barcode suppression and test the actual scanner; the 10-second/1-second values and initial-scan exclusion are planner proposals for this draft.
- Scope choice: triple-badge sign-out is Framing-only; corrupt-input recovery applies to both shared modes. Dispatch's shift and order rules remain unchanged.
