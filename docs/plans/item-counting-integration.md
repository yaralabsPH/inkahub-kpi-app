# F1 integration implementation plan

Goal: integrate existing reviewed item counting with the accepted F5–F7 staging app.
Spec: docs/specs/item-counting-integration.md. Branch: feature/item-counting-integration from f78da60.
Architecture: merge pinned F1 code, preserve both features at each conflict, use existing reporting runtime and views. Claude is sole code writer; Codex owns plan/review/staging operations. User explicitly delegates routine choices and approvals; do not ask sleeping CJ or invoke /loop.

## Tasks

- [x] 1. Merge pinned F1 `3fd8b49` into this branch. Resolve each conflict deliberately, preserving F4 packaging, F5 snapshots, F6 receiver and F7 attribution/CSV. Keep installed migration bytes. Preserve existing dependency versions unless reconciling the branches' already-approved dependencies. Preserve both typecheck scripts. No source worktree changes. Commit integration.
- [x] 2. Add focused regression coverage at actual seams: shared-scanner event shape accepted by F1, no fake manual framer count, F7 attribution columns preserved in raw CSV alongside F1 exports, F4 cards remain. Apply the staging-only cron exception in the spec; document dormant schedule deployment prerequisite. Fix concrete integration issues only. Tests must fail for the corresponding broken seam, not mirror code text unnecessarily.
- [x] 3. Run combined tsc, typecheck:digest, typecheck:api, tests and build once; inspect all output. Run focused fixes only if failure warrants. Add concise release/runbook amendments distinguishing code from hosted evidence; return exact SHA and commands. No SQL apply, deploy, push or additional feature yet.
- [ ] 4. Codex reviews changes and performs controlled actual staging verification; fixes go back to Claude. Deliver with later F8/F9 Preview, CI green. Record limits and exact fixtures removed.

## Review focus

- Merged Reports must retain manual/scanned attribution and avoid mixing generations or roles.
- Scanner completion timestamps and multiple lines from one scan must not lose/double item credit.
- Manual dispatch must not manufacture framing work; incomplete evidence stays explicit.
- Existing packaging and stock deductions remain exactly once.
- New cron declarations cannot accidentally prevent the existing Hobby Preview build or alter production schedules.

## Progress

Baseline f78da60: 46 files / 1016 tests passed on 2026-11-23. F1 source pinned to 3fd8b49 and backed up to origin/feature/item-counting. Original isolated worktrees are untouched. Stop at 2026-11-23 02:00 UTC if unfinished; report work honestly, do not mark untested deployment complete.

## Implementation log

- Task 1: merged `3fd8b49` (6 conflicts). package.json keeps both typecheck scripts plus F1 staging scripts; F1 deps (pg, pglite) come from its approved lockfile. Packaging cards: F1's explicit-load/sequence structure with F4's `PACKAGE_USAGE_ROWS_FILTER` correction rows and `netUsageByProduct`. Reports: F1 published/legacy engine; F7 framer columns re-added to BOTH CSV exports (legacy rows; published pages held until collection resolves, then one chunk per page) and to order lookup via a sequenced effect after the F1 lookup session. Production: F1 saved-evidence counter replaces local todayCount; F4 packaging capture/apply and F6 completion rules kept; HEAD's redesigned line list kept; new station screen fed `counter.normal` (items show "–" when the exact total is unsafe). Welcome: both imports. Files the plan did not name: `src/lib/scanners/{order,dispatch}.ts` (F1 deleted `kpiUnitMultiplier`; added `framingPieceMultiplier` with F6's identical rule, preview only), `PackagingAttentionCard` range now `pkgWindow`, `productionPublishedView.ts` (optional extra CSV columns), `tests/reporting/pg/harness.ts` (`NON_REPORTING_MIGRATIONS` excludes 0047/0052–0056 from the reporting-only PGlite bootstrap; an unclassified new migration still fails loudly), two numbering tests and the page-chunk source test updated for the merged allocation/F7 header. Surprise: autocrlf checked merged files out CRLF in this worktree and broke F1's byte-hash tests locally; working copies renormalized to LF (index unchanged). Gate: tsc clean, 124 files / 3122 tests pass.
- Task 2: `tests/production/item-counting-integration.test.ts` (11 tests) feeds rows shaped exactly like 0055 step 9 (per-line `line_verified` + per-work-type `completed`, same instant, completion id sorting first) and 0056 step 10 (whole-order `dispatched`, no line scans) through F1's reducer: every piece credited once, A0+framed one overall order, shared dispatch gives the dispatcher the order only, zero framing credit to anyone and `missingDetail` true; plus F7 columns on F1's published CSV (manual labelled, failure = `unavailable`, plain export still 9 columns) and source seams for F4 cards/correction rows and the F1 counter. Mutation check: breaking the set multiplier or the extra CSV cells fails 3 tests. Staging cron exception: three `refresh-summaries` crons removed from `vercel.json` (digests and 300 s functions unchanged); exact definitions kept dormant in `docs/releases/item-counting.md` "Integration amendment", guarded by the reworked Task 15 schedule test (daily-only crons + verbatim doc entries). No app-code fixes were needed beyond Task 1.
- Task 3: combined gate on `c77cb96`, run once in order, all exit 0: `npx tsc -b`; `npm run typecheck:digest`; `npm run typecheck:api`; `npm run test -- --run` → 125 files / 3134 tests passed; `npm run build` → built (existing >500 kB chunk warning only). CI runs the same five steps. No fixes needed. Added "Integration amendment: what is proven in code vs still owed on staging" to `docs/releases/item-counting.md`. Final review was a self-review (CJ's brief forbade other agents); Codex's Task 4 review is the independent one.
