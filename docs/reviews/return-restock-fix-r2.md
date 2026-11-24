# Review: Return restock direction — round 2

- Slug: `return-restock-fix` · Branch: `feature/return-restock-fix` · Reviewed commit: `2f89adc59fb5a95e20f8ce2531e68ea6a31afd1a`
- Base: local `origin/main` at `8519ac9a9af66167903107d5ad8fb7a65e0278a9`; reviewed the complete branch diff, without fetching or changing git state.
- Reviewer: planner (GPT-6 Astra)
- Date: 2026-11-25
- Verdict: **changes required**

The net-per-product calculation fixes the consumed-stock resave defect, and the closed-edit rejection fixes the unintended new credits. The modal now uses the same calculation. The remaining blocker is incomplete SKU preflight: an unchecked line with a missing product can still cause a deterministic SQL rejection after another line has moved stock. This is a small code-only correction within round 1's validation requirement, not a demand to implement the deferred transaction redesign.

**Atomicity decision:** round-1 must-fix 3 may be deferred as an explicit CJ release condition for this narrowly scoped fix. Its checked-read portion is resolved; atomicity itself is not. After the blocker below is corrected, this patch can be **approved with conditions**, subject to the release gates below. Zero existing returns addresses old-data compatibility; it does not make future failed or concurrent saves safe.

## Checked against

- [x] Spec acceptance criteria — no separate spec, as accepted in round 1; reviewed CJ's code-only requirement that restocking adds inventory and the accompanying closure behavior.
- [x] Plan tasks — no separate return-restock plan exists; reviewed all seven changed files and every round-1 response. No missing-plan blocker or unrelated app change.
- [x] AGENTS.md guardrails — both adapters use the shared rule; repository interface, dependencies, migrations, permissions and environment configuration are unchanged. No app code or SQL was edited during this review.
- [x] `docs/HARDENING.md`, every section — assessment below, including residual risks rather than a claim that all requirements are satisfied.
- [x] Roadmap decisions — no dedicated return-restock item; production safety, history and rollback requirements apply. Also read `docs/ARCHITECTURE.md` and `docs/RELEASING.md`.
- [ ] Tests cover the new logic; type-check, tests and build pass — type-check passed here; test/build configuration loading was sandbox-blocked. New tests materially improve coverage but miss the blocker below. The coder reports 419 passing tests and a successful local build; that is reported evidence, not an independently reproduced pass.

## Must-fix

1. **P1 — Validate every incoming line's product before moving stock, including lines that will not be credited.** `src/lib/domain/csReturnStock.ts:122` derives `productIds` only from `nextTotals`, so `SupabaseRepo.ts:1219` and `DexieRepo.ts:1110` check only credited products. However, `supabase/migrations/0009_cs_returns.sql:64` requires an existing same-location product for **every persisted line**, regardless of Restock or status.

   Reproduce with P1 on-hand 10 and no saved return: save Received with `l1 = P1, quantity 3, restock=true` and `l2 = missing-product, quantity 1, restock=false`. The plan checks only P1, calls `adjust_on_hand(-3)`, saves the parent and deletes previous lines, then the line insert fails its product FK. Stock is 13 and there are no saved lines recording that credit. Retrying the same parent ID credits P1 again, to 16. A stale catalogue in an open new-return modal is a plausible source of the missing product; malicious input is not required. An unchanged existing return with an invalid added unchecked line can also lose its old line records at the replacement step even when its first save has no stock movement.

   **Evidence:** executed the actual helper and `SupabaseRepo` in memory using the test's FakeDb/FakeQuery, adding only a simulated insert-time product FK check matching `0009`. The two attempts produced stock 13 then 16, one persisted parent, zero lines and two +3 ledger entries. This is a focused adapter reproduction, not execution of Postgres. The checked-in fake does not enforce this FK and therefore conceals the failure.

   **Required correction:** check the distinct product IDs in all incoming lines before any movement or persistence, in both adapters. Continue allowing removal of a historical missing-product line by excluding omitted previous lines from this validation; no incoming invalid row needs to be persisted to permit removal. The coder's rationale that only credited products must exist is not sufficient for SQL's schema. Add a mixed valid-restocked/missing-unchecked regression asserting rejection with no RPC, no parent/line changes and no ledger change; cover preservation of an existing return's lines as well as creation. Correct the helper test at `csReturnStock.test.ts:251` if its expected product list is used as the validation contract. No migration or new dependency is needed.

## Should-fix

1. **Make the adapter fake's limitations explicit and improve the relevant failure coverage.** `src/lib/repository/supabase/__tests__/csReturnStock.adapter.test.ts:13–72` is useful for call signs and application sequencing, but it does not implement FK/unique constraints, parent-delete cascading, write failures, authorization or transactions. Its missing-product RPC throws, whereas `0002_rpc.sql` returns a no-op; it writes a zero-delta ledger entry where SQL skips one. The delete test checks only the parent and stock, so it does not establish that a second delete is harmless or that lines disappeared. Add the regression required above, and preferably targeted parent/product/ownership-read failures, clamped delete ledger assertions and cascade-aware repeated-delete coverage. Do not describe these tests as SQL/RLS or transaction-rollback verification. A new IndexedDB dependency is not required for this patch; real Dexie verification remains a staging/local-browser gate.

## Nitpicks

1. `src/pages/CsReturns.tsx:1065` displays the requested net removal, while its `after` value correctly applies the zero floor. With one unit on hand and a requested removal of three, it displays “−3 … (after: 0)” although the actual ledger delta is −1. Optionally label the quantity as requested, or distinguish the clamped actual removal. This does not invalidate the corrected preview calculation and is not a release blocker.

## Round-1 disposition

| Finding | Round-2 result |
| --- | --- |
| Must-fix 1: reverse/reapply manufactures stock after consumption | **Resolved for the stated algorithm defect.** `netMoves` subtracts previous credited totals from desired totals per product and emits one movement per changed product. Unchanged received/RTS/closed saves emit none; redistributing quantities across lines for the same product also emits none. Both adapters and delete use this rule. The documented zero-floor policy for actual removals is acceptable for this bounded fix, with the limitation below. |
| Must-fix 2: closed edits create new credit | **Resolved.** A retained credited line with Restock on must keep its product and quantity or the helper throws before adjustments. New/replacement IDs do not inherit closed credit. Unticking/removal reverses; reticking after a saved closed untick does not credit. Changing quantity while also unticking is permitted because it removes the old credit and creates none. Reopening to Received/RTS permits corrections as instructed. |
| Must-fix 3: unchecked reads and non-atomic Supabase operations | **Partly resolved; transaction work may be deferred with CJ acceptance.** Parent/previous-line/delete reads now check errors; product and ownership reads also check errors. No new return-level transaction or serialization exists. The claimed validation-before-move protection is incomplete as described in this review's must-fix 1. |
| Must-fix 4: test gaps | **Substantially improved, not fully closed.** Source contains 30 helper cases and seven real-adapter/fake-client cases. They cover consumed-stock resaves, net quantity changes, shared products, closure/reopening, RTS, removals, invalid IDs/quantities and basic read failures. Closed product changes are covered in helper tests. The mixed invalid-line regression is required; real SQL/RLS, concurrent writes, late failure and Dexie rollback remain unverified. |
| Should-fix 1: misleading modal preview | **Resolved**, apart from the optional clamp wording above. `CsReturns.tsx:735` uses the shared plan against initial saved lines; unchanged saves show no new credit, closing explains retained credit, and closed-edit errors are visible. The hook is unconditional. Preview uses the modal/catalogue snapshot, while save re-reads server state, so it remains an estimate under concurrent changes. |
| Should-fix 2: input validation | **Partly resolved.** Empty/duplicate IDs, blank product IDs and non-positive/non-integer quantities are rejected by the helper; both adapters reject line ownership conflicts and missing credited products before movement. Missing uncredited products remain a blocker. |
| Nit: “bulletproof” claims | **Resolved in the changed return methods.** Comments describe net movements and explicitly disclose Supabase's separate requests. |

The insufficient-stock policy is a bounded removal, not exact historical reversal: after consuming returned stock, removing a three-unit credit with one unit left removes only one and clears the business credit state. There is no persisted two-unit debt. A later deliberate receive/restock can add the full quantity again. The new algorithm prevents an **unchanged** save from manufacturing stock; it does not promise that all edit/undo cycles are lossless after consumption. This policy is now documented and tested, so it does not independently block this patch; CJ should accept it with the operating procedure.

## Atomicity ruling and CJ conditions

Requiring a transaction migration in this code-only patch would expand CJ's stated scope to address inherited ARCHITECTURE finding 5. Deferral is reasonable because this patch fixes a deterministic wrong-sign error and removes unnecessary stock movements without creating the multi-request architecture. Cases and shipment save workflows have related limitations, although shipment-specific atomic RPCs are not evidence that returns are protected. The response records the unresolved issue honestly. The remaining deterministic preflight omission above is small enough to fix within scope and must not be folded into that deferral.

The coder's statement that “a retried unchanged save is now a no-op” needs qualification: it holds after a fully persisted prior operation whose stored credited totals match. If stock committed but the parent/lines did not, a retry can still double-credit; after a failed delete it can remove stock again. Two clients can both read the same state and apply the same net delta. Losing a response after a fully committed **new modal create** can also lead to a fresh parent ID on retry (`CsReturns.tsx:749`). Product-level locks and source labels do not serialize/deduplicate the whole return.

Before release, CJ must:

1. Accept and record the residual partial-write/concurrency risk, the zero-floor policy, and ownership of the separate atomic save/delete follow-up. That follow-up must cover first creation as well as existing returns, stable retry identity, location authorization, validation and serialized stock/ledger/row persistence. It requires an append-only migration with CJ-controlled application. This review does not claim that such a migration exists or has been approved.
2. Establish an interim operating procedure: one coordinated return writer at a time; after any ambiguous failed save/delete, stop return mutations and reconcile parent, lines, stock and ledger before retrying. Single-writer operation reduces concurrency risk but does not eliminate partial failure. Record physical receipts/refunds separately while writes are paused. If CJ cannot accept these limitations, atomicity must remain a release blocker instead of being silently waived.
3. Obtain the code/test correction above, successful suite/build evidence for the corrected head, green PR CI and staging acceptance. This verdict is not permission to merge or deploy the current head.
4. Reconfirm the reported empty-data precondition immediately before cutover: database-wide counts of returns, lines, credited lines and ledger reason `return`, across every location, with writes paused. The coder reports all four counts zero on 2026-11-25 from a non-RLS-limited live SQL connection; I did not contact or verify production. Confirm no actively used Dexie store has old wrong-sign credits, or handle it separately. Verify deployed adjustment signs, clamp, membership checks and RTS support. Unexpected historical data requires reconciliation before enabling the patch.
5. Record the rollback target, deploy at a quiet time and require return users to reload. This branch has no SQL, environment, grant or external-service setup change. **Do not resume old-code return mutations against new credited flags after rollback**: old delete/reversal signs are incompatible. Pause writes, preserve the data/ledger, reconcile and preferably fix forward. Unticking Restock, deleting returns or restoring the app backup is not a safe feature-off switch; the backup omits returns.

## HARDENING assessment

| Section | Assessment |
| --- | --- |
| 1. Failure modes | Checked reads fail before adjustments; modal save/delete errors are caught and shown. Net plans make successful unchanged saves stock-neutral. Missing uncredited products remain the blocker. Network loss, late writes and competing clients retain the documented atomicity risk; mutation success-only cache invalidation can leave the display stale after partial failure. Shopify lookup remains separate and manual entry remains available; Dropbox/Slack/Make are not in this path. |
| 2. Data correctness | One shared rule controls both adapters and preview. Signs and net grouping are correct; closed edits cannot introduce credit. Caller-supplied credited flags are replaced by computed flags. The ledger records actual clamped deltas; credit state is not reversal debt. Historical wrong-sign flags require the release data gate. Worker/department/set attribution is n/a; timestamps still use UTC ISO strings, with site-local display behavior unchanged. Returns remain manually entered, with return/product ledger references. |
| 3. Security | No new endpoints, secrets, tables, grants or RLS changes. Reads/writes retain location filters and existing RPC authorization. Return policies permit location members; route visibility is not a database boundary. Adapter fakes do not verify any role or RLS behavior. Input validation has the specific gap above. No new paid/external API exposure. |
| 4. Release and rollback | Schema is unchanged, but old/new credited semantics are incompatible for return operations. CJ-only release, explicit risk acceptance, empty-data verification, reload/write pause and rollback reconciliation are required. There is no technical feature-off flag. Staging matrix follows below. |
| 5. Performance | Net moves reduce RPC/ledger work to changed products, and zero movement means no stock RPC. Supabase batches product/ownership lookups; existing per-return line index supports reads. No historical scan or external API per item was added. Dexie performs local per-line/product reads within its transaction. Existing unpaged return lists and large-data limits are not solved; no two-year/three-site load test was run. |
| 6. Operations | No new health alert or service maintenance. Inspect first real returns and browser/Supabase errors, stock and ledger during the first 30 minutes. A successful row save alone is insufficient evidence of consistency. Stop/reconcile on ambiguous errors; manual physical receipt/refund records are the fallback. |
| 7. Tests | New tests provide meaningful sign, state-transition and consumed-stock regressions. Adapter tests exercise production TypeScript but simulate storage/RPC behavior; they do not establish Postgres atomicity, RLS, cascade or browser behavior. Add the blocker regression and retain the staging checks. |

## Staging acceptance and verification evidence

Use only disposable Dexie data and staging Supabase, never production for testing:

- As owner, manager and CS with location access: receive/restock 3 from stock 10 and verify 13, one +3 ledger delta and a true flag; save unchanged, close/reopen, cycle RTS/Received and repeat at stock 0 and 1 after consumption. Check quantity increases/decreases, two lines sharing a product at the repository boundary, removal, untick/retick, product replacement and delete. Compare actual ledger deltas with the documented clamp policy.
- Confirm closed quantity increases/decreases and same-ID product changes reject without writes; new closed lines do not credit. Exercise the modal preview and error display. Test the missing-unchecked-product regression on create and update, and line ownership/duplicate-ID/read failures.
- Verify staff/kiosk default navigation and authorized owner/manager/CS behavior. Wrong-location and unauthenticated writes must change nothing. Exercise AU/UK/US isolation. Existing location-member policies must not be mistaken for CS-only database authorization.
- Characterize late-write failures, lost responses, concurrent receives and delete/save races. These are expected residual risks until the atomic follow-up, not acceptance tests this patch is claimed to pass. Rehearse stop/reconcile handling and the rollback write pause; any release requires CJ's explicit risk acceptance. Run the ordinary `docs/RELEASING.md` smoke test as well.

Commands were run with process-local `VITE_BACKEND=dexie`; no database or external service was contacted:

| Check | Observed result |
| --- | --- |
| `npx.cmd tsc -b` | **Passed**, exit 0. |
| `npm.cmd run test -- --run` | **Blocked**, exit 1 before test discovery: esbuild `Cannot read directory "../../../../..": Access is denied`, then failed to resolve/load `vite.config.ts`. No Vitest assertions ran. |
| `npm.cmd run build` | **Blocked**, exit 1: TypeScript phase completed; Vite/esbuild hit the same directory restriction loading `vite.config.js`. |
| `git diff --check origin/main...HEAD` | Passed, exit 0. |
| Supplemental in-memory checks | Actual helper returned no moves for unchanged received/RTS/closed and rejected closed quantity increases/decreases/product changes. Actual Supabase adapter with a simulated `0009` product FK reproduced the mixed-line failure: 10→13→16 across two rejected saves, no saved credit lines. No test file or app code was written. |
| Coder's local evidence | Round-1 response reports type-check clean, 419 tests passing across five files, build successful. Not independently reproduced here; successful checks for the eventual corrected head and green CI remain required. |
| Browser/Dexie transaction, staging SQL/RLS, remote CI | Not run or independently verified in this review. |

Only this review document was authored. No app code, migration, spec or plan was edited; no commit, push, merge, deploy, SQL execution or state-changing git command was performed. The pre-existing untracked `.claude/launch.json` and `supabase/.temp/` were left untouched. Requested compiler checks may produce normal ignored build artifacts.

## Coder response

(Coder fills this in after fixing the remaining preflight gap and adding its regression. CJ records the atomicity decision and release evidence separately.)

STATUS: COMPLETE
