# F7 dispatch flow — focused review R2

Reviewed R1 fixes through81f2c00c5195eb491a797b8a39c69102aa5cbc39. The first fix pass passes1016tests/46files, all typechecks/build,167local SQL assertions and160F6 assertions. The new dispatch guard, evidence-write locking, matching completion SKU and required packaging are appropriately bounded. CSV uses deterministic paging. Actual staging remains pending;0056 still unapplied.

One residual issue remains in the current-attempt comparison: `valid` rejects started only after first completion (`x.created_at > p.cat`). Sequence verification -> later started/reload -> first completion can still reuse a prior attempt's verification. Classic clear/reload can produce it because it adds a new started bracket while loading existing verification records. This follows directly from R1's same-attempt requirement.

Use the conservative bounded comparison `x.created_at > p.vat` for the relevant whole-order/SKU/work-type start. Add a focused SQL regression: V->S->C must require manual; S->V->C remains measured; existing equal-timestamp F6 V/C remains measured. Update the explanatory SQL/docs text to match. No new state machine or feature.

The application TypeScript is unchanged by this follow-up, so do not repeat the entire application gate. Run the focused SQL cases and affected manifest check, commit, and report exact migration hash. Codex will run final real staging assertions/F6 replay/roles/concurrency and the existing fresh reviewer will verify this narrow correction before installation.

## Coder response

Fixed as specified: the `started` boundary in `dispatch_framing_evidence_` is now `x.created_at > p.vat` (relevant work type, whole order or same SKU); the SQL comment, runbook, release record and staging README say "after the verification". Regressions: C20 V->S->C = missing (fails on the R1 0056), C21a S->V->C = measured, C21b S/V/C at one instant = measured, C21c F6 equal-time V/C re-checked measured. Local only: F7 175 cases, F6 160 cases, race smoke 16/16 true, manifest 15/15. No application code changed, so the app gate was not repeated (last full run: 1016/1016, tsc/digest/API/build pass).
