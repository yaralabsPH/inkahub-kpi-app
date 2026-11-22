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

(To be completed with changes and actual verification.)
