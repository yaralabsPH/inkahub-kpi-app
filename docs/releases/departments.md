# Release notes and acceptance record: departments (F5)

- Spec: [`docs/specs/departments.md`](../specs/departments.md) · Plan: [`docs/plans/departments.md`](../plans/departments.md)
- Runbook: [`docs/runbooks/departments.md`](../runbooks/departments.md)
- Branch: `feature/departments`
- Status: **implemented; not yet reviewed, not yet verified on staging, not released.**

## What changes for people

- **Owners** get a "Departments" card on the Team page: create, rename,
  archive and restore departments; give each person one home department or
  move them; see each person's history and a change log; and one switch,
  "Save the department on new work".
- **Everyone else** (manager, staff, kiosk, CS) sees nothing new.
- **Stations** work exactly as before. Nothing about scanning, work types
  (Framed, A0 Framed, Unframed, Dispatch), verification, packaging or stock
  changes.
- **Reports** do not show departments yet. That is F8.

Once the switch is on, every new production event keeps the department its
worker belonged to at that moment, and that department's name at that moment.
Moving or renaming later does not change it. Work recorded before the switch
was turned on, or while it is off, is "unknown" for ever and is never filled
in from today's membership.

## What is in this release

| Part | Files |
|---|---|
| Database | `supabase/migrations/0052_departments.sql`, `0053_departments_admin.sql`, `0054_departments_snapshots.sql` |
| App | `src/lib/domain/departments.ts`, `src/lib/departments/*`, `src/lib/hooks/useDepartments.ts`, `src/components/departments/*`, one mount in `src/pages/Team.tsx`, event schema alignment in `src/lib/domain/schemas.ts` |
| Not changed | `src/pages/Production.tsx`, `src/components/TeamMembersCard.tsx`, `Repository.ts` and both adapters, every `api/` endpoint, every existing migration |
| Staging scripts | `supabase/staging/departments/` |

No new dependency, environment variable, cron, endpoint or provider setting.

### Migrations (apply in order; each is one transaction)

| File | Adds | Why old code keeps working |
|---|---|---|
| `0052_departments.sql` | Extension `btree_gist` (schema `extensions`), schema `departments_private`, six new tables, role `departments_resolver`, read policies | Only new objects. Nothing existing is altered |
| `0053_departments_admin.sql` | Three owner functions; a BEFORE DELETE trigger on `profiles` that closes the removed person's open home | New functions. The trigger does nothing for people without a home, and otherwise only closes one row |
| `0054_departments_snapshots.sql` | Eleven **nullable, default-less** columns on `production_events`, one partial index, two BEFORE INSERT triggers and one BEFORE UPDATE trigger | Inserts and updates from any app version are accepted unchanged; the database fills the new columns. With the switch off they are filled with status `disabled` |

Things to know when applying:

- `0054` briefly locks `production_events` (add columns, build an index). Pick a quiet time.
- The extension `btree_gist` stays installed on rollback.
- `0054` hands one function to the role `departments_resolver`. The first candidate of `0054` failed on staging at that point (see "Review r1" below) and was corrected before anything was applied. The corrected file must be re-run rollback-only on staging, unchanged, before it is applied for real.
- No existing event row is updated or backfilled, by the migrations or by switching on. (This also means F1's capture trigger records nothing for old rows.)
- New behaviour on updates: once an event has a snapshot, its `staff_id`, `created_at`, `location` and `id` cannot be changed (error 23514). Other edits and deletes work as before. Rows from before F5 are not affected. No app code changes those four fields today.
- New behaviour on profile deletion: it now waits up to 2 seconds if an owner is saving a department change at that instant, and fails with a retryable error rather than waiting longer.

### Rollback

- **App:** promote the previous deployment as usual. The old app works on the
  new schema. Keep the migrations, tables, history and extension.
- **Behaviour:** the owner switch turns snapshots off in seconds, no deploy.
- **Emergency:** disable only `production_events_f5_20_resolve`
  (runbook section 6b).
- There is no down migration and nothing to restore from backup.
- No follow-up "contract" release is needed.

## Decisions settled during implementation

Routine choices are listed per task in the plan's Implementation log. The ones
worth knowing here:

- Roles and failure injection are sections of `02-assertions.sql`, not
  separate `03`/`04` files.
- Receipt hashes use Postgres' built-in `sha256()`; pgcrypto is not required.
- The resolver checks "department archived" against the department's current
  `archived_at`; it does not read the audit table.
- "Server busy" is retried with the same request id, like "no answer".

## Checks run by the coder

On 2026-11-22, after the review r1 fixes (commit `a8ca3a3`):

| Check | Result |
|---|---|
| `npx tsc -b` | passed |
| `npm run test -- --run` | 836 tests in 30 files passed (200 new for F5) |
| `npm run typecheck:digest` | passed |
| `npm run build` | passed (existing chunk-size warning only) |

Migration SHA-256 as committed (LF line endings):

- `0052_departments.sql` `fb86f6628f27191dce303a88d212a4f2b7a721e386a2346c5a2655d586c16b02`
- `0053_departments_admin.sql` `cc7301877a146f7a62dad8cd93b066f88799a239275f73d254f91a5f754e89c3`
- `0054_departments_snapshots.sql` `541a7822ae18c9177bca3187a44fde256dcc1037a61c831b40d69d28a5b4a116` (corrected in review r1; the first candidate was `b1960ef3...`, never applied)

A Windows checkout with line-ending conversion changes these bytes: hash the
file as stored in git (`git show <commit>:<path> | sha256sum`).

All SQL was also executed on a throwaway local Postgres (PGlite, outside the
repo) with stand-ins for Supabase's roles and the recovered tables:
migrations applied twice, `02-assertions.sql` all cases passing,
`06-composition.sql` against a stand-in for F1's trigger, `07-performance.sql`
at the default size, `01`/`08`/`09`, and `05-session-a.sql` in one session.
**That is not staging evidence** and none of the rows below are filled from it.

## Review r1 (2026-11-22)

Review: [`docs/reviews/departments-r1.md`](../reviews/departments-r1.md). Three fixes, each with regression tests.

1. **`0054` failed on staging; corrected before anything was applied.** Evidence
   supplied by root (Codex), from an actual rollback-only run on the staging
   project under the Supabase `postgres` role (not a superuser): `0052` and
   `0053` executed; `0054` failed with SQLSTATE 42501 "permission denied for
   function departments_private.resolve_event". Cause: the migration gave up
   its temporary membership of `departments_resolver` before `CREATE TRIGGER`,
   which needs EXECUTE on that function. Root then ran a diagnostic with only
   that one `REVOKE` moved after the triggers: all three migrations executed,
   the operator could no longer execute the function afterwards, and an
   authenticated synthetic kiosk insert of a clock event saved with status
   `disabled` and snapshot version 1. Everything was rolled back; root
   confirmed no F5 object remains on staging and the event count is unchanged.
   The fix in the repo is exactly that move. No grant was added or widened.
   Coder local reproduction (not staging evidence): under a non-superuser
   CREATEROLE role the old file fails with the same error; the corrected file
   applies, re-applies, and `02-assertions.sql` passes 321 cases under that
   role. **Still to do on staging:** run the committed files, unchanged, in
   rollback-only mode once more before the persistent apply.
2. **The owner panel now belongs to the live session.** It is shown only when
   the session user id equals the loaded profile user id and that profile is
   an owner, and it is keyed by that id. Changing account (to a non-owner, or
   to another owner) unmounts the first owner panel immediately: lists, open
   forms, a pending or unconfirmed request and its Retry all go, the cached
   lists are cleared, and a late answer is discarded.
3. **The switch confirmation keeps the action it was opened with.** Target
   and expected version are captured when "Turn on..." / "Turn off..." is
   clicked. The confirmation closes only when the server confirms. If the
   switch is already in the requested state, or someone else changed it, the
   confirmation can only be closed; it never becomes the opposite action. An
   unconfirmed change is retried with the original request.

Also: People and Members now load a page at a time with "Load more" (the
department picker still loads every active department). A partial People list
says "Showing the first N accounts" instead of a team-wide count.

Accepted by the ruling as documented, no change: roles and failure cases as
sections of `02-assertions.sql`; a platform-granted membership of
`departments_resolver` for the role that created it (case A14 reports it),
provided no client role gains membership or EXECUTE.

## Gate A — staging database acceptance

Fill in when run. Leave "pending" otherwise. Do not write "pass" for a case
that was not executed. Steps: runbook section 2.

| Step | Result | Who / when (UTC) | Evidence (file hash, notice text, numbers) |
|---|---|---|---|
| A1 window reserved, staging backed up | pending | | |
| A2 preflight before | pending | | |
| A3 apply 0052, 0053, 0054 | pending | | SHA-256 of each file: |
| A4 preflight after; legacy fingerprint identical | pending | | |
| A5 switch is off | pending | | |
| A6 old app records an event with the switch off | pending | | |
| A7 `02-assertions.sql` | pending | | cases passed: ; skipped: |
| A8 `06-composition.sql` | pending | | state found: |
| A9 `07-performance.sql` (default 10,000 rows) | pending | | p95 added (ms): |
| A9b performance at 100,000 rows / two years / three sites | pending (production-release evidence) | | |
| A10 `01-fixtures.sql` | pending | | |
| A11 two-session schedules S1, S2, S3, S5, S6, S7, S8, S9 | pending | | one line per schedule |
| A11b transfer committing between a scan's receipt and its lookup | pending (not testable from outside; see runbook) | | |
| A12 `09-cleanup.sql` | pending | | |
| A13 `08-health.sql`, query 9 all zero | pending | | |
| F1 "control row missing" failure | pending (F1 owner's rehearsal) | | |

## Gate B — Preview acceptance and rollback rehearsal

Steps: runbook section 3.

| Step | Result | Who / when (UTC) | Notes (deployment id, what was seen) |
|---|---|---|---|
| B1 create with name preview | pending | | |
| B2 rename | pending | | |
| B3 archive | pending | | |
| B4 restore | pending | | |
| B5 assign; same home at two sites | pending | | |
| B6 move; adjacent history | pending | | |
| B7 archive refused with member list | pending | | |
| B8 correction needs a reason | pending | | |
| B9 switch on | pending | | |
| B10 kiosk records all event kinds; rows assigned; work type unchanged | pending | | |
| B11 switch off / on | pending | | |
| B12 no card and no request for non-owners | pending | | |
| B13 direct API calls refused per role | pending | | |
| B14 two owners, one conflict | pending | | |
| B15 lost response, retry, applied once | pending | | |
| B16 remove and re-add a person | pending | | |
| B17 keyboard and focus | pending | | |
| B18 sign-out and direct account switch (owner to non-owner, owner to owner) hide the first owner panel at once | pending | | |
| B18b open switch confirmation never becomes the opposite action | pending | | |
| B19 Dexie notice | pending | | |
| B20 RELEASING smoke test, stock deducts once, F4 packaging | pending | | |
| B21 rollback rehearsal (old app on new schema; 6a; 6b and recovery) | pending | | |
| Combined base with #8 Team redesign (its remove-member function) | pending (separate batch gate) | | |

## Before production (CJ)

- [ ] Review verdict "approved" in `docs/reviews/departments-r<N>.md`; CI green.
- [ ] Gates A and B recorded above against the same commit and migration hashes.
- [ ] Production parity reconfirmed: `production_events.staff_id`, `profiles.user_id`, `staff_barcodes.user_id` reference `auth.users`; grants as on staging; `btree_gist` available and installable in `extensions`.
- [ ] Migration numbers `0052`–`0054` still free in the release batch.
- [ ] The real roster from Max/CJ (departments, who is in which, which logins are shared). **Not in this repo.**
- [ ] Then follow runbook section 4. The switch is turned on last.
