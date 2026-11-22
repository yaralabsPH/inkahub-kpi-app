# F1 integration implementation plan

Goal: integrate existing reviewed item counting with the accepted F5–F7 staging app.
Spec: docs/specs/item-counting-integration.md. Branch: feature/item-counting-integration from f78da60.
Architecture: merge pinned F1 code, preserve both features at each conflict, use existing reporting runtime and views. Claude is sole code writer; Codex owns plan/review/staging operations. User explicitly delegates routine choices and approvals; do not ask sleeping CJ or invoke /loop.

## Tasks

- [ ] 1. Merge pinned F1 `3fd8b49` into this branch. Resolve each conflict deliberately, preserving F4 packaging, F5 snapshots, F6 receiver and F7 attribution/CSV. Keep installed migration bytes. Preserve existing dependency versions unless reconciling the branches' already-approved dependencies. Preserve both typecheck scripts. No source worktree changes. Commit integration.
- [ ] 2. Add focused regression coverage at actual seams: shared-scanner event shape accepted by F1, no fake manual framer count, F7 attribution columns preserved in raw CSV alongside F1 exports, F4 cards remain. Apply the staging-only cron exception in the spec; document dormant schedule deployment prerequisite. Fix concrete integration issues only. Tests must fail for the corresponding broken seam, not mirror code text unnecessarily.
- [ ] 3. Run combined tsc, typecheck:digest, typecheck:api, tests and build once; inspect all output. Run focused fixes only if failure warrants. Add concise release/runbook amendments distinguishing code from hosted evidence; return exact SHA and commands. No SQL apply, deploy, push or additional feature yet.
- [ ] 4. Codex reviews changes and performs controlled actual staging verification; fixes go back to Claude. Deliver with later F8/F9 Preview, CI green. Record limits and exact fixtures removed.

## Review focus

- Merged Reports must retain manual/scanned attribution and avoid mixing generations or roles.
- Scanner completion timestamps and multiple lines from one scan must not lose/double item credit.
- Manual dispatch must not manufacture framing work; incomplete evidence stays explicit.
- Existing packaging and stock deductions remain exactly once.
- New cron declarations cannot accidentally prevent the existing Hobby Preview build or alter production schedules.

## Progress

Baseline f78da60: 46 files / 1016 tests passed on 2026-11-23. F1 source pinned to 3fd8b49 and backed up to origin/feature/item-counting. Original isolated worktrees are untouched. Stop at 2026-11-23 02:00 UTC if unfinished; report work honestly, do not mark untested deployment complete.
