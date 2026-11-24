# Review: Return restock direction — round 3 (final)

- Slug: `return-restock-fix` · Branch: `feature/return-restock-fix` · Reviewed commit: `c896094af96b7af0a5e0e58ac50169db7318b2e1`
- Base: local `origin/main` at `8519ac9a9af66167903107d5ad8fb7a65e0278a9`; complete branch diff reviewed, with particular attention to changes since `2f89adc59fb5a95e20f8ce2531e68ea6a31afd1a`. No fetch or state-changing git commands.
- Reviewer: planner (GPT-6 Astra)
- Date: 2026-11-25
- Verdict: **approved with conditions**

Round 2's must-fix is resolved: every incoming line's SKU is checked before stock moves or rows are written in both adapters. The fake-client corrections and regression coverage address the should-fix. The preview now displays the clamped actual movement; one optional wording nit remains. No new blocking defect was found since `2f89adc`.

This carries forward round 2's decision to defer Supabase atomic save/delete work with explicit CJ conditions. It does not certify atomicity, safe retries after partial failures, or concurrent-writer safety. The conditions below remain release gates; the coder's acceptance of them is not evidence that CJ has discharged them.

## Checked against

- [x] Spec acceptance criteria — no separate spec, as accepted in rounds 1–2; checked the requirement that restocking adds stock and the agreed closure behavior.
- [x] Plan tasks (all done, nothing extra slipped in) — no separate plan for this bounded fix; reviewed all eight branch-changed files and both previous reviews, including their Coder response sections. The latest delta changes only the shared validation list, its tests, the adapter fake/regressions, preview, and round-2 review.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist) — both adapters consume the same plan; no repository-interface, dependency, migration, auth, environment or external-service changes. Only this review was authored.
- [x] `docs/HARDENING.md`, every section — assessed below, with residual limitations explicit.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) — no dedicated return-restock item; cross-cutting production safety, history and rollback requirements apply. Read `docs/ARCHITECTURE.md` and `docs/RELEASING.md` as well.
- [ ] Tests cover the new logic; type-check, tests and build pass — source coverage reviewed and type-check passed here. Vitest/build were sandbox-blocked during configuration loading. The coder/user report 425 passing tests and a successful local build; this is reported evidence, not an independently reproduced suite/build pass.

## Must-fix

None remaining within the agreed code-only scope. Release remains conditional on the CJ gates below. The previously accepted atomicity deferral is unchanged.

## Should-fix

None newly required for this patch. The separate atomic save/delete follow-up remains required under the existing deferral conditions.

## Nitpicks

1. `src/pages/CsReturns.tsx:1075` — the clamp explanation says “N were restocked,” but N is the requested **net removal**, not necessarily the historical credit. Example: reduce credited quantity from 5 to 2 with one unit on hand; the correct movement is −1, after 0, but the suffix says “3 were restocked.” Prefer “requested removal: 3; stock stops at zero.” At zero on-hand the current sign formatting also shows “−0.” These are presentation nits, not incorrect saved stock or release blockers.

## Round-2 verification and disposition

### Must-fix 1: validate every incoming SKU — resolved

`src/lib/domain/csReturnStock.ts:127` now returns the sorted distinct product IDs from **all** `nextLines`, independently of status, Restock, or calculated movements. This includes unchecked lines and uncredited New/Closed lines. The helper test at `src/lib/domain/__tests__/csReturnStock.test.ts:251` now expects both credited and uncredited incoming products.

- **Dexie:** `DexieRepo.ts:1110` checks every returned product ID inside the existing transaction over returns, lines, products and ledger. Ownership and product reads precede the first adjustment at `:1120` and the first parent write at `:1145`. A missing incoming product throws before mutation. The location-specific database supplies location isolation.
- **Supabase:** `SupabaseRepo.ts:1219` awaits `assertReturnProductsExist`; its query at `:1280` filters by this location, checks read errors and rejects any missing ID. Ownership validation also completes before the movement loop or parent/line persistence. Thus the mixed valid-restocked/missing-unchecked payload cannot reach its first stock RPC or write.
- **Historical removal:** omitted previous lines do not enter `productIds`, so their removal is not blocked by a missing product. Net reversal behavior remains unchanged; a missing-product adjustment is a no-op. This does not waive validation for any invalid line that remains in the submitted payload.

The adapter regressions at `csReturnStock.adapter.test.ts:184` and `:196` cover both creation and editing an existing credited return. They assert no RPC, unchanged stock/ledger/parent/lines on create, and byte-for-byte preservation of all existing fake tables on update. The omitted historical SKU case at `:208` also preserves the valid product's stock. That last test deliberately constructs orphaned historical data in memory; it does not prove that ordinary Postgres product deletion can bypass the existing restrictive FK. The coder reports verifying that the first two regressions fail with the old validation list; I did not repeat that mutation of the source.

### Should-fix 1: fake fidelity and regressions — resolved for the requested scope

The header at `csReturnStock.adapter.test.ts:6` explicitly states that this is a real-adapter/in-memory-client test, not a Postgres, RLS or transaction test. It identifies unmodelled unique constraints, authorization, other write failures, concurrency and rollback.

The modeled behavior now agrees with the relevant checked-in `0002_rpc.sql` and `0009_cs_returns.sql`: missing-product RPCs return successfully without movement; zero actual movement produces no ledger row; all inserted lines are checked for a same-location product before the fake insert; deleting a parent cascades to its location-matched lines. These targeted models are not a complete database emulator.

Coverage now contains 30 helper cases and 13 adapter cases (six additional adapter cases since round 2). In addition to the mixed-line regressions, it covers failed parent/product reads, removal of a historical missing-SKU line, cascade-aware repeated deletion (`:161`), and consumed-stock deletion recording the actual −1 ledger delta (`:175`). Previous saved-line read/delete-read failure and ownership-conflict tests remain. A distinct injected ownership-read failure and real Dexie rollback are still not exercised; inspection confirms the ownership error is checked before movement, and real-backend behavior remains a staging gate. No new dependency is needed for approval of this patch.

### Preview nit and new-defect check

`CsReturns.tsx:1069` bounds a requested removal by current on-hand and uses that same actual value for both the displayed movement and projected balance. For stock 1 and requested removal 3, it now shows −1 and after 0. Additions and unchanged-save behavior retain the shared net calculation. The optional suffix correction above is the only new issue found in this delta; no new inventory or persistence blocker was identified.

The full branch still preserves the round-2 conclusions: additions use negative adjustment arguments, reversals use positive arguments, unchanged credited totals cause no stock movement, shared-product lines net together, and credited Closed lines cannot change product/quantity while retaining Restock. The preview uses a catalogue/return snapshot and remains an estimate under concurrent changes.

## Atomicity ruling and CJ release conditions

The round-2 deferral stands. Product preflight closes the deterministic missing-unchecked-SKU failure; it does not lock the catalogue or make the subsequent stock RPCs and parent/line requests one transaction. Late failure, lost responses, competing writers and a new modal create retry with a fresh parent ID can still leave inconsistent or duplicated effects. An unchanged save is stock-neutral only when its prior operation fully persisted matching credited state.

Before release, CJ must:

1. **Record risk acceptance and follow-up ownership.** Explicitly accept partial-write/concurrency exposure and the bounded zero-floor removal policy. Removal may consume less than the original credit, clear the business credit state and retain no reversal debt; a later deliberate receive can add the full quantity. Own the separate atomic save/delete follow-up covering first creation, stable retry identity, location authorization, validation, serialization and stock/ledger/row persistence. Any migration must be append-only and applied by CJ. If CJ cannot accept these limits, atomicity remains a release blocker.
2. **Establish the interim procedure.** Coordinate one return writer at a time. After any ambiguous failed save/delete, stop return mutations and reconcile parent, lines, stock and ledger before retrying. A single writer reduces concurrent saves but cannot prevent partial failure. Record physical receipts/refunds separately while writes are paused.
3. **Complete verification for this head.** The round-2 code correction is now satisfied. Retain successful type-check/suite/build evidence for `c896094`, require green PR CI, and complete staging acceptance below. The reported 425-test/build pass does not replace staging SQL/RLS or browser checks. This conditional review is not an instruction to merge or deploy.
4. **Reconfirm empty historical return data immediately before cutover.** With writes paused, obtain database-wide, non-RLS-limited counts of returns, lines, credited lines and ledger reason `return`, across AU/UK/US/default and any other location. Round 1's response reports all four counts zero on 2026-11-25; I did not contact production or independently verify them. Check actively used Dexie stores separately. Confirm deployed adjustment signs, zero floor, membership checks and RTS support. Unexpected old wrong-sign credits or historical effects require reconciliation before enabling the patch; do not blindly replay or flip flags.
5. **Preserve release/rollback discipline.** Record the rollback deployment, release at a quiet time, and require return users to reload before resuming writes. This patch needs no SQL, environment, grant or external-service setup changes. On rollback, keep return writes paused: old code's delete/reversal signs are incompatible with newly credited flags. Preserve rows/ledger, reconcile and prefer fixing forward. Unticking Restock, deleting returns or restoring the app backup is not a safe feature-off mechanism; that backup omits returns. CJ alone merges, deploys and applies SQL.

## HARDENING assessment

| Section | Result |
| --- | --- |
| 1. Failure modes | All incoming SKU/ownership preflight and checked reads precede movement. Thrown save/delete errors are displayed. Successful unchanged saves are neutral. Network loss, catalogue races, late writes and concurrent clients retain the explicitly deferred risk; success-only cache invalidation may leave stale displays after partial failure. Shopify lookup/manual entry is unchanged; other integrations are outside this mutation. |
| 2. Data correctness | Both adapters and preview share net rules, correct signs and closure guards. Computed credit flags override caller flags. Ledger records actual clamped movement, not reversal debt. Historical-data and rollback gates remain essential. Worker/department/KPI set attribution is n/a; UTC timestamp creation and site display code are unchanged. Returns remain manual records, with no new inferred metrics. |
| 3. Security | No new endpoints, tables, policies, grants, secrets or paid-service calls. Supabase queries retain location filters and the existing RPC membership check. Existing return RLS permits location members, not exclusively CS; route visibility is not authorization. Real role and cross-site denial checks remain unverified here. |
| 4. Release and rollback | No schema changes; old/new credited semantics still require paused return writes during rollback. No technical feature-off switch. CJ conditions and staging checks are explicit below/above. |
| 5. Performance | Validation uses distinct product IDs; Supabase batches product/ownership reads, Dexie reads locally inside its transaction. Net moves reduce RPC/ledger work. No historical scan or per-item external-service call was introduced. Existing list limits and two-year/three-site capacity are not certified by this review. |
| 6. Operations | No new alerting or token/subscription maintenance. Inspect first real return stock/ledger results and browser/Supabase errors for the first 30 minutes. Row-save success alone does not prove consistency. Stop/reconcile and separate physical receipt/refund records are the fallback. |
| 7. Tests | Inventory regressions cover signs, consumption, closure, net edits, validation and modeled adapter effects. Fake limitations are now explicit. Full suite/build execution was blocked here; SQL/RLS, actual IndexedDB rollback, browser rendering and concurrency remain staging/follow-up responsibilities. |

## Staging acceptance and verification evidence

Use disposable Dexie data and staging Supabase only:

- As owner, manager and CS with location access: receive/restock 3 from stock 10; verify 13, one +3 ledger delta and true credit flag. Save unchanged, close/reopen and switch RTS/Received; repeat after consumption to stock 0 and 1. Cover quantity edits, shared-product lines, product replacement, removal, untick/retick and delete, checking actual clamped ledger deltas and flags.
- Verify closed credited product/quantity edits reject without writes, new Closed lines do not credit, and the preview/error display agrees with save. Run missing-unchecked-product create/update rejection and preservation checks in both adapters, plus duplicate IDs, ownership conflicts and failed reads. Verify actual Dexie transaction rollback separately.
- Verify default staff/kiosk navigation; authorized owner/manager/CS operations; unauthenticated and wrong-location rejection; and AU/UK/US isolation against actual staging RLS. Do not equate hidden routes with database denial.
- Characterize lost responses, late-write failures, simultaneous receives and delete/save races as known residual risks, not tests this patch is asserted to pass. Rehearse stop/reconcile and rollback write pauses. Complete the ordinary `docs/RELEASING.md` staging smoke test.

Commands were run with process-local `VITE_BACKEND=dexie`. No database or external service was contacted.

| Check | Observed result |
| --- | --- |
| `npx.cmd tsc -b` | **Passed**, exit 0. |
| `npm.cmd run test -- --run` | **Sandbox-blocked**, exit 1 before discovery/assertions: esbuild `Cannot read directory "../../../../..": Access is denied`, then failure to resolve/load `vite.config.ts`. |
| `npm.cmd run build` | **Sandbox-blocked**, exit 1: TypeScript completed, then Vite/esbuild encountered the same directory restriction loading `vite.config.js`. |
| `git diff --check origin/main...HEAD` | Passed, exit 0. |
| Coder/user local evidence | Reported type-check clean, **425 tests passing across five files**, and build successful. Not independently reproduced here. |
| Browser, real Dexie rollback, staging SQL/RLS, remote CI | Not run or independently verified in this review; release gates remain. |

Only `docs/reviews/return-restock-fix-r3.md` was authored. No app code, migration, spec or plan was edited; no commit, push, merge, deploy, SQL execution or state-changing git command was performed. Pre-existing untracked `.claude/launch.json` and `supabase/.temp/` were left untouched. Requested compiler commands can produce normal ignored artifacts.

## Coder response

No further blocking code correction requested. Carry the CJ conditions into the PR description and handover; the optional preview wording may be addressed separately. CJ's acceptance and release evidence remain pending, not inferred from the coder's round-2 response.

STATUS: COMPLETE
