# Review: Return restock direction — round 1

- Slug: `return-restock-fix` · Branch: `feature/return-restock-fix` · Reviewed commit: `2450e5e767bbe6bbe84ad5d0e5e737e99a605932`
- Base: local `origin/main` at `8519ac9a9af66167903107d5ad8fb7a65e0278a9`; no fetch or state-changing git commands.
- Reviewer: planner (GPT-6 Astra)
- Date: 2026-11-25
- Verdict: **changes required**

The sign correction is right in both adapters. However, reverse-all-then-reapply is unsafe with the existing zero floor, and the new closed-state predicate permits new credit through edits to an existing line. The production adapter also retains partial-write/retry hazards. These prevent approval of the inventory behavior.

## Checked against

- [x] Spec acceptance criteria — no spec by instruction; reviewed against CJ's direct requirement, “restock should add,” and ARCHITECTURE finding 4.
- [x] Plan tasks — no plan for this small fix; no missing-plan blocker. Examined all four changed files, including the additional closure rule.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist) — findings below.
- [x] `docs/HARDENING.md`, every section — applicability and results below.
- [x] Roadmap decisions — no dedicated return-restock feature; cross-cutting live-production, history and rollback requirements apply.
- [ ] Tests cover the new logic; type-check, tests and build pass — type-check passed; tests/build could not load Vite configuration in this sandbox; coverage gaps remain.

## Must-fix

1. **P1 — An unchanged save can manufacture stock after consumption.** `src/lib/domain/csReturnStock.ts:65` and `:73`, called from `DexieRepo.ts:1108` and `SupabaseRepo.ts:1212`. Both adjustment implementations floor stock at zero. Reproduce: start at 0, receive/restock 3, consume 2 elsewhere, then save the unchanged return (received, RTS or closed). Reversal applies `+3`: stock 1 becomes 0; reapplication applies `-3`: stock becomes 3. Expected stock is still 1. This also affects quantity decreases: at stock 1, changing credited quantity from 3 to 2 leaves 2 instead of applying a net removal of 1. The helper was executed in memory and reproduced these unchanged-save failures. Fix by calculating the change between previous and desired credited quantities per product before adjusting stock, so an unchanged credit generates no movement. Define an explicit insufficient-stock policy for real reversals/deletes/product changes; do not silently discard an unreversed amount and claim the original credit was fully undone. Add consumed-stock regressions, including multiple lines sharing a product and closure/reopening. The reverse-all pattern existed previously, but reversing the signs makes the first leg a clamped removal and exposes this stock-creation failure.

2. **P1 — Closed does not actually mean “keep an already-applied credit, never create one.”** `src/lib/domain/csReturnStock.ts:46` checks only line ID and the prior boolean, then `:73` credits the incoming product and full incoming quantity. Starting at P1=10, receive 3 (P1=13), close, and edit the same closed line to quantity 5: P1 becomes 15. Reusing its ID for P2 reverses P1 and creates a new P2 credit. Both results were reproduced against the helper. Quantity editing is available in the closed modal (`src/pages/CsReturns.tsx:723`, `:936`), so the first case is an ordinary UI operation. Preserve the previously credited product/quantity while closed, or reject stock-changing edits until the return is reopened to received/RTS; make reductions/removal/unticking explicit as well. If CJ wants closed-state corrections to create additional credit, document that different rule and its acceptance tests instead of claiming closure never creates credit. Cover same-ID product changes, quantity increases/decreases and newly added/replaced line IDs.

3. **P1 — Supabase writes are not retry-safe or atomic with the credited flag.** `src/lib/repository/supabase/SupabaseRepo.ts:1228` applies credit before the parent/lines persist at `:1251`–`:1267`; delete reverses stock at `:1283` before deleting the parent at `:1292`. Example: fresh receipt credits 3, parent write fails, retry sees no previous credited lines and adds another 3. Failure after deleting old lines but before inserting replacements loses the evidence needed to reverse the credit. Two clients reading the same uncredited state can each add 3; product row locks serialize individual adjustments, not the return operation. Moreover, previous-state read errors at `:1194`, `:1203`, and `:1275` are discarded: a failed read can be treated as no prior credit, or permit deletion without reversal. The ledger source strings are labels, not enforced idempotency keys in `0002_rpc.sql`. This is inherited ARCHITECTURE finding 5, not newly introduced transaction plumbing, but it directly invalidates the claimed safe restock behavior and HARDENING section 1. Make each save/delete an atomic, serialized return operation with checked reads and retry/concurrency semantics, covering creation as well as existing rows. A new RPC must be append-only, authorized for the location and validated before inventory changes; CJ applies SQL. Dexie's enclosing transaction should retain equivalent behavior. A client-only try/catch or reversal retry is insufficient after an ambiguous committed RPC response. Record any needed scope expansion for CJ rather than silently redesigning beyond this review.

4. **P2 — Inventory tests do not cover the failures or repository boundaries.** `src/lib/domain/__tests__/csReturnStock.test.ts:75` calls a simulated save with ample stock and labels it idempotent. The 15 added tests provide useful sign/basic-transition coverage, but never call either repository, execute SQL, verify the actual ledger, inject failures, or exercise competing writers. Add regressions for findings 1–3, consumed-stock delete/reversal, removed lines, closed→received→closed, RTS↔received, restock off→on while closed, duplicate IDs and invalid/missing products. Verify adapter argument signs, flags and transaction rollback, then run the required suite/build successfully in a permitted environment and verify staging SQL/RLS behavior. Helper tests alone cannot prove backend equivalence or exactly-once credit. The tests must assert business outcomes, not just reproduce reverse/reapply in their harness.

## Should-fix

1. `src/pages/CsReturns.tsx:732` and `:1058` — the impact preview adds the full quantity to current stock even for an already-credited unchanged return, and omits closed-state changes. Use the final net movement rule for the preview. An unchanged save should show no new credit; closing should explain retained credit.
2. `src/lib/domain/csReturnStock.ts:70` — reject duplicate incoming line IDs and invalid quantities/products before applying movements. Two incoming copies of `l1` produce two credits but only one flag in the map. An in-memory reproduction from stock 10 with an existing 3-unit credit produced stock 16. Dexie `bulkPut` can retain only one row for that key; Supabase insert rejects duplicates after earlier stock RPCs have committed. The normal UI generates fresh IDs, so this is an inherited boundary-validation weakness, but it needs a regression alongside the transaction fix. Missing products also differ: adjustment can silently do nothing, Dexie can persist a credited line, whereas SQL's product FK rejects persistence. Never set a successful credit flag after a missing-product no-op.

## Nitpicks

1. `DexieRepo.ts:1091` and `SupabaseRepo.ts:1188` call reverse/reapply “bulletproof.” Remove that assertion when correcting the algorithm; the zero floor and request boundaries disprove it.

## Sign and transition audit

`DexieRepo.ts:155` computes `Math.max(before - delta, 0)`. `supabase/migrations/0002_rpc.sql` defines `adjust_on_hand` with `GREATEST(v_before - p_delta, 0)`; `SupabaseRepo.ts:206` forwards `delta` unchanged. Therefore **restock must pass `-quantity`; reversal/delete must pass `+quantity`**. Ledger deltas use actual natural stock change, positive inbound and negative outbound. The new helper gets those signs right. Reason `return` does not cascade the sale-only BOM. No later checked-in migration replaces `adjust_on_hand`; CJ still needs to confirm the deployed definition because the recovered schema is incomplete evidence.

Both adapters now consume exactly the same pure movement plan and derive `inventory_credited` from it. They agree for valid serialized successful saves with enough stock. They do **not** behave identically under partial failures, concurrent saves, invalid input or missing products: Dexie encloses return, lines, products and ledger in a transaction; Supabase uses separate requests and SQL constraints. Neither backend escapes finding 1 merely by wrapping the reverse/reapply pair in a transaction.

The following assumes unique line IDs, valid products, no failed requests, and sufficient on-hand for reversals unless stated otherwise:

| Transition/action | Current result | Assessment |
| --- | --- | --- |
| New/uncredited → received or RTS, Restock on | Adds quantity once; flag true | Correct sign. |
| New/uncredited → closed | No credit, flag false | Correct. |
| Received/RTS → closed, same credited line | Reverses then re-adds, flag true | Net unchanged only when reversal is not clamped. Retaining actual prior credit is a sound closure intent. |
| Initially uncredited closed → received → closed | Credits on received; retains on closed | One credit in a successful sequence. |
| Credited closed → received → closed; RTS ↔ received | Net unchanged with sufficient stock | No inherent duplicate from status switching; consumed-stock case fails finding 1. |
| Restock off or status new after credit | Removes quantity and clears flag | Correct sign; zero-floor loss requires an explicit policy. |
| Closed Restock off, save, then on, save | First reverses; second does not credit | Consistent with “no new credit while closed”; reopen to received/RTS to restock again. |
| Quantity/product edit while received/RTS | Reverse old product/quantity; credit new | Correct only absent clipping/failure. Quantity changes should use net deltas. |
| Same ID with changed quantity/product while closed | Credits the new quantity/product | Violates stated closure invariant; finding 2. |
| Replace credited line with fresh ID while closed | Reverses old; new line stays uncredited | ID is currently the sole credit identity. Normal remove/add UI generates a fresh ID. |
| Reuse old ID after its removal was saved | No previous row, hence no closed credit | No retained credit tombstone; received/RTS still credit normally. |
| Duplicate IDs / reuse another return's persisted ID | Multiple moves or storage collision/reassignment | Must validate IDs/ownership before stock changes; particularly unsafe in Supabase's separate requests. |
| Remove a credited line or delete return | Removes previously credited quantity | Correct sign with sufficient stock; clamped reversal may remove less than recorded quantity. Supabase retry can remove twice. |
| Delete never-credited return | No stock movement | Correct. |

## Existing data, release and rollback

The coder's report that live currently has no `cs_returns` rows was **not independently verified**. No production or staging database was contacted in this review. CJ should do the following before any release:

1. Pause return mutations during the cutover and use an authorized database-wide read, not a location-filtered/RLS-limited browser list, to confirm counts for `cs_returns` and `cs_return_lines` across AU, UK, US and any `default`/other location. Inspect all `inventory_credited=true` rows. Check return ledger history as well: zero current returns does not prove old returns were never created and deleted or that historical stock drift is absent. Check any actively used Dexie location databases separately; empty Supabase does not establish empty local stores.
2. Confirm deployed `adjust_on_hand` subtraction, zero-floor and authorization behavior, and the RTS constraint from `0015`. If there really are no return rows/lines and no unreconciled historical return effects, no return-row backfill is needed for this code-only sign change. Keep evidence of the verification and ensure old clients cannot write between the check and cutover.
3. If old credited lines exist, stop and reconcile before enabling new saves/deletes. The old `inventory_credited=true` means the old code attempted a **deduction**, not a real credit. New code cannot distinguish it. Example: starting at 10, old received quantity 3 leaves 7; an unchanged new save remains 7 rather than the intended 13, and a new delete leaves 4 rather than 10. Reconcile actual ledger changes and intervening stock activity, retaining an audit trail. Do not blindly flip flags, replay every return, or add `2 × quantity`: old deductions could have been clamped and historical saves/closures/deletes affect the result. Any repair is CJ's approved human database step, with backup and staging rehearsal.
4. After the blockers are fixed: require green CI, approved re-review, and the staging tests below. For the current commit there are no migrations, dependencies, environment variables, Shopify/Dropbox/Make/Slack settings or grants to change. If the transaction fix adds SQL, document its exact staging/production order and keep it expand-only. CJ records the rollback deployment, merges/deploys at a quiet time, and ensures all return users reload before resuming writes.
5. **An app rollback alone is not a safe return-data rollback.** Old code interprets new true flags with the wrong signs. For example, a new legitimate +3 restock takes 10→13; an old-code delete then adds another 3, leaving 16. Keep return writes paused during any rollback, including stale browser tabs. Leave saved data/ledger intact, compare stock with recorded transactions, and prefer fixing forward. Do not “disable” the feature by unticking Restock, changing statuses, deleting returns, or wiping/restoring the app backup: those actions mutate inventory, and the app backup omits returns. Resume only with code and credited-state semantics reconciled. Other app operations can be assessed separately by CJ.

## HARDENING checklist

### 1. Failure modes

- **Network/Supabase unavailable or slow:** save/delete await requests and the modal catches thrown errors (`CsReturns.tsx:761`, `:775`), but ignored previous-state errors and already-committed stock changes make recovery unsafe. Busy state prevents clicks in that modal, not other clients. Findings 1 and 3 block approval. Shopify lookup has a separate error display and manual SKU entry; Dropbox/Slack/Make are not part of this mutation.
- **Retry/idempotency:** successful high-stock resaves are net-neutral; low-stock resaves, failed creates/line inserts, response loss and retried deletes are not safe. A new UI create retry can generate a fresh parent ID (`CsReturns.tsx:740`) as well. Stable operation identity and atomic persistence are needed.
- **Concurrent people/devices:** Dexie transaction protects its local stores; Supabase has no return-level lock across the read/adjust/persist sequence. Test two clients saving/closing/deleting the same return, including first creation.
- **Bad input/site/order:** UI checks a selected SKU and positive finite quantity, but repository calls do not parse the schemas or reject duplicate IDs. SQL enforces positive integer quantities and a same-location product FK, after stock has already moved. Unknown/missing products and malformed payloads need rejection before mutation. Barcode/scanner parsing is n/a; no scanner path changes. Shopify cancellation/order-site validation is unchanged, and manual returns do not require a Shopify order lookup; this fix must not assume one validates the stock payload.
- **Visible failure/recovery:** thrown errors appear inline; ignored read errors can remain silent and query invalidation is on success only. After an ambiguous save, automatic or manual blind retry is unsafe. Stop return mutations and have the responsible owner reconcile ledger/stock until finding 3 is resolved.

### 2. Data correctness

- **Person/department attribution:** n/a to this stock-sign fix; it changes no production worker or department fields. Existing return creator fields are unchanged.
- **Shared counting rule:** stock movement rules are now shared between adapters, which is appropriate. Order/item/set KPI counting is n/a; quantities are explicit catalogue return units, not production set decomposition.
- **Historical correctness:** line credit identity, product/quantity edits, old wrong-sign flags and rollback are material issues above. Person/department/settings changes introduce no new behavior. Ledger records actual movement; a flag alone does not prove a full reversal or successful credit.
- **Time zones:** received/closed/updated timestamps still use `toISOString()` (UTC); display/time-zone code is unchanged. Site-local day aggregation is n/a to this quantity-only calculation; existing timestamp presentation is not certified by these tests.
- **Inferred/manual values:** no new inference. Returns/restock selections remain manual actions, with ledger reason `return` and return/line source references; no measured KPI claim is introduced.

### 3. Security

- **Endpoints/input authentication:** no new endpoint or auth boundary. Existing `adjust_on_hand` checks location membership; return table policies in `0009` do likewise. Required input-validation improvements are listed above. Any replacement RPC must preserve these checks and must not trust client-provided credited flags.
- **RLS/roles:** no new tables/policies/grants. CS, owner and manager behavior must be tested against actual staging policies. Staff/kiosk route restrictions are not database authorization: the existing return policies permit location members. This branch does not tighten that broader pre-existing model.
- **Secrets:** no added environment values, credentials, logging of secrets or server/client secret-boundary changes in the diff.
- **Cost/spam/exposure:** no new external paid API, messaging or read-data exposure. Repeated or malformed writes can corrupt stock, as described; existing location checks must still reject another site's writes.

### 4. Release and rollback

- **Expand-only compatibility:** no schema change in this commit, so schema compatibility is preserved. Semantic compatibility of old/new credited flags is not; the old-data and rollback procedures above are mandatory.
- **Switch off without deploy:** no stock-return feature flag exists. The practical incident fallback is to pause return edits operationally, not to toggle restock flags. A navigation change alone would not block existing tabs/direct writes.
- **CJ release order:** recorded above; no agent merge/deploy/SQL. No new configuration for the current patch. Transaction changes need an explicit amended release sequence.
- **Staging per role:** use only staging Supabase/disposable Dexie data, following the matrix below. CI and local compilation cannot replace role/SQL tests.

### 5. Performance

- **Long event scans/indexing:** no new historical-event scan. Existing per-return lookups use location/return keys and `cs_return_lines_return_idx`; parent PK is `(location,id)`.
- **Per-item requests:** Supabase still makes one stock RPC per reversal and credit, plus parent/line requests. No new Shopify/Dropbox call per item, but unchanged saves unnecessarily double ledger/RPC work. Net movements and an atomic return operation address this.
- **Two years/three sites:** no new cross-site fan-out. Closed matching is quadratic in the number of lines (`some` per incoming line), normally small; replace with keyed lookup if needed. Existing unpaged return-list reads are a separate scalability limitation, not fixed or newly introduced here. No two-year load test was run.

### 6. Operations

- **Detection:** no new health indicator/alert. Inline errors and ledger entries are available, but neither detects every mismatched flag or silently duplicated credit. CJ should compare the first real return movements with expected stock deltas and inspect return-related errors/ledger during the first 30 minutes. Browser-originated Supabase failures are not necessarily Vercel function errors.
- **Manual fallback:** stop return inventory mutations, record physical receipts/refunds separately with order, SKU, units, site and time, then reconcile once before entering them after recovery. Production need not depend on saving a return to continue unrelated work.
- **Ongoing maintenance:** no new subscriptions/tokens/storage service. Reverse/reapply creates avoidable ledger growth; monitor actual return deltas and anomalies, not just row-save success.

### 7. Tests

- **Pure logic/edge cases:** 15 new unit tests cover sign, initial received/RTS, new/unchecked, high-stock resave, closure preservation/no initial closed credit, status new, unticking including closed, quantity/product edits while received, mixed restock flags, and delete. Missing cases are specified in must-fix 4.
- **Inventory old/new behavior:** the 10→13 assertion would catch the old wrong sign and closure assertions capture the intended changed behavior. There is no old-data fixture, actual adapter/SQL ledger test, failure/concurrency coverage, or consumed-stock case. The title “idempotent” is stronger than the tested condition. No full-suite pass is claimed here.

## Staging acceptance and verification evidence

After corrections, CJ/coder should run the same stock/ledger scenarios in disposable Dexie and staging Supabase:

1. **Owner, manager and CS at an authorized site:** create an uncredited return; receive/restock 3; verify stock +3 and ledger +3 exactly once. Save unchanged, close, reopen, cycle RTS/received, edit quantities, remove lines, change products through allowed flows, untick/restock, and delete. Assert both stock and flags, including the agreed closed-edit policy. Repeat after consuming returned units so on-hand is 0, 1 and less than the credited quantity. Include two lines for the same product at the repository boundary.
2. **Two authorized clients:** concurrent receive, edits and delete/save races; lose the response after a committed save, retry the same operation, and interrupt persistence. Stock, ledger and return/lines must remain consistent with one accepted operation or an explicit conflict, never partial success. Reject duplicate IDs, invalid quantities, missing products and line IDs owned by another return before stock changes.
3. **Staff and kiosk:** confirm default route visibility remains as intended; do not mistake hidden navigation for denied database access. **Unauthenticated and wrong-location users of every role:** mutations must fail without stock, ledger or return changes. Validate CS access to the authorized RPC/return tables as well as owner access.
4. **AU, UK, US isolation:** repeat using fake local products and verify no other location changes. Rehearse old credited-data reconciliation and rollback/write-pause handling with synthetic fixtures, then perform the existing `docs/RELEASING.md` smoke checks.

Local commands were attempted with process-local `VITE_BACKEND=dexie`; no database was used:

| Check | Observed result |
| --- | --- |
| `npx tsc -b` | PowerShell's `npx.ps1` wrapper was blocked by execution policy; equivalent `npx.cmd tsc -b` then passed, exit 0. |
| `npm run test -- --run` via `npm.cmd` | Exit 1 before test discovery: esbuild reported `Cannot read directory "../../../../..": Access is denied` and could not resolve/load `vite.config.ts`. No tests executed by Vitest. |
| `npm run build` via `npm.cmd` | Exit 1: TypeScript phase completed, then Vite/esbuild hit the same directory access restriction loading `vite.config.js`. No successful production build. |
| Supplemental in-memory helper checks | Node loaded the actual helper through TypeScript `transpileModule`, without writing a test file. Confirmed consumed-stock unchanged saves produce 1→3 for received/RTS/closed; closed quantity 3→5 adds 2; same-ID closed product replacement credits P2; normal high-stock closed/received/RTS cycles retain one credit and delete reverses it; duplicate IDs produce excess credit. These are focused reproductions, not a replacement for Vitest or SQL tests. |
| Remote CI, browser staging, deployed SQL/RLS | Not run/verified in this review. Required before release. |

The test/build failures are environment/config-loading failures, not evidence of failing application assertions. A successful rerun is still required. Only this review document was authored; no app code, migration, spec or plan was edited, and no commit/push/merge/deploy was performed. The pre-existing untracked `.claude/launch.json` and `supabase/.temp/` were left untouched. Normal compiler-generated ignored artifacts may be produced by the requested checks.

## Coder response

Commit: `review r1: net restock moves, closed-edit guard, checked reads` (on top of `4866b0c`).

**Must-fix 1, zero floor / unchanged saves: fixed.** `planCsReturnStock` no longer reverses and reapplies. It sums credited units per product before and after the save and moves only the net difference (`moves[]`, one `adjustOnHand` per product). An unchanged save moves nothing in received, RTS or closed, and a quantity decrease moves only the decrease. Both adapters use the same plan. Insufficient-stock policy, documented in the module: a removal (untick, back to New, smaller quantity, remove line, delete) is clamped at zero by `adjustOnHand`, like every other stock movement in the app (shipments, cases, sales). The ledger records the actual change; the line flag records the business state. I did not add a separate "unreversed remainder" record; that would be a new design for CJ to decide. Tests: unchanged saves after consumption for received/RTS/closed, net decrease at low stock (1 → 0, not 1 → 4), two lines sharing a SKU, RTS ↔ received, closed → received → closed.

**Must-fix 2, closed edits: fixed by rejecting them.** While Closed, a credited line keeps its credit only if its SKU and quantity are unchanged. Changing either throws `CsReturnStockError` ("Move it back to Received to correct them") before any stock call. Unticking Restock or removing the line while Closed still takes the units back out. Reticking while Closed does not re-add, and a new line added while Closed is not credited. No closed edit can create credit. The modal shows the same message before saving.

**Must-fix 3, Supabase atomicity: partly fixed; the rest needs CJ's decision.**
- Fixed: every previous-state read (`cs_returns`, `cs_return_lines` on save and delete) now throws on error, so a failed read can no longer be treated as "no earlier credit". All validation runs before the first stock call: duplicate ids, quantities, missing SKUs (checked against `products` for this location), and line ids owned by another return. Adapter tests prove no `adjust_on_hand` call happens in each of these cases.
- Not fixed: stock RPCs and row writes are still separate requests, so a save that fails after its stock call, or two clients saving the same return at once, can still double-apply. This is ARCHITECTURE finding 5. Cases and shipments have it too, and it is not caused by this fix. Fixing it properly needs a new `upsert_cs_return` / `delete_cs_return` RPC (row lock on the return, net moves and row writes in one transaction, location check). That is an append-only migration CJ would apply. I've recorded it for CJ instead of adding SQL to a fix CJ asked for as code-only. Net moves already make it much smaller: a retried unchanged save is now a no-op, where before it reversed and re-added.

**Must-fix 4, tests: fixed.**
- `src/lib/domain/__tests__/csReturnStock.test.ts`: 30 tests covering direction, unchanged saves after consumption, closed rules, edits, removals, the clamp, delete, and input checks.
- `src/lib/repository/supabase/__tests__/csReturnStock.adapter.test.ts`: 7 tests running the real `SupabaseRepo.upsertCsReturn`/`deleteCsReturn` against an in-memory client. Its `adjust_on_hand` mirrors `0002_rpc.sql`. They assert the exact `p_delta` signs, ledger deltas, persisted flags, and no stock call on rejected input or a failed read.
- Dexie has no IndexedDB test harness in this repo. Adding `fake-indexeddb` would be a new dependency, so I left it out. Dexie runs the identical plan inside its existing single transaction.
- Concurrency and SQL/RLS behaviour need the staging run (see release).

**Should-fix 1, preview: fixed.** The modal runs `planCsReturnStock(initial.lines, status, lines)`. It shows the net per-SKU change (for example "+3 P1 (after: 13)"), nothing on an unchanged save, the closed-edit error when it applies, and "Units already restocked stay in stock when this return is closed."

**Should-fix 2, input validation: fixed.** Duplicate ids, non-integer or non-positive quantities and missing SKUs are rejected in the shared plan. Missing products are checked (Dexie inside its transaction, Supabase by a location-scoped read), and line ids owned by another return are checked in both adapters. All of this happens before stock moves. A SKU is only required to exist when units are being added to it, so a line whose SKU was later deleted can still be removed.

**Nit: fixed.** "Bulletproof" comments removed; the Supabase docblock now says the save is not atomic and points here.

**Release data verification (read-only, live `lkboboagiikvozvbcpvg`, 2026-11-25, SQL connection so not RLS/location-filtered):** `cs_returns` 0, `cs_return_lines` 0, lines with `inventory_credited` 0, `ledger` rows with `reason='return'` 0. No old wrong-sign credits exist, so no reconciliation or backfill is needed. Production uses Supabase; Dexie is the local single-user mode. CJ should re-run that query just before release and make sure no returns are created in the meantime (CS shouldn't log returns until the deploy is done).

**Checks:** `npx tsc -b` clean; `npm run test -- --run` 419 passed (5 files); `npm run build` passed.

STATUS: COMPLETE
