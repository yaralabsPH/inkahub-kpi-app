# Review: Shared scanner wall redesign — round 3

- Slug: `scanner-wall-redesign` · Branch: `feature/scanner-stations-tuning` · Reviewed commit: `a29f969`
- Reviewer: **coder (Claude), at CJ's instruction**, not the planner. Astra could not run round 3: Codex returned "You've hit your usage limit… try again at Nov 29th, 2026 8:02 PM" (2026-11-25) and wrote nothing. CJ then said: "you review it yourself." A self-review is weaker than an independent one; the residual risks below are listed so CJ can weigh them.
- Verdict: **approved** (with the release gates below still open)

## Checked against

- [x] Spec acceptance criteria (re-read `docs/specs/scanner-wall-redesign.md` against the code)
- [x] Plan tasks (all done; detailed checkboxes ticked except PR CI and the staging/hardware checklist)
- [x] AGENTS.md guardrails: Supabase-only scanner mode, no Repository change; one new append-only migration (0064, index only); no RLS/grant change; no secrets; no new npm dependency; `public/` is whitelisted and the fonts ship in `dist/`
- [x] `docs/HARDENING.md` (rounds 1–2 matrices still hold; nothing in round 2's fixes changes them)
- [x] Roadmap decisions (F6/F7 unchanged; CJ's 2026-11-25 decisions: tuning, approved design, fonts)
- [x] Tests cover the new logic; type-check, tests and build pass (evidence below)

## Round-2 items, verified in code

| Item | Where | Verified |
| --- | --- | --- |
| M1 Saving after a stopped delivery | `src/lib/scanners/station.ts` `activeRequest`, `reconcileProgress`, pump catch | Checking/saving shown only for the job the observer marked active; a report or a pump storage failure clears it; reconcile turns a retained checking/saving job into `waiting`/`received`. Test with real `processNext` + memory outbox and `markDone` throwing ends at `waiting`, `storageError` set. |
| M2 Receiving state | `station.ts` `enqueue`; `ScannerWallPanel.tsx` `PHASE_TEXT` | Temporary `receiving` entry set before `outbox.enqueue` is awaited, survives refreshes, replaced by `received` after the durable write, removed on failure. Deferred-enqueue test covers all four moments. |
| M3 Ordinary layouts fit | `ScannerWallPanel.tsx` compact / busy variants; `scanner-wall.css` | Matches the approved artboards (compact rows while recovering; one-line "Today" while busy/signing out). Measured with fixture data, real CSS and fonts at 1280×800: Main 800, Saving 800, Problem 800, SignOut 800 px; no fixed height, nothing clipped. |
| S1 Access loss | `useScannerWallTotals.ts` access epoch in `scope`; `wallTotalsScope.ts` | Losing access bumps the epoch, so the old snapshot, error and goodbye cache can never match again; denial returns the empty view in the same render. |
| S2 Urgent announcements | `WallResult.urgent`; `SharedScannerWall.tsx` | Uncertain outcomes and framer choices keep `kind: "queued"` (not relabelled "not saved") but are `aria-live="assertive" role="alert"`; tested in controller and render. |
| S3 Dispatch wording | `ScannerWallPanel.tsx` `Progress` | "keep going, no need to wait" in Dispatch; tested. |
| S4 Honest log | `docs/plans/scanner-wall-redesign.md` | Correction entry for the 07d9d00 claim and the r1 over-claim; open gates left unticked. |

## Fresh read (no new must-fix found)

Re-read `useScannerWallTotals.ts`, `wallTotalsRefresh.ts`, `wallTotalsScope.ts`, the controller progress/goodbye code and the wall/panel:

- Effect order: the refresher is created before `setEnabled` runs, and both re-run on a scope change; the 04:00 day change alters `scope`, so yesterday's snapshot is dropped and a new read starts.
- Abort then resume: the aborted read keeps the single slot until it settles; the resumed read starts after it (tested). No overlapping RPCs.
- React StrictMode double render: the binding generation and access epoch only move on a real change, so a double render cannot fake readiness.
- Old person's save after rebind stays keyed to that person (`slotSaved.personId`), never shown under the new one (tested).

## Should-fix

None blocking. Residual risks for CJ:

1. **The hook has no render test.** `useScannerWallTotals` is covered through its pure parts (`wallTotalsAccess`, `createBindingGeneration`, the scheduler, the reader, the projection), not by rendering it: the repo has no DOM test library and the plan forbids adding one. Its wiring is verified only by reading and by the staging run.
2. **Self-review.** The same agent wrote and reviewed round 3. If CJ wants independence, Astra can re-review after 2026-11-29 20:02 without blocking staging tests now.

## Nitpicks

1. Compact panels (while the recovery message is up) don't show per-scan progress; the queue count and the result banner still do. That matches the approved Problem artboard and is fine for a short-lived alert.

## Evidence

- Local (Windows): `npx tsc -b` exit 0; `npm run build` exit 0 (fonts in `dist/fonts/atkinson-hyperlegible`); `npm run test -- --run` 3680 passed / 6 failed. The 6 are the `tests/reporting` CRLF line-ending failures Astra verified in scanner-stations-tuning r1/r2 (`reportingJobs` now fails only at its hash line).
- **GitHub CI on PR #29, commit a29f969: success** (run 45613151064, Linux/LF, so those 6 pass there). The earlier failed run (45607051787, commit 07d9d00) failed only in `reportingJobs.test.ts` on the 0064 migration list, the round-1 M1 finding, fixed since.
- Staging preview of a29f969 on inka-staging-2: `inka-arthouse-pbkl2gysa`. It serves the fonts and contains the new wall, and talks only to the staging project.

## Release gates still open (CJ)

1. Apply `0064_scanner_wall_count_window_index.sql` on inka-staging-2, `EXPLAIN` the wall's read as kiosk, then on live at a quiet time (it briefly blocks writes to `production_events`).
2. Run the spec's staging checklist on the preview with the wired scanner (totals vs Classic/Reports for the same day, roles, Dispatch unchanged, layout on the real tablet, 200% zoom).
3. Physical cordless-scanner commissioning (repeat suppression for the badge × 3 gesture).
4. Merge and deploy are CJ's.

## Coder response

Nothing to fix from this round.
