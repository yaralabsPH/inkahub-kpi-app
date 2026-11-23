# Frame timing implementation plan

Use executing-plans; actual Claude is sole app writer.
Goal: useful per-size/frame timing with measured scan gaps and explicitly labelled Max-method estimates.
Spec: docs/specs/frame-timing.md
Branch: feature/frame-timing, stacked on accepted reports-v2.
Architecture: reuse F8 authorized generation/filter contract and full frozen source_versions; server computes complete worker streams before filtering. Small pure TypeScript reference pins math; additive SQL returns bounded aggregates. Existing React primitives, no dependencies.

## Tasks

- [ ] 1. Timing contract and math. Create src/lib/domain/frameTimingReport.ts and focused tests proving shared-capture grouping, worker streams across stations, threshold/clock/day breaks, eligibility/cancellation, quantities/sets, filters not changing adjacency, attendance-based budgets, measured subtraction and missing-weight unavailability. Define explicit method/coverage fields. Create additive0058 SQL for versioned owner weight config and timing aggregation from same pinned generation. Use F1 eligibility/sel_eval, not a competing count engine. Extend PGlite tests narrowly for real SQL parity and role restrictions. Commit.
- [ ] 2. API and UI. Add api/reports/timing.ts with F8 authorization and validation, service-only aggregation; reuse/re-export shared helper instead of duplicating auth. Add compact timing section in Reports and CSV method/weight-version labels. Add owner-only Settings positive size-weight form with blank defaults, immutable saves and optimistic conflict handling. Existing authenticated RPC can serve weights to stay within endpoint count; no extra API route if avoidable. Handle cutoff/filter/request changes, retry and unavailable states. Test auth/version conflicts and selected-filter CSV parity. Commit.
- [ ] 3. Gate and handoff. Run tsc, typecheck:digest, typecheck:api, full tests and build, inspect output. Fix concrete issues; no speculative expansion. Update plan/release notes and return SHA + verification + staging SQL instructions + STATUS line. No direct SQL/deploy/push.

## Review focus

Multiple lines from one shared scan must not create zero gaps; filtered reports must retain whole-stream timing; measured time cannot be allocated again as estimates; absence of attendance/weights must be explicit; immutable configuration must not change old versions; staff cannot query team metrics; historical department is frozen snapshot.

## Staging / rollback

Root validates synthetic scan groups, clocked shift with partial measured/unmeasured work, missing weights, role denials and update conflict in an actual staging SQL rollback fixture. Hosted Preview verifies selection/labels and owner Settings, previous scans/stock are smoke-tested only where changed. Cleanup exact disposable fixtures, verify original stock/event hashes. Previous Preview and retained SQL give rollback. Never production. Deadline02:00UTC2026-11-23; incomplete is reported honestly.

## Progress

Awaiting implementation.
