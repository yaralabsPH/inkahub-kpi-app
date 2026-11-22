# Review: Automatic box selection — round 1

- Slug: `box-auto-pick` · Branch: `feature/box-auto-pick`
- Reviewed commit: `0728db8e7e32c84a60bbbbf75a153f60c94be17a`, compared with station-screen base `7b05828`
- Reviewer: Codex planner (independent GPT-6 Astra review, confirmed against call sites)
- Verdict: changes required
- Date: 2026-11-22

## Checked against

Spec/plan, F4 roadmap decisions, AGENTS.md and all applicable HARDENING sections. Existing legacy inventory RPC weaknesses remain outside F4; do not redesign them in this fix. No production or staging database was contacted.

## Must-fix

1. **P1 — Snapshot packaging before completion awaits.** `src/pages/Production.tsx:1116` calls `applyAfterEvent` after awaiting event insertion and component deduction; `src/lib/hooks/useOrderPackaging.ts:262` then reads current `viewRef`. Loading B or clearing A while A saves can deduct B's box against A, or skip A. Capture order/site/rules/prediction/chosen packaging before the first await, and submit that immutable capture with A's saved event ID. Ensure any delayed UI clear cannot erase a newly loaded order. Test delayed insert/deduction while order changes or clears.
2. **P1 — Keep blank-SKU contents for packaging.** `Production.tsx:648` drops blank-SKU Shopify lines before prediction. Retain all raw contents for packaging separately from the display/routing filter. A known frame plus a blank-SKU item must remain unresolved, with no guessed automatic deduction (Q6). Preserve existing station verification/routing behavior.
3. **P2 — Allow a second packaging type without scanning.** `src/lib/domain/packaging/session.ts:78` replaces a pick whenever it has <=1 distinct item, so taps cannot construct A+B. Keep the common one-tap replacement and add a small explicit add-item action. Also fix `useOrderPackaging.ts:256`: scanning the already-predicted item must count as a first explicit scan even if the resulting quantities equal the prediction; a second scan must increment. Test real sequences including saved-pick correction and replacement work.
4. **P2 — Resolve uncertain corrections before changing their payload.** `src/lib/state/packagingCorrection.ts:54` retains an idempotency ID after network error while the hook permits editing. The old request may already have committed, so submitting another target with that ID replays the old choice and closes the editor. Keep the submitted target/reason/staff/request immutable until retry/reload resolves the outcome; allow a fresh edit with a fresh ID/current revision afterwards. Do not claim "Nothing was changed" after an uncertain save. Test committed-but-response-lost, attempted edits, retry and fresh correction.

## Scope and nonblocking follow-ups

Keep fixes limited to the four behaviors above and their regression tests. Confirm the existing replacement fallback: no guessed packaging without replacement contents; worker chooses or the order is flagged. F4 keeps migration 0047 unchanged; F3 reserves 0048–0051 and F5 0052–0054.

Known follow-ups retained without expanding this review: missing-pick attention uses the latest auto period; classic pending notice is visible only while an order is active; configuration fallback warnings are console-only; outbox persistence starts after a network failure response rather than before send. These limitations are not certified as fixed.

## Verification

Fresh reviewer run: 618/618 tests passed; `npm run build` passed including TypeScript. Existing chunk-size/Browserslist warnings only. Passing tests do not cover the four failing interactions above. Add targeted regressions, then run the full tests/build and request one focused re-review. Actual database concurrency/RLS and tablet/staging acceptance remain pending.

## Coder response

All four must-fix behaviours are fixed. No SQL, migration (0047 unchanged), Repository or provider code was touched. The replacement fallback is unchanged: replacement work predicts nothing, the worker chooses, and otherwise the order is flagged.

1. **Packaging is snapshotted before the first completion await.**
   - New pure `capturePackaging` in `session.ts` returns a frozen, deep-copied `{ orderNumber, payload }`.
   - The hook's new `capture()` builds it from the loaded order, rule set, prediction and choice.
   - `handleCompleteOrder` calls it before `insertEvent`. After the event is saved, `applyAfterEvent(eventId, capture)` submits that capture. It no longer reads the live `viewRef`.
   - The 400 ms delayed clear now only clears the order object that was completed, so an order scanned while A saved stays on screen. This applies in both modes.
   - Regression (`packagingSubmit.test.ts`, "completion while the order on screen changes"): this test copies the Complete flow's order of steps rather than mounting `Production.tsx`. It delays the insert and deduction, then while they wait:
     - it loads B and mutates A's live arrays: the RPC still receives A's event and A's target, under order A;
     - it clears the screen after a manual change: offline, A's change is queued under A;
     - it checks the capture is frozen.
   - The identity-guarded delayed clear in `Production.tsx` is not covered by an automated test. That needs the CJ tablet check.
2. **Blank-SKU lines reach packaging.**
   - New `packagingLinesFromOrder` in `contents.ts` keeps every fetched line, including blank SKUs.
   - `CurrentOrder.packaging_lines` holds them, and the hook now receives `{ number, lines: packaging_lines }`.
   - The display/routing `lines` list and its blank-SKU filter are unchanged, so verification and routing behave as before.
   - Regression (`session.test.ts`): a known A1 frame plus a blank-SKU line is `unresolved`, with no packages, an empty target and `resolved: false`. The same frame alone resolves.
3. **A second packaging type can be added without scanning, and scans count correctly.**
   - The panel shows a small `+` ("Add one …") beside each one-tap alternative, wired to the new hook `add`, which uses `addPackage`. This works before Complete and while correcting a saved pick. A plain tap still replaces a pick of one line or fewer.
   - The legacy scan uses the new pure `scanPackage(explicit, item)`. With no explicit choice yet, the first scan replaces the prediction, even when it is the same box. Any later scan adds one. The hook decides from the `chosen` state, not from the `changed` status.
   - Regressions (`session.test.ts`, `PackagingPanel.test.tsx`):
     - tap L then add S gives L+S, and adding S again gives S×2;
     - in replacement work, tap then add a second type;
     - a saved single-item draft can be replaced and then extended;
     - scanning the predicted S gives S×1, then S×2, then adds L;
     - a scan after a tap adds;
     - the add buttons render beside "Use …".
4. **An uncertain correction stays frozen until it is resolved.**
   - `CorrectionEditing` now carries `submitted` (exact id, revision, target, reason, staff) and `uncertain`.
   - A network error sets `uncertain`, keeps the request, and says "The change may already be saved". The old "Nothing was changed" text is gone.
   - New pure helpers:
     - `editCorrectionDraft` and `cancelCorrection` refuse while busy or uncertain;
     - `beginCorrectionSubmit` resends the frozen request unchanged after an uncertain save, whatever reason or worker is used now, and refuses a second send while one is in flight.
   - The hook uses these helpers. While uncertain, the panel disables editing and shows only "Retry", with no reasons and no Cancel. A reload re-reads the saved pick.
   - A resolved answer (overridden or unchanged, conflict, or rejected) unfreezes the editor. A new correction afterwards gets a fresh id and the current revision.
   - Regressions (`packagingCorrection.test.ts`, `PackagingPanel.test.tsx`):
     - a committed save whose response was lost;
     - edits and cancel refused while uncertain;
     - a retry with a different reason or staff sends the identical request, and the replayed success closes the editor;
     - no double send while in flight;
     - a fresh correction after resolution uses a new id and revision 2;
     - a conflict answer to the retry;
     - losing the retry's answer too keeps the same frozen request;
     - the panel offers only Retry, with every other button disabled.

These regressions were written together with the fixes. They were not first run against the old code, where most of them would only fail at import because the new helpers did not exist. The tests I added cover the pure functions and the flow's order of steps, not mounted React components: this repo has no hook or DOM test library. Real tablet interaction still needs CJ's staging check.

Validation, run in this worktree on 2026-11-22:

- `npx tsc -b`: exit 0.
- `npx vitest run src/lib/domain/packaging src/lib/state src/components/production`: 15 files, 231/231 passed.
- `npm run test -- --run`: 21 files, 636/636 passed.
- `npm run build` (`tsc -b && vite build`): exit 0. The only output was the existing chunk-size warning.

The nonblocking follow-ups listed above remain open and are not claimed fixed.
