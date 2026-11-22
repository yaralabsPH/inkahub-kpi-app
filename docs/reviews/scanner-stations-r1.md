# Review: F6 shared scanner stations R1

Status: changes requested before staging. Read-only review of 119d52a..0df84ec (Task6 docs do not change implementation). Claude's initial full gate passes: tsc, digest/API typechecks, 940 tests/40 files, build. Local SQL assertions pass but no 0055 staging install yet. These concrete correctness findings take precedence over earlier implementation-log assumptions. Keep fixes focused; no new feature/platform/dependency.

## Required corrections

1. **P1 known unusable numeric badge becomes an old-worker order.** 0055:400-405 returns unknown_badge for nonexistent, inactive and wrong-site badges; session.ts:235-249 falls back order-shaped 10xxxxxx to the captured worker. Reject a known but unusable badge without disclosing other-site identity; only genuinely unknown tokens may fall back. Cover inactive and wrong-site numeric badges with an existing worker.

2. **P1 prior unknown save outcome is erased by a later refusal.** outbox.ts:371-375 and client.ts:318-320 clear uncertainty on every refusal. Saved/lost reply followed by revoked caller/site or unavailable RPC becomes dismissible despite a possible save. Preserve uncertainty from earlier attempts until matching receipt reconciliation; a first definitive refusal can still be blocked/dismissible. Keep UI truthful: an uncertain job must not say definitely not saved or invite classic re-recording. Existing SQL receipt-before-mutable-badge checks are correct. Cover unknown -> later refusal -> dismissal denied -> exact replay resolves.

3. **P1 classic/shared race double-credits production.** Shared commit locks/checks/inserts while classic Production direct event inserts take no order lock. Classic can insert verification/completion while shared is uncommitted; both get credit although later stock deduction skips. Add a narrow DB-boundary serialization/guard for relevant classic events versus shared commits. Preserve unrelated classic orders, later dispatch after framing, and explicit CS replacement paths; no general rework platform. Test both arrival orders with actual event/credit counts and stock. Rewrite R1 race expectation which currently allows duplicate completion. Installed migrations remain immutable; 0055 is new/unapplied and may be corrected.

4. **P2 stale lease finalization downgrades a saved job.** outbox.ts:358-383 has no lease ownership/generation fence. After B claims an expired lease and saves, A's old refusal can change done to blocked/uncertain:false while retaining saved outcome. Fence finalizers and prevent terminal success downgrade. Test expired lease plus late refusal/retry, not just normal claim exclusion.

5. **P2 legacy event ID ambiguity charges an arbitrary site.** 0055:309-313 chooses first accessible location for an ID despite PK(location,id). Reject more than one accessible matching event, retain legacy signature and normal unambiguous behavior. Test same ID in two accessible sites.

6. **P2 historical mixed-case source aliases can double-deduct.** 0055:243-249 checks supplied/code/id/upper/lower but old0031 stored arbitrary supplied case. Prior a0-Black and later canonical A0-BLACK or ID can evade this. Recognize existing order/product deductions by ledger product identity and an exact order-source prefix with indexed access. No historical mutation or backfill. Cover mixed-case and product-ID aliases.

7. **P1 rapid numeric scans silently lose an order.** session.ts:150-173 replaces pending activation before its guard; station.ts:156-157 silently ignores the first reply. Alice + scan10190203 + scan10190204 while lookup pending loses first and rejects second for no person. Loudly reject the second ambiguous frame while preserving the first request. Test explicit outcome for each frame.

8. **P1 caller changes can execute old jobs under a new account.** useSharedScannerStation.ts:100-113 uses mutable singleton auth; disposal doesn't stop already awaited processNext. Both activation and commit omit expected caller. Include captured caller in RPC contracts and check against auth.uid before side effects/replay, and stop initiating operations after disposal/scope change. Preserve old uncertainty. Test A -> delayed preparation -> authorized B -> old response; no old job saved as B. Do not rely on a pre-call client-only check which races token acquisition.

9. **P1 delayed lookup revives expired worker.** session.ts:237 restores lastFramingAt=response time; pending slots never time out. A lookup beyond ten minutes revives the worker for another ten minutes. Use original scan time for inactivity; the original captured order may queue, but expired identity stays clear. Bound pending activation and ignore late answers safely, with an explicit recovery message. Test late reply then unbadged order.

10. **P2 missing rules indefinitely stall all framing.** Hook:91-94 maps every packaging warning to network; client:284-287 requires it even for non-A0 jobs. Existing loadPackagingConfig warnings include definitive missing/invalid rules plus transport failure. Distinguish these minimally; only A0 needs packaging. Regular-only must proceed without box rules; A0 missing/invalid gets actionable classic fallback; actual transport failure keeps queue. Preserve F4 callers' behavior.

11. **P2 development-only StrictMode disables controller.** Hook memoizes controller then cleanup permanently disposes it; StrictMode setup-cleanup-setup reuses disposed instance. Use a restart-safe lifecycle. One meaningful StrictMode badge -> order -> saved regression, not a new test framework.

## Scope and positive findings

API exact-match/completeness flags are sound. Server canonical receipts, atomic stock/packaging, frozen payload and direct receipt-write restrictions are useful existing foundations. Keep 0055 as the single unapplied migration if practical, reuse current structures, and maintain clean classic fallback. These are corrections to approved F6 behavior, not added features. F7 must reuse phase-aware guards/caller fencing and distinct dispatch receipts later.

After fixes: focused regressions and updated SQL/race cases, one final full gate, fresh focused re-review; then Codex will run actual staging roles and two-connection races. Do not claim local PGlite establishes concurrent behavior or physical scanner commissioning.

## Coder response

All 11 fixed in `af2ab96` (0055 + staging SQL) and `90937ac` (client); docs and hashes in the next commit. 0055 edited in place (unapplied); nothing earlier touched.

1. Activation returns `unusable_badge` when the value exists in `staff_barcodes` anywhere but is not active here (nothing disclosed); the client treats it as a refusal, never an order fallback. SQL B02-B02d (hex and numeric, inactive and other-site); session and controller tests.
2. Outbox `priorUnknown` (set at `markAttempt` when the job was already uncertain); a commit-stage refusal keeps `uncertain` in that case; dismiss stays refused; the wall says "not confirmed / do NOT record on classic" and offers only Retry. Test: unknown -> refusal -> dismiss denied -> Retry replays the identical request -> saved.
3. BEFORE INSERT trigger `production_events_c6_scanner_guard` (framed/a0_framed line_verified/completed with cs_case_id NULL) takes the same `prod-order` advisory lock and refuses after a saved shared receipt for that work type. SQL M01-M09; R1 race now expects the classic insert to wait then fail; A-END checks credit counts for both arrival orders (R1, R2).
4. Per-claim lease token: `setPrepared`/`markAttempt` throw `LeaseLostError` (-> `superseded`), `markBlocked`/`retryLater` ignore stale tokens, `markDone` never rewrites done/dismissed. Test: expired lease, B saves, A's late refusal and retry-later leave it done/saved.
5. Legacy deduction raises `ambiguous_event` when more than one visible site has the id. SQL J11/J12.
6. Prior charge = any `prod:order_<n>:...` ledger row with the same product id (index `ledger_prod_order_idx` on site, `split_part(source_id, ':', 2)`, product; partial `LIKE 'prod:%'`). SQL J13/J14 (mixed case, foreign alias, id).
7. A hex8 scan while that scanner's check is pending is refused loudly (`badge_pending`) and the first is kept. Test: Alice + 10190203 + 10190204 -> first queued for Alice, second refused.
8. `p_expected_caller` on both RPCs, checked before replay and writes; client classifies `caller_mismatch` as wait (auth), never block; controller and `processNext` start nothing after disposal (`active()`). SQL B02e, C07b, C07c; test: delayed lookup, B signs in, station closed -> superseded, nothing sent; sent under B -> mismatch -> stays prepared; A again -> saved.
9. `PENDING_MAX_MS` 20 s: late answers ignored with a recovery message, plus a periodic sweep; the fallback identity is restored with the scan time. Test: a reply 15 s after a scan made 5 s before expiry queues the order, but a later unbadged order is `identity_expired`; a reply past the bound -> timedOut, no order.
10. `loadScannerPackaging` (scanner only; F4's loader unchanged) separates transport (wait) from scan/missing/invalid (classic reason); `processNext` asks for rules only when preparation says A0 needs them. Tests: regular-only never calls it; A0 transport waits; A0 missing -> blocked `packaging_not_auto`.
11. Controller is created inside the effect (fresh per run) and disposed in cleanup; UI effects wait for it. There is no DOM test environment (none added), so the regression drives the same setup -> dispose -> setup order on the controller: the disposed one starts nothing and the second completes badge -> order -> saved.

Checks: tsc, typecheck:digest, typecheck:api, 953/953 tests (40 files), build; local PGlite 02-assertions 160 cases pass (not staging evidence). Staging roles and two-connection races remain for Codex.
