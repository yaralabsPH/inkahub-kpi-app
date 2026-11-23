# F8 UI review 1

Immutable db27173 UI diff from13dcede. Independent reviewer found two important access-transition defects; root accepts these as concrete failures of the approved isolation contract. Do not refactor AuthProvider.

1. Reports.tsx wrapper selects layout only from auth.profile.role. Existing AuthProvider retains old profile during a session switch. An owner Reports screen switched to staff can retain legacy team/payroll subtree until the new profile arrives. Fail closed while auth.loading, no session/user/profile, or profile.user_id !== user.id. Mount legacy only for a known matching owner/manager profile. Regression must exercise session/profile mismatch, not just role string helpers.
2. Same-user CS-to-staff downgrade retains site-wide overview. CS Everyone and staff both omit staffId, while controller identity depends only on user+query+refresh and both layouts preserve the same tree. Key/reset controller/subtree by trusted role/audience scope, and test loaded CS data followed by staff role transition clears it before a new authorized response. Include old pending response completion after transition.

Minor: badge display-name lookup is unpaged and includes inactive records. It does not truncate totals or expose data (assigned CS has existing RLS access), but old names can win and person options may truncate beyond1000 badge records. If a small change, reuse an existing paged read and active-record predicate; do not add a new API just for this.

Backend13dcede independently approved. Root will cover old-generation department snapshot retention after source deletion/new publication on staging. No DB, browser or tests run by this reviewer.
STATUS: FAILED – access-transition isolation fixes required.

## Coder response (Claude, 2026-11-23)

1. Fixed. `reportsAccessFor(auth)` fails closed (pending) while `auth.loading`, without session/user/profile, or when `profile.user_id` or `session.user.id` differs from `user.id`. Only then is the role read; `ReportsForAccess` mounts the legacy subtree only for a matching owner/manager. Test renders the real tree through a session switch where the previous owner profile is retained (no legacy, no summary), each closed state, then the staff profile (summary only, self scope). Removing the mismatch guard fails it.
2. Fixed. The summary identity is the trusted `user|role|audience` scope: it keys the `ReportsOverview` subtree (remount) and the loader identity. Test: CS "Everyone" loaded, CS refresh in flight, role drops to staff with the same query â€” data clears at once, the late CS reply is ignored, only the staff answer shows.
Minor: badge names now read active records only through the existing paged `fetchAllRows` (ordered by user_id); no new API.

Checks: `npx tsc -b`; focused `tests/production`, `tests/api/reports-overview.test.ts`, station tests pass. Full gate deferred to the F9 combined gate as instructed.
