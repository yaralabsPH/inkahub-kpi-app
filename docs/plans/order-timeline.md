# Order timeline implementation plan

> For agentic workers: use executing-plans and TDD. Claude is the sole implementation writer; Codex reviews. CJ delegated routine decisions. Do not start a loop asking for approvals.

**Goal:** Show truthful per-order history and bounded order-flow reports, ready for F11 automation milestones.
**Architecture:** Independent immutable evidence, service-only ingestion, authenticated management reads and compact Reports cards. No changes to scanning or inventory transactions.
**Tech:** Existing TypeScript/React/Supabase/PGlite/Vitest; no dependencies.
**Spec:** docs/specs/order-timeline.md (read together with docs/specs/make-milestones.md).

## Global constraints

Branch feature/order-timeline, based on fd0a1b3; resume from ad60a2f. CJ's new afternoon request supersedes the earlier10am checkpoint. User says staging upgraded; root verifies health before staging migrations/tests. All production/live Make mutations forbidden; isolated AU clones/testing authorized under F11 spec. F3 numbers0048-0051 reserved; migrations immutable. Twelve API functions maximum, no billing changes. No late/fast labels, rules or settings anywhere. Shared Shopify store routes by verified order-location predicate from current Make source. Use external result logs, never secrets in repository. Fix remaining review precedence issue first with targeted regression; then complete below. Historical log entries are provenance, not current requirements.

## Review focus

1. Equal order numbers from two shops/sites must never merge (task1/2).
2. Conflicting replay and reordered events must preserve original facts (task1/2).
3. Partial shipment and missing evidence must not inflate complete-order metrics (task1/3).
4. Auth/site denial must occur before privileged reads or writes (task2).
5. A slow response after changing site/order must not paint stale data (task3).

### Task 1: Evidence model and pure projection

Files: src/lib/domain/orderTimeline.ts; tests/orderTimeline.test.ts.
- [x] Finish focused tests: existing identity/replay/proof/cancellation/math checks plus remaining inferred-complete/confirmed-partial precedence bug, adjacent stage-duration missing/anomaly cases and removal of lateness output.
- [x] Finish helpers: stage durations measured only when both endpoints have confirmed nonnegative evidence. Missing stages stay unknown. Include F11 stages. Flow cohort is recorded original orders ordered in selected period; neutral median/P90/sample counts, no performance classifications. Remove late threshold/output entirely. Preserve site isolation and completed-order proof.
- [x] Run targeted tests, typecheck; commit task1. This is a safe checkpoint if the deadline arrives.

### Task 2: Durable ingestion and authorized reads

Files: supabase/migrations/0059_order_timeline.sql; api/_lib/order-timeline.ts; api/_lib/shopify-webhooks.ts; api/orders/timeline.ts; tests/api/order-timeline.test.ts; tests/reporting/pg/order-timeline.test.ts; package.json (include new server files in API typecheck); remove api/shopify/whoami.ts after caller check.
- [ ] Test actual local SQL transaction replay/conflict/site isolation and grants with existing PGlite harness before implementation. Avoid introducing production-event triggers. Indexed site/order and site/date queries return explicit over-limit errors, never truncate silently.
- [ ] Implement identity/evidence tables, atomic service-only ingestion, read RPCs and idempotent bounded app-evidence reconciliation. RLS enabled; no direct browser writes. Reuse trusted principal resolution from existing reporting auth, deny staff/kiosk, CS requires explicit reports nav, memberships mandatory except established owner policy.
- [ ] Test missing/malformed signatures, wrong shop/site, oversized body, altered duplicate, failed persistence, and unauthorized reads before DB access. Implement raw-body Shopify HMAC validation and bounded owner reconciliation, and GET timeline/flow actions. No webhook registration or live fetch. Configuration missing fails closed with useful UI-safe errors.
- [ ] Targeted tests and all server typechecks pass; commit task2.

### Task 3: Reports UI and verification

Files: src/components/OrderTimelineCard.tsx; src/components/OrderFlowSection.tsx; src/pages/Reports.tsx; docs/releases/order-timeline.md.
- [ ] Implement compact existing-style cards: order search, source/time/missing stage list, partial/cancelled labels, adjacent durations, flow cohort/coverage/freshness, neutral median/P90. No late/fast classification or setting. Use existing site zones. Clear/cancel stale requests on site/order changes. No unrelated redesign or external calls per row.
- [ ] Add targeted request-scope regression test and manually inspect local UI if feasible. Dexie shows explicit Supabase requirement. Preserve all old Reports behavior.
- [ ] Run npx tsc -b, npm run typecheck:api, npm run typecheck:digest, npm run test -- --run, npm run build and append-only migration guard. Record exact results once, fix meaningful failures, commit. Independent reviewer checks scope/security/correctness.
- [ ] Release guide lists verified shared-shop order-location routing, staged migration/role checks, tiny replay fixtures, Shopify reconciliation commissioning and rollback. Root applies staging only after recovery/headroom; no bulk history load. Verify Reports UI on actual Preview and isolated AU Make cloned chain after F11.

## Implementation log

- Task 1 (checkpoint before 02:00 UTC): `src/lib/domain/orderTimeline.ts` — identity `site|normalized shop|numeric order id` (null when any part is missing/invalid, never guessed); immutable occurrence merge (duplicate vs conflict keeps the original; malformed time/unknown stage rejected); projection with F10 + F11 stage ids, missing stages explicit, arrival-order independent, dispatch never shipment, partial vs complete fulfillment, delivered only from Shopify evidence, CS/replacement evidence listed but never completing the original, framing per work type; flow metrics over recorded non-cancelled orders ordered in the period (complete-shipment samples, open orders, negative gaps excluded as anomalies, nearest-rank median/P90 in elapsed hours, late count only with a configured positive threshold else "Late-order rule not configured"). `tests/orderTimeline.test.ts` 10 tests red (module missing) then green; mutation (partial counted as complete) fails 1. `npx tsc -b` clean. Ruling: P90 is nearest-rank — cost if wrong: small samples differ from interpolated percentiles.
- Task 1 complete (afternoon 2026-11-23): review r1 P2 fixed — shipped precedence is confirmed complete > confirmed partial > unconfirmed, the inferred complete record stays in `fulfillments` with its kind (regression test; mutation restoring the old order fails it). Late threshold/output/test removed; `flowMetrics(timelines, period, now)` has no lateness field. Added `TIMELINE_SEQUENCE` (ordered, five F11 make steps, framed, dispatched, shipped, delivered) and `stageGaps(t, now?)`: one gap per adjacent pair, measured only when both endpoints are confirmed (complete shipment / whole-order framing), unknown otherwise, never skipping a missing middle stage, negative = anomaly with no hours; `flowMetrics.stageGaps` gives neutral samples/unknown/anomalies/median/P90 per pair. 23 tests pass, `npx tsc -b` clean.
- Pending: Task 2 (0059 migration, ingestion/read RPCs, Shopify HMAC adapter, `api/orders/timeline.ts`, retire `api/shopify/whoami.ts` after caller check, API/PGlite tests, typecheck lists) and Task 3 (Reports cards, stale-request test, release guide, full gate). F11 receiver follows after F10 foundation review.

Earlier: actual Claude read-only discovery completed; Make connected-tool access was declined, so exported evidence only. No live site mapping or retention verified. Missing configuration is a commissioning prerequisite, not permission to invent it.

## Open questions

None requiring CJ before offline implementation. Business inputs remain unset as described by the spec. If a concrete implementation conflict appears, return it to Codex, the delegated planner, with proposed minimal resolution.
- Task 1 review r1 corrections: projections refuse mixed/unmapped identities and keep `identity`/`site`; flow metrics refuse mixed sites and duplicate identities; framing is `partial` unless `framingComplete: true` (work-type list kept); only confirmed evidence confirms stages — reported/inferred show `unconfirmed` and never set `completeShipmentAt` or enter metrics; occurrence keys are `source|key` and source/kind/site are validated; median averages the middle pair (P90 nearest-rank); `strictIso` requires explicit Z/offset ISO on real dates, period start < end and `now` validated, evidence after `now` excluded. 16 tests pass, `npx tsc -b` clean. **Task 1 is PARTIAL:** the stage-waiting-time helper (dwell between consecutive stages) is not implemented yet.
- Task 1 review r2 corrections: flow metrics exclude an order only for a confirmed cancellation at or before `now`; framing/fulfillment `partial` now requires confirmed evidence (inferred/reported-only is `unconfirmed`; a later confirmed partial wins over an earlier inferred one); `framedByWorkType` keeps the evidence kind and prefers the confirmed record per work type. 18 tests pass, `npx tsc -b` clean. Task 1 still PARTIAL: stage-waiting-time helper pending.
