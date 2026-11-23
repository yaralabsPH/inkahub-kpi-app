# Automation progress implementation plan

> For agentic workers: use executing-plans and TDD. Claude implements after F10's reviewed foundation. Codex reviews.

**Goal:** Persist Make progress safely and display it in the order timeline.
**Architecture:** Authenticated bounded batch envelopes, transactional membership and occurrences, shared F10 projection. Printing remains independent.
**Tech:** Existing TypeScript/Supabase/PGlite/Vitest.
**Spec:** docs/specs/make-milestones.md and shared F10 hardening.

## Global constraints

Branch feature/make-milestones stacked on completed F10. Existing database is unavailable; no hosted calls, live scenarios, messages or billing changes. Additive0060 only if needed. Five stages, no F12. Existing API slot receives explicit make source with separate auth. All payloads and logs must be secret-free. Respect10:00 Asia/Shanghai checkpoint.

## Review focus

Reordered batch mapping; changed successful subsets; conflicting duplicate payload; cross-site secret misuse; oversized/failed transaction falsely acknowledged. Each is tested in task1.

### Task 1: Batch ingestion

Files: api/_lib/make-milestones.ts; api/orders/timeline.ts; supabase/migrations/0060_make_milestones.sql; tests/api/make-milestones.test.ts; tests/reporting/pg/make-milestones.test.ts.
- [ ] First write failing tests for the five review conditions, identical retries and eventual resolution after explicit membership arrives.
- [ ] Implement schemaVersion1 envelope, scoped dedicated secret authentication before DB/parser work, stable run/event/membership IDs, strict size/stage/time bounds, transactional durable acceptance and unresolved-event status. Reuse F10 identities/evidence; record actual success subsets and never infer missing stages.
- [ ] Targeted tests/typechecks pass; commit task1.

### Task 2: Progress and commissioning guide

Files: src/components/OrderTimelineCard.tsx; docs/releases/make-milestones.md; tests/orderTimeline.test.ts.
- [ ] Show five recorded/missing automation steps, source time and batch context using existing projection. Test later stage without earlier stage, preserving missing status.
- [ ] Write redacted request examples, per-part placements after success, exact Ignore error-handler instructions, replay original envelope contract, retention limitations and cloned-staging-only acceptance steps. Part4 unchanged. Do not install into live scenarios.
- [ ] Run existing full typecheck/test/build gate, request independent review, record blocked real staging/Make checks accurately, commit checkpoint.

## Implementation log

Not started. F10 prerequisite pending.
