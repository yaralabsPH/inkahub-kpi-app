# Automation progress implementation plan

> For agentic workers: use executing-plans and TDD. Claude implements after F10's reviewed foundation. Codex reviews.

**Goal:** Persist Make progress safely and display it in the order timeline.
**Architecture:** Authenticated bounded batch envelopes, transactional membership and occurrences, shared F10 projection. Printing remains independent.
**Tech:** Existing TypeScript/Supabase/PGlite/Vitest.
**Spec:** docs/specs/make-milestones.md and shared F10 hardening.

## Global constraints

Branch feature/make-milestones stacked on completed F10. New afternoon request resumes work, no old10am deadline. Root verifies reported staging upgrade/recovery before hosted tests. All THREE live Make systems remain read-only. Duplicating current AU into an isolated staging chain and testing that chain is explicitly authorized. No external messages, actual printing or billing changes. Additive0060 only if needed. Five stages, no F12 and no late/fast classification. Existing API slot receives explicit make source with separate auth. Payloads/logs secret-free; runtime credentials server-side only.

## Review focus

Reordered batch mapping; changed successful subsets; conflicting duplicate payload; cross-site secret misuse; oversized/failed transaction falsely acknowledged. Each is tested in task1.

### Task 1: Batch ingestion

Files: api/_lib/make-milestones.ts; api/orders/timeline.ts; supabase/migrations/0060_make_milestones.sql; tests/api/make-milestones.test.ts; tests/reporting/pg/make-milestones.test.ts.
- [x] First write failing tests for the five review conditions, identical retries and eventual resolution after explicit membership arrives.
- [x] Implement schemaVersion1 envelope, scoped dedicated secret authentication before DB/parser work, stable run/event/membership IDs, strict size/stage/time bounds, transactional durable acceptance and unresolved-event status. Reuse F10 identities/evidence; record actual success subsets and never infer missing stages.
- [x] Targeted tests/typechecks pass; commit task1.

### Task 2: Progress and commissioning guide

Files: src/components/OrderTimelineCard.tsx; docs/releases/make-milestones.md; tests/orderTimeline.test.ts.
- [ ] Show five recorded/missing automation steps, source time and batch context using existing projection. Test later stage without earlier stage, preserving missing status.
- [ ] Write redacted request examples, per-part placements after success, exact Ignore error-handler instructions, replay original envelope contract, retention limitations and cloned-staging-only acceptance steps. Part4 unchanged. Do not install into live scenarios.
- [ ] Run existing full typecheck/test/build gate, request independent review, record blocked real staging/Make checks accurately, commit checkpoint.

### Task 3: Clone and test AU safely (external operations after code review)

- [ ] Record current AU source blueprint hashes/versions and all outbound resource references; discover actual order-location routing. Source scenarios are never changed.
- [ ] Create clearly named STAGING duplicates of all AU parts, disabled/manual initially; remap internal hooks and every write resource to staging-owned copies. Use a manifest allowing writes/runs only for exact clone IDs. Replace live notifications/printer actions with staging logs. Keep processing logic otherwise faithful. Redacted clone map/replay instructions in docs/releases/make-milestones.md; secrets only provider configuration.
- [ ] Validate no live-write destination remains, then run tiny synthetic fixtures through clones into the staging timeline. Test success, missing earlier step, retry and one deliberately unavailable milestone endpoint with Ignore handler so the clone pipeline continues. Verify original scenario hashes/config unchanged and no live side effects. Leave clones manual/disabled after tests; report links and any unconnected boundary honestly.

## Implementation log

- Branch `feature/make-milestones` created from `06bb313` (F10 accepted for isolated staging validation, r2).
- Task 1: `0060_make_milestones.sql`:
  - **Tables:** `make_milestone_occurrences` (immutable original envelopes, PK site+shop+occurrence_id, canonical `content`); `make_milestone_members` (Part 1 membership of one batch+version: stable `member_key`, display alias `order_number` with one leading `#` removed, first Shopify id mapping, status unresolved|resolved|ambiguous|site_conflict|alias_conflict|mapping_conflict; identity fields immutable by trigger); `make_milestone_refs` (each envelope's successful subset: pending|attached|not_member|blocked).
  - **Ingest:** `ingest_make_milestone(site, shop, scope, envelope)` is service-only and atomic. An identical retry is `duplicate`; altered content under the same occurrence, or a second Part 1 occurrence for an already-defined batch/version, is `conflict` and writes nothing; any invalid record rolls back the whole envelope.
  - **Resolution:** `make_milestone_resolve` runs in the same transaction. Non-members are refused, and one member stated with two ids, or two members with one id, fails closed. An order already routed to another site (`site_conflict`), or recorded with a different alias (`alias_conflict`), is never attached or reassigned. Resolved members get confirmed `make_*` evidence through F10 `ingest_order_timeline` (key `<occurrence>|<member>`, batch id, actual happened_at); an unrouted order is routed once to the scope's site (F10 spec: explicit Make membership may supply the location; flagged for review below). A timeline conflict raises, so nothing is acknowledged.
  - **Read:** `read_make_batch` (bounded) keeps unresolved and fail-closed members visible.
- Server: `api/_lib/make-milestones.ts`; `api/orders/timeline.ts` gains a third, exclusive auth path (`x-inka-make-scope` + `x-inka-make-key`, constant-time against `MAKE_MILESTONE_SCOPES`). The order is: auth (401), ingestion switch (503 `DISABLED`), size ≤ 256 KiB (413), strict schemaVersion 1 validation (400, unknown fields incl. site/shop refused, ≤ 500 members, explicit-zone time, not > 5 min in the future), RPC; conflict is 409 and a failed or unexpected transaction is 503. Also added `GET ?action=make_batch&site=&batchId=` (same readers as the timeline; staff/kiosk 403 before any read) so unresolved members are visible. Still 12 functions. `typecheck:api` list extended; `tests/reporting/reportingJobs.test.ts` migration tail extended for 0060 (file not named in the plan, same edit as F9/F10).
- Tests: PGlite 10 (duplicate/conflict/redefinition, rollback, shape bounds, event-before-membership with real F10 read, changed subset + version isolation + non-member, cross-site refusal, ambiguous + mapping conflict, alias conflict, batch read, grants); API 8 (bad/cross-scope keys 401 with no RPC, config/disabled 503, mixed auth 400, 413, 15 malformed envelopes 400, scope-only site/shop with normalized alias/UTC, 409/503/duplicate, scope config, make_batch auth). Honesty note: both test files were written before the code, but I did not run them red first; instead eight mutations (any key accepted, switch ignored, body site allowed, altered=duplicate, membership redefinable, no site conflict, no not_member, no ambiguity) each fail ≥ 1 test (`C:/Users/cjgom/dev/morning-20261123/f11-mutate.py`). Targeted suites 64/64 (with F10 PG + migration tail), `typecheck:api` clean.

## Open questions

- For root review (not blocking local work): when a resolved Make member names a Shopify order that is NOT yet routed, 0060 routes it once to the connector scope's site (the F10 spec allows explicit Make membership to supply location). An order already routed elsewhere is never changed (`site_conflict`). If root prefers Make never to route, the minimal change is to skip attaching until F10 routing exists (members stay `unresolved` with reason) — one condition in `make_milestone_resolve`.

## Verified AU identity handoff (2026-11-23)

Part1 knows accepted display order numbers and batch id; Part2 supplies immutable Shopify ids. Persist scoped shop/site/batch membership aliases and the original Part1 occurrence/time, then resolve them atomically from explicit Part2 mappings. A stable member key may connect stages without inventing Shopify ids. Successful subsets must refer to the same batch/membership version. Unresolved or ambiguous members remain durable and cannot attach to an arbitrary order. An existing canonical order mapped to a different site must not be reassigned by Make. Preserve idempotent original-envelope retries and reject conflicting occurrences. Do not add per-order Shopify calls to Part1.

Successful pipeline milestones are confirmed source evidence; missing stages remain missing. The general shared-store location rule is still unconfigured pending clarification; synthetic staging tests use an explicitly synthetic shop and AU scope. This is an implementation clarification within the approved F11 scope.
