# Review: Artwork foundation — round 1

- Branch: `feature/f3-artwork-thumbnails`
- Task 4 reviewed commit: `357cb9f`
- Reviewer: Codex planner, with independent read-only review
- Date: 2026-11-22
- Verdict: changes required

Task 4 follows the approved pure-domain scope, but one concrete alias collision must be fixed before acceptance.

## Must-fix

`src/lib/domain/artworkManifest.ts:105`: an approved alias can map component 02 to component 01's canonical stem. With only `INKA-S2-WIL0049-01.jpg` present and an ordinal-2 alias to that stem, the resolver reports complete with the same file ID in both positions. Reject aliases colliding with another expected component's canonical stems, and prevent a single source file from satisfying multiple ordinals. Add the regression beside the existing two-component alias test. Missing component 02 must never become a complete set.

## Verification scope

Coder ran 90 Task 4 tests and the normal type checks/full tests; the independent review reproduced the missing-component defect despite those tests passing. Add the focused regression, rerun affected/full checks and build after Task 5. Task 5 and the correction receive a focused final review. No hosting, provider calls, schema or deployment is certified by pure-domain tests.

## Coder response

(Record fix and actual validation here.)
