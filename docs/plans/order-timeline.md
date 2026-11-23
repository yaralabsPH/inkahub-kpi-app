# Order timeline implementation plan

> For agentic workers: use executing-plans and TDD. Claude is the sole implementation writer; Codex reviews. CJ delegated routine decisions. Do not start a loop asking for approvals.

**Goal:** Show truthful per-order history and bounded order-flow reports, ready for F11 automation milestones.
**Architecture:** Independent immutable evidence, service-only ingestion, authenticated management reads and compact Reports cards. No changes to scanning or inventory transactions.
**Tech:** Existing TypeScript/React/Supabase/PGlite/Vitest; no dependencies.
**Spec:** docs/specs/order-timeline.md (read together with docs/specs/make-milestones.md).

## Global constraints

Branch feature/order-timeline, based on fd0a1b3. Staging down: local work only, no hosted DB calls/billing/production/Make mutations. F3 migration numbers0048-0051 reserved, existing migrations immutable. Twelve API functions maximum. Stop at 10:00 Asia/Shanghai with a committed honest checkpoint if unfinished; do not rush or claim the whole feature done. Use external result logs, never secret payloads in repository. Production guardrails and all hardening requirements are in the spec.

## Review focus

1. Equal order numbers from two shops/sites must never merge (task1/2).
2. Conflicting replay and reordered events must preserve original facts (task1/2).
3. Partial shipment and missing evidence must not inflate complete-order metrics (task1/3).
4. Auth/site denial must occur before privileged reads or writes (task2).
5. A slow response after changing site/order must not paint stale data (task3).

### Task 1: Evidence model and pure projection

Files: src/lib/domain/orderTimeline.ts; tests/orderTimeline.test.ts.
- [x] Write failing tests for canonical site/shop/order identity; immutable occurrence dedupe/conflict; missing vs confirmed stages; partial shipment; cancellation/replacement exclusion; negative/out-of-order gaps; median/P90 and optional late threshold; time handling. Keep fixtures synthetic and minimal.
- [x] Implement exported typed evidence/projection/flow helpers with explicit bounded contracts. Include F11 stage identifiers now without implementing its receiver. A stage completion is distinct from order completion; multiple work types cannot be collapsed into fully framed without proof. Flow cohort is recorded original orders ordered in the selected period, completed shipment samples separately labelled, current late orders exclude cancelled/shipped and require configured threshold.
- [ ] Run targeted tests, typecheck; commit task1. (partial: stage-waiting helper pending) This is a safe checkpoint if the deadline arrives.

### Task 2: Durable ingestion and authorized reads

Files: supabase/migrations/0059_order_timeline.sql; api/_lib/order-timeline.ts; api/_lib/shopify-webhooks.ts; api/orders/timeline.ts; tests/api/order-timeline.test.ts; tests/reporting/pg/order-timeline.test.ts; package.json (include new server files in API typecheck); remove api/shopify/whoami.ts after caller check.
- [ ] Test actual local SQL transaction replay/conflict/site isolation and grants with existing PGlite harness before implementation. Avoid introducing production-event triggers. Indexed site/order and site/date queries return explicit over-limit errors, never truncate silently.
- [ ] Implement identity/evidence tables, atomic service-only ingestion, read RPCs and idempotent bounded app-evidence reconciliation. RLS enabled; no direct browser writes. Reuse trusted principal resolution from existing reporting auth, deny staff/kiosk, CS requires explicit reports nav, memberships mandatory except established owner policy.
- [ ] Test missing/malformed signatures, wrong shop/site, oversized body, altered duplicate, failed persistence, and unauthorized reads before DB access. Implement raw-body Shopify HMAC validation and bounded owner reconciliation, and GET timeline/flow actions. No webhook registration or live fetch. Configuration missing fails closed with useful UI-safe errors.
- [ ] Targeted tests and all server typechecks pass; commit task2.

### Task 3: Reports UI and verification

Files: src/components/OrderTimelineCard.tsx; src/components/OrderFlowSection.tsx; src/pages/Reports.tsx; docs/releases/order-timeline.md.
- [ ] Implement compact existing-style cards: order search, source/time/missing stage list, partial/cancelled labels, flow cohort/coverage and freshness, median/P90, configured-late rule or unavailable reason. Use existing site zones. Clear/cancel stale requests on site/order changes. No unrelated redesign or external calls per row.
- [ ] Add targeted request-scope regression test and manually inspect local UI if feasible. Dexie shows explicit Supabase requirement. Preserve all old Reports behavior.
- [ ] Run npx tsc -b, npm run typecheck:api, npm run typecheck:digest, npm run test -- --run, npm run build and append-only migration guard. Record exact results once, fix meaningful failures, commit. Independent reviewer checks scope/security/correctness.
- [ ] Release guide lists env mapping, optional late threshold, staged migration and role checks, tiny replay fixtures, Shopify subscription/reconciliation commissioning, rollback. Real staging/Preview acceptance remains unchecked until recovery; no bulk load.

## Implementation log

- Task 1 (checkpoint before 02:00 UTC): `src/lib/domain/orderTimeline.ts` — identity `site|normalized shop|numeric order id` (null when any part is missing/invalid, never guessed); immutable occurrence merge (duplicate vs conflict keeps the original; malformed time/unknown stage rejected); projection with F10 + F11 stage ids, missing stages explicit, arrival-order independent, dispatch never shipment, partial vs complete fulfillment, delivered only from Shopify evidence, CS/replacement evidence listed but never completing the original, framing per work type; flow metrics over recorded non-cancelled orders ordered in the period (complete-shipment samples, open orders, negative gaps excluded as anomalies, nearest-rank median/P90 in elapsed hours, late count only with a configured positive threshold else "Late-order rule not configured"). `tests/orderTimeline.test.ts` 10 tests red (module missing) then green; mutation (partial counted as complete) fails 1. `npx tsc -b` clean. Ruling: P90 is nearest-rank — cost if wrong: small samples differ from interpolated percentiles.
- Pending: Task 2 (0059 migration, ingestion/read RPCs, Shopify HMAC adapter, `api/orders/timeline.ts`, retire `api/shopify/whoami.ts` after caller check, API/PGlite tests, typecheck lists) and Task 3 (Reports cards, stale-request test, release guide, full gate). F11 receiver follows after F10 foundation review.

Earlier: actual Claude read-only discovery completed; Make connected-tool access was declined, so exported evidence only. No live site mapping or retention verified. Missing configuration is a commissioning prerequisite, not permission to invent it.

## Open questions

None requiring CJ before offline implementation. Business inputs remain unset as described by the spec. If a concrete implementation conflict appears, return it to Codex, the delegated planner, with proposed minimal resolution.
- Task 1 review r1 corrections: projections refuse mixed/unmapped identities and keep `identity`/`site`; flow metrics refuse mixed sites and duplicate identities; framing is `partial` unless `framingComplete: true` (work-type list kept); only confirmed evidence confirms stages — reported/inferred show `unconfirmed` and never set `completeShipmentAt` or enter metrics; occurrence keys are `source|key` and source/kind/site are validated; median averages the middle pair (P90 nearest-rank); `strictIso` requires explicit Z/offset ISO on real dates, period start < end and `now` validated, evidence after `now` excluded. 16 tests pass, `npx tsc -b` clean. **Task 1 is PARTIAL:** the stage-waiting-time helper (dwell between consecutive stages) is not implemented yet.
