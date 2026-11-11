# Review: Authenticate daily KPI digest requests — round 1

- Slug: `digest-auth` · Branch: `feature/digest-auth` · Reviewed commit: `10521efc7bed2e0912d87ddf25072813e515bf23`
- Reviewer: planner (Codex)
- Verdict: approved
- Reviewed on: 2026-11-11

Approved on source review: no blocking implementation defect found. This is not release clearance. Independent test/build verification was blocked by the review environment, and green PR CI plus CJ's staging checks remain required before merging.

## Checked against

- [x] Spec acceptance criteria reviewed against `git diff main...HEAD` and the complete handler/tests.
- [x] Plan tasks reviewed; all three implementation commits, task checkboxes and log entries are present. Minor differences are assessed below.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist).
- [ ] Tests cover the new logic; type-check, tests and build pass. Test coverage was inspected and both type-checks passed; tests/build could not complete in this environment. See verification results.

The handler sets no-store first, then enforces a nonblank, exact bearer secret, GET-only handling and recipient validation before entering diagnostics or report work. Header arrays, case-variant duplicates, combined credentials and alternate credential sources are rejected. Configuration is read per request. The new errors neither echo credentials nor expose the allowlist.

Recipient overrides require a normalized individual address and exact full-address membership. Malformed nonblank allowlist entries fail the entire override configuration; absent overrides do not consult it. Default email delivery validates the configured destination after download/no-activity exits and before body generation, removes the hardcoded fallback, and preserves the trimmed configured address. Valid overrides work without a default.

The handler tests mock Supabase, fetch and XLSX, exercise the actual entry point, and assert zero work on early rejection. They cover authentication/query combinations, methods, recipient error precedence, diagnostics, scheduled-style and dated AU/UK/US requests, downloads, force/no-activity behavior, workbook content and unchanged schedules. Existing diagnostic payloads and report calculations remain unchanged.

There are no changes to `src/`, repository contracts/adapters, migrations, RLS, inventory logic, `vercel.json` or the lockfile, and no new dependencies. The root whitelist includes `/tests/`; the focused server type-check matches the plan and runs in CI. The type-only `SupabaseClient` annotation resolves the newly exposed compiler issue without changing runtime behavior. The test harness manually snapshots/restores its environment instead of using the planned `vi.stubEnv`; its paired hooks preserve the intended isolation, so this is not a blocker.

The spec contains staging steps, and the plan/runbook document separate safe Preview settings, Production configuration before deployment, actual scheduled-run verification for all three locations, and the danger of rolling back to the public endpoint. No production service, database or email was contacted during this review.

## Must-fix

None identified in the implementation. The existing release gates still apply: obtain successful full tests/build and green PR CI for the reviewed revision before merge. Do not treat the environment-blocked attempts below as passing evidence or change application code merely to accommodate this sandbox.

## Should-fix

1. `tests/api/daily-digest.test.ts:549` and `tests/api/daily-digest.test.ts:620` — Correct the misleading “after the 04:00 local cutoff” naming. The UK `2026-11-11T02:30:00Z` and US `2026-11-10T08:30:00Z` fixtures are both **02:30 local**, before the cutoff. Their expected prior dates are correct. The corresponding scheduled fixtures already exercise the other side, so this is a clarity issue, not missing coverage of an entire branch. Use neutral fixture names and explicit before/after labels, or add paired 03:59/04:00 cases without changing date calculations.

## Nitpicks

1. `docs/plans/digest-auth.md:5` still says `draft`, despite completed tasks. Reconcile that status with the actual CJ approval/handoff record; do not invent an approval date. This review does not establish historical plan approval.

## Verification results

Commands were run locally on the reviewed commit. PowerShell initially refused the `npm.ps1`/`npx.ps1` launchers under its execution policy; the equivalent installed `.cmd` launchers were used without changing that policy. Frontend checks used process-local `VITE_BACKEND=dexie`.

| Requested check | Observed result |
| --- | --- |
| `npx tsc -b` | `npx.cmd tsc -b` passed, exit 0. |
| `npm run typecheck:digest` | `npm.cmd run typecheck:digest` passed, exit 0. |
| `npm run test -- --run` | Attempted via `npm.cmd`; exit 1 before test execution. esbuild reported `Cannot read directory "../..": Access is denied` and could not resolve `vite.config.ts`. No test pass/fail count was produced. |
| `npm run build` | Attempted via `npm.cmd`; TypeScript completed, but Vite/esbuild exited 1 with the same directory-access error while loading `vite.config.js`. No completed production build. |
| `git diff --check main...HEAD` | Passed. |

The config and dependency files implicated by the esbuild errors are unchanged by this feature. These attempts show an environment access limitation, not a failing assertion or demonstrated application regression. The coder's log reports 350/350 tests and a successful build; those results were not independently reproduced here. Remote CI, Preview behavior and actual Production cron delivery were not verified. CJ must complete the documented staging/release checks, including configuring Production `CRON_SECRET` and `REPORT_RECIPIENT` before merging.

## Open question: `localDayRangeUtc`

**Keep this bug outside `digest-auth`; follow up in a separate reporting/timezone spec and branch.** The helper is unchanged by this diff, the architecture already identifies the risk, and both the approved spec and plan explicitly exclude timezone/calculation changes. Fixing it here would change report contents and expand the agreed security scope.

I reproduced the helper's output in memory from the checked-in source, without importing the handler or making external calls. AU `2026-11-10` yields `2026-11-10T00:00Z` through `2026-11-11T00:00Z`, rather than the Sydney interval starting `2026-11-09T13:00Z`. US `2026-11-09` yields `2026-11-10T00:00Z` through `2026-11-11T00:00Z`, rather than the Chicago interval starting `2026-11-09T06:00Z`. The calculation uses calendar-date differences instead of the timezone's full offset and always adds 24 hours. London's UTC interval happens to be correct in November; summer time and DST transitions still require coverage.

The coder correctly left the helper unchanged and chose compatibility fixtures inside both the existing and intended windows. Prioritize a separate fix with local-midnight boundaries, adjacent-day exclusion and 23/25-hour DST-day tests for AU/UK/US, plus staging report comparisons. This pre-existing issue does not block the authentication feature.

## Coder response

(Coder fills this in after fixing.)
