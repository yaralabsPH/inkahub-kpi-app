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

Must-fix fixed in `src/lib/domain/artworkManifest.ts` (`resolveManifest`):

- An approved alias whose stem matches another ordinal's canonical name in either form (`INKA-S2-WIL0049-01` or `INKA-S2WIL0049-01`) is now rejected as invalid alias data. It throws a `RangeError` like the other alias-list errors. An alias onto its own ordinal's canonical name is still allowed, because it is redundant and harmless.
- As a second guard, any file ID that matches more than one ordinal now gives an `ambiguous` result, with a `shared_source` conflict on each affected ordinal. It never gives a complete manifest. This also catches the case where duplicate observation records share one file ID under two names. `ComponentConflict.reason` now includes `"shared_source"`.
- Regressions sit beside the existing two-component alias test in `src/lib/domain/__tests__/artworkManifest.test.ts`:
  - The reviewer's scenario: only `-01` is present and an ordinal-2 alias points at `-01`. It now throws, and without the alias `-02` stays missing.
  - One file ID across two ordinals now gives `shared_source` on ordinals 1 and 2.
  - Both tests were run against the old code first and failed; they pass now.

Validation, run on the fix in this checkout on 2026-11-22:

- `npx vitest run src/lib/domain/__tests__/artworkManifest.test.ts`: 23/23 passed.
- `npx tsc -b`: exit 0.
- `npm run typecheck:artwork`: exit 0.
- `npm run test -- --run`: 11 files, 561/561 passed.
- `npm run build`: exit 0. The only output was Vite's existing chunk-size warning.
