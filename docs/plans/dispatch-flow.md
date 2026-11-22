# Plan: F7 dispatch flow

Approved implementation on `feature/dispatch-flow`, based on reviewed F6 `0c47ace4527090510d0743157b37d9181192f8ce`. F6 review is clear, full gate and real staging SQL/roles/concurrency checks passed. 0055 is installed and immutable; use 0056 onward. Final combined browser/Preview verification follows F7.

1. **Evidence and shift contracts.** Reuse F6 session/job types; add dispatch expiry policy and a small pure evidence reducer. Pin actual existing cancellation/completion rules. Focused tests for measured/partial/cancelled/multiple-person/manual evidence and immutable job choices.
2. **Server evidence and atomic dispatch.** One append-only migration after F6: immutable per-SKU attribution storage/indexes/RLS, scoped evidence reader, and dispatch extension/wrapper around F6's validated commit/receipt/stock/packaging path. Do not duplicate an inventory engine. Cover actual-role authorization, all-or-nothing failure, replay, concurrent dispatch/classic deduction and evidence arriving before commit with SQL tests. Freeze exact retry payload once submitted.
3. **Minimal dispatch UI and Reports.** Dispatch mode in the existing receiver; shift badge policy, large result and `Framed by` display; compact missing-person chooser for the bound queued job. Existing Reports order details and raw CSV get stored attribution/manual labels; no added framing credit or timing. Reuse F6 queue/health/focus/audio/wake lock. Keep unsupported/classic fallback explicit.
4. **Verify, review and staging.** Coherent commits and brief log/runbook/release notes. One tsc/tests/digest/API typecheck/build gate, fresh reviewer. Codex applies reviewed staging SQL and checks actual browser happy/manual/blocked/retry flows plus old-app smoke, then deploys the combined Preview through existing Claude/Vercel route. Confirm final bundle uses staging and production deployment is unchanged. Hardware/real-rule commissioning remains clearly listed.

Routine implementation details may be chosen and logged. Material conflicts go to Codex, never sleeping CJ. One repo writer. No /loop, new dependency, production operation or merge to main.


## Final implementation boundaries

- Extend the existing `src/lib/scanners` session, queue, delivery and wall components. A small dispatch preparation/evidence module and a distinct dispatch RPC are appropriate; no new navigation area or generic workflow engine.
- Use `production_order_lock_`, `production_deduct_locked_` and F4 packaging contracts already installed by 0055. New dispatch saves need a distinct receipt kind and unique saved-dispatch-per-site/order index. Preserve the existing framing receipt/hash behavior and framing uniqueness rule.
- Dispatch badge activation must record a new clock-in as work type `dispatch`, while honoring the existing per-person/site workday lock and clock state. A small shared internal activation helper or a distinct dispatch activation RPC is acceptable in 0056. Do not call framing activation and then rewrite its event. Preserve exact replay of existing F6 activation receipts; include the new mode in new dispatch receipt identity/hash as needed.
- Support safely parsed normal print orders: framed lines supported by F6, valid unframed prints and the existing accessory/gift lines. Orders with no framed lines need no framer picker. Unsupported picture-frame/canvas/legacy/blank cases may use a clear classic fallback; do not broaden routing rules just to make them pass. Always use existing dispatch stock/packaging rules and avoid charging A0 stock or boxes twice.
- Dispatch work types/events belong to the dispatcher. Attribution rows name the framer without creating any additional framing credit. Evidence resolution must be identical at preview and commit; a bounded scoped server reader plus a small pure helper is sufficient.
- Keep caller fencing, lease tokens, truthful uncertainty, boolean finalizers and `releaseUnsent` semantics from F6. Late responses must not turn a saved job into a failure message. Old framing jobs have no mode field: read them as framing, keep their scope key and exact prepared payload/RPC replay unchanged.
- Missing choices can change only an unattempted dispatch job through an explicit transition. Keep other queued jobs visible. No editing an unknown-outcome payload; exact replay only. Freeze the worker, order, mode and original scan time before awaiting anything.
- The active-site person picker exposes only IDs and display names needed for attribution. Bounded order evidence queries must fail clearly on overflow rather than treating truncated evidence as missing and allowing an unsafe automatic guess.
- Existing `Reports.tsx` OrderLookupCard and filtered CSV are the only reporting changes. Preserve its current KPI math and event counts. The previous Reports reducer does not prove completed-phase evidence, so do not reuse it blindly for dispatch approval.

## Execution log

- [ ] Task 1: evidence, shift and persisted job contracts.
- [ ] Task 2: atomic dispatch, attribution and SQL assertions/races.
- [ ] Task 3: dispatch mode, compact picker and report labels/CSV.
- [ ] Task 4: final checks, review, runbook and staging acceptance.

Routine implementation choices may be logged and executed. Return only material conflicts to Codex, never sleeping CJ. No new dependency. No /loop or additional writers. Stop by 2026-11-23 02:00 UTC if not already finished.
