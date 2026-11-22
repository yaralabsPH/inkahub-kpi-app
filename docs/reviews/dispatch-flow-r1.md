# F7 dispatch flow — review R1

Reviewed initial implementation fe4230446d5b183789c6bd9081c6f1f8eabe6741 on feature/dispatch-flow, based on reviewed F6 0c47ace. Actual Claude is the implementer; Codex and fresh read-only reviewer /root/review_f7_implementation checked the result. Local coder gate: 1013 tests / 46 files, tsc, digest/API typechecks and build pass. 0056 has NOT been installed; 0052–0055 are installed on staging and immutable. Production remains outside this task.

## Required fixes

1. **P1 — stale framing after cancellation/reopen.** The SQL evidence reader excludes parentless cancellation only between verification and completion. Later whole-order/SKU cancellation or a reopened attempt can leave obsolete work marked measured. Constrain evidence to the current valid attempt (conservative missing/manual is fine), including parent cancellation and relevant started/cancelled boundaries. Serialize normal evidence-changing event inserts with the existing order lock so dispatch cannot race a cancellation. Preserve equal-timestamp F6 verification/completion pairs. Add focused post-completion cancellation/reopen/new-valid-attempt cases and an actual two-session cancellation/dispatch fixture.

2. **P1 — classic/shared duplicate dispatch credit.** New dispatch checks earlier events, but no dispatch insert guard exists. Classic inserts `dispatched` directly; F6's installed guard only covers framing credit. Add a narrow new guard in 0056 taking the same order lock and refusing a classic duplicate after a saved shared-dispatch receipt. Preserve CS exceptions, shared pre-receipt insertion and ordinary old classic behavior where no shared receipt exists. Cover both arrival orders, including classic event insertion held open without its deduction RPC. Stock idempotency alone does not prevent duplicate event credit. Revise the initial coder ruling that permitted duplicate dispatch rows.

3. **P2 — completion for another SKU is not evidence.** A completion currently matches person/work type but ignores SKU. Accept a whole-order completion (SKU null) or the required SKU; verification A plus completion B must remain missing. Keep legitimate same-SKU/whole-order completion valid.

4. **P2 — required dispatch parcel may be omitted.** When supplied validated lines contain `work_type = 'framed'`, require an object packaging payload. Current SQL/JSON null silently skips packaging yet saves the dispatch/stock/receipt. This is a bounded RPC safeguard analogous to F6 A0, not a request to duplicate Shopify routing. Test both null forms with no saved side effects; preserve A0-only/no-dispatch-parcel behavior.

5. **P2 — CSV attribution can silently truncate.** `fetchAttributionsForEvents` batches 200 event IDs but each can have up to50 SKU rows. An unpaginated response hits Supabase's row cap and returns success with missing cells blank. Add deterministic range pagination within each ID batch, ordered by dispatch_event_id and sku. One focused capped-response regression beyond1000rows is enough; no report redesign.

## Closed during the coder's own review

The initial Retry/awaitChoice finding is fixed by40b3e75: a known-rollback refusal may refresh evidence and ask again, while uncertain/priorUnknown payloads remain frozen. The regression covers measured preview -> definite framer_missing -> Retry -> missing -> choose -> save. Preserve that fix.

## Accepted practical implementation choices

- Separate dispatch_requests table avoids altering F6's installed restrictive CHECKs; preserve exact F6 activation/framing receipts and hashes.
- One dispatched event, no new dispatcher line_verified rows, matches classic and preserves Reports KPI counting.
- Dispatch-only scope suffix protects old framing queue keys and rollback behavior. New app processes jobs by their stored mode.
- One SQL evidence reader for preview and commit avoids a duplicate TypeScript rule engine.
- Explicit choice correction after a definite rollback is allowed; unknown outcomes stay immutable.
- Supported current SKU routes and conservative manual fallback are sufficient. No new dependency, broad rework engine, redesign or extra feature.

After fixes: focused regressions, one final required gate, fresh focused review; then Codex runs actual staging rollback/roles/concurrency/replay checks before installing exact reviewed0056. Combined hosted Preview/browser checks follow. Real scanners and real box-rule commissioning remain separate deployment setup.
