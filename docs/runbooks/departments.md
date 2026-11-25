# Runbook: departments (F5)

How to verify, switch on, watch and, if needed, switch off the business
department snapshot. Spec: [`docs/specs/departments.md`](../specs/departments.md).
Plan: [`docs/plans/departments.md`](../plans/departments.md).
Results are recorded in [`docs/releases/departments.md`](../releases/departments.md).

**Who does what**

| Step | Who |
|---|---|
| Apply migrations `0052`–`0054` to **staging**, run the staging scripts | CJ, or Codex (Astra) under CJ's delegation |
| Preview checks (Gate B) | CJ (Codex may prepare) |
| Anything on **production**: SQL, merge, deploy, switching on | CJ only |
| Claude (coder) | never applies SQL, merges or deploys |

**Stop conditions (any of these: stop, record it, do not switch on)**

- `02-assertions.sql` raises `F5 verify FAILED`, or reports skipped cases you cannot explain.
- `00-preflight.sql` section 6 (legacy fingerprint) differs before and after the migration.
- A scan (event insert) fails with an error that mentions `departments_private`, `f5_` or the new columns.
- The three F5 event triggers are not all present and enabled, or sanitize does not sort before resolve.
- Any existing flow in the smoke test behaves differently (clock in/out, verify, complete, dispatch, stock).

---

## 1. What is installed

| Object | Purpose |
|---|---|
| Tables `business_departments`, `business_department_names`, `person_department_assignments` | Departments, their names over time, who belonged where over time |
| Tables `department_audit`, `department_requests` | Who changed what; receipts so a retried request is not applied twice |
| Table `department_snapshot_control` | **The switch** (one row). Starts OFF |
| Functions `department_admin`, `department_set_snapshot_enabled`, `department_owner_page` | The only way to change or read the above. Owner only |
| Trigger `profiles_f5_10_close_assignment` | When a profile is deleted, that person's open home is closed |
| 11 nullable columns on `production_events` | The snapshot on each new event |
| Triggers `production_events_f5_10_sanitize`, `production_events_f5_20_resolve`, `production_events_f5_10_freeze` | Fill and protect the snapshot |
| Role `departments_resolver` | Login-less role the lookup runs as; can read only the department tables |
| Extension `btree_gist` (schema `extensions`) | Lets the database itself forbid overlapping intervals |

The legacy column `production_events.department` (work type: `a0_framed`,
`framed`, `unframed`, `dispatch`) is untouched. Station routing does not change.

Advisory lock key reserved for F5: `(494749, 5)`. Owner changes take it
exclusively (waiting at most 2 seconds); each event insert *tries* it shared
and never waits.

## 2. Staging database acceptance (Gate A)

Use `psql` (needed for the two-session part) or the Supabase SQL editor for
the single-transaction scripts. Connection details are never written in this
repo; use the staging project's own connection string from the Supabase
dashboard and keep it out of files and chat.

Scripts: [`supabase/staging/departments/`](../../supabase/staging/departments/README.md).

| # | Do | Expect | Evidence to keep |
|---|---|---|---|
| A1 | Confirm the staging window (no other feature applying SQL). Back up staging | — | Who, when |
| A2 | Run `00-preflight.sql` | `has_staging_location = true`; `btree_gist` available | Whole output ("before") |
| A3 | Apply `0052_departments.sql`, `0053_departments_admin.sql`, `0054_departments_snapshots.sql`, in that order | Each ends without error | SHA-256 of each file; output |
| A4 | Run `00-preflight.sql` again | Section 6 fingerprint **identical** to A2. Section 3 shows the three F5 event triggers and the profile trigger, enabled, sanitize before resolve; any pre-existing trigger unchanged. Section 8 lists the F5 objects; `resolve_event` owner is `departments_resolver` | Whole output ("after") |
| A5 | Check the switch: `SELECT enabled, version FROM department_snapshot_control;` | `enabled = false` | Output |
| A6 | With the switch still OFF, record one event from the existing app on the Preview (old code is fine) | Saved; `business_department_status = 'disabled'`; no department | The row |
| A7 | Run `02-assertions.sql` | Final notice `F5 verify: ALL CHECKS PASSED (N cases, 0 skipped; ...)` and exactly one expected warning `f5_departments resolution_error ... id=f5t-broken` | The notices; N; any skipped case and why |
| A8 | Run `06-composition.sql` | `PASSED at site ...`, or a notice saying which state it found and `PENDING` | The notice |
| A9 | Run `07-performance.sql` | A result row with `verdict`; plan uses `person_department_assignments_person_idx` | The row and the plan |
| A10 | Run `01-fixtures.sql` | Lists two F5X departments and five F5X people | Output |
| A11 | Run `05-session-a.sql` and `05-session-b.sql` step by step in two `psql` windows | Each step's "Expect" line | A line per step: saw / did not see |
| A12 | Run `09-cleanup.sql` | `no synthetic F5X rows remain`; switch as you left it; four triggers `O` | Output |
| A13 | Run `08-health.sql` | Query 9 all zeros | Output |

Before A3, run the three committed files once in rollback-only mode on
staging (one `BEGIN` ... `ROLLBACK` around them, with their own outer
`BEGIN;` / `COMMIT;` removed) and confirm they execute. The first candidate of
`0054` failed exactly here with SQLSTATE 42501 (`permission denied for
function departments_private.resolve_event`); it was corrected in review r1 by
giving up the temporary `departments_resolver` membership only after the
triggers are created. If any migration fails, stop and report the exact
error. Nothing is half-applied: each migration is one transaction.

After A3, check the privileges really are narrow (also cases A09-A15 of
`02-assertions.sql`):

```sql
SELECT r.rolname,
       has_function_privilege(r.rolname, 'departments_private.resolve_event()', 'EXECUTE') AS can_execute_resolver,
       pg_has_role(r.rolname, 'departments_resolver', 'MEMBER') AS is_member
  FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role');
-- Expect: false, false for all three.
```

The role that created `departments_resolver` (the Supabase `postgres` role)
may keep an administrative membership the platform gives it; that is
accepted. No client role may have one.

### What the scripts do not prove (keep these marked pending)

- A transfer that commits in the instant between a scan's receipt and its
  lookup (cannot be held open from outside). The rule it must follow is
  proved for delayed events (cases G18–G21, G33).
- The 100,000-row / two-year performance run (the default run is 10,000 rows).
- F1 composition, when F1's capture is not installed or is switched off.
- F1's own "control row missing" failure: that is F1's rehearsal.
- Real API sessions per role: Gate B.

## 3. Preview acceptance (Gate B)

On the staging Preview deployment of this branch, with the staging role
accounts. Use only synthetic names ("Department A", "Department B",
"Department C"). Tick each row in the release notes.

| Step | As | Do | Expect |
|---|---|---|---|
| B1 | owner | Team → Departments → type `  Department   A  ` | Preview line "Will be saved as “Department A”"; after Create the list shows "Department A" |
| B2 | owner | Create "Department B" and "Department C"; Rename C to "Department C2" | List shows "Department C2" |
| B3 | owner | Archive "Department C2" | It leaves the list; "Show archived" lists it |
| B4 | owner | Restore "Department C2" | Back in the list with 0 people |
| B5 | owner | People → a test person → Assign → Department A → Confirm | Person shows "Department A · since <now>"; switch site in the sidebar: same home, that site's time zone |
| B6 | owner | Same person → Move → Department B → Confirm | History shows A ending and B starting at the same time |
| B7 | owner | Archive "Department B" while the person is in it | Refused: "Move everyone out…", and the member list opens showing the person |
| B8 | owner | Same person → tick "This fixes a mistake" → leave reason empty | Confirm is disabled; with a reason it saves; Change log shows "Corrected a home department" with the reason |
| B9 | owner | Turn the switch ON (reason required) | Status ON, and the confirmation closes by itself (it must NOT turn into a ready "Turn OFF?" form). Change log shows it |
| B10 | kiosk | Production page: scan the test person's badge, clock in, record an order event, verify a line, complete; dispatch at a dispatch station | Everything works exactly as before. In SQL the new rows have `business_department_status = 'assigned'`, the department from B6/B8, and `department` (work type) as before |
| B11 | owner | Turn the switch OFF, kiosk records one event, owner turns it ON, kiosk records another | First row `disabled` with no department; second `assigned` |
| B12 | manager, staff, kiosk, cs | Open Team (where the role can) | No Departments card at all. Browser network tab: no request to `department_owner_page` or the department tables |
| B13 | manager, staff, kiosk, cs | With that role's session token, call `POST /rest/v1/rpc/department_admin` and `GET /rest/v1/business_departments` | RPC: 403/42501. Table: empty list or 403. Never a row |
| B14 | owner | Two browser windows as two owners: both open the same department, both rename | One saves; the other gets "Someone else changed this… refreshed", must reapply by hand |
| B15 | owner | DevTools → Network → Offline, click Create, go back Online, click Retry | Banner "Not confirmed… Retry"; after Retry exactly one department; Change log shows one "Created department" |
| B16 | owner | Team → remove the test person (the existing flow), then add them back (same account) | After removal: Change log "Left the team (home closed)"; history kept. After re-adding: "No home assigned" until assigned again |
| B17 | owner | Keyboard only: Tab through the card, create and rename with Enter, Cancel with the Cancel button | Every control reachable and labelled; errors announced; focus is not lost |
| B18 | owner | (a) Sign out, sign in as a different owner. (b) With a department form open and, if you can, an unconfirmed change showing Retry (B15), switch account without a full reload: once to a non-owner, once to another owner | The first owner card disappears at once in every case. Nothing of theirs (lists, history, open form, Retry banner) is shown to the next account. The second owner starts with a clean card |
| B18b | two owners | Owner 1 opens "Turn on..." and waits; owner 2 turns the switch on (and, in a second run, on then off) in another browser; owner 1 refocuses the window so the page refreshes | Owner 1 sees "already ON" (or "changed by someone else") with only Close. The open confirmation never offers the opposite action |
| B19 | — | Build with `VITE_BACKEND=dexie` (local `npm run dev` without Supabase) → Team | "Department management requires Supabase."; no network request |
| B20 | all | `docs/RELEASING.md` smoke test: each role's pages; kiosk clock in/out; record and verify; **stock deducts exactly once** on completion and on retry; packaging (F4) pick as before; Shopify lookup; shipments, CS cases and returns save; Dashboard and Reports load with a clean console; digest groups by work type | Unchanged |
| B21 | — | Rollback rehearsal: see section 6 | Old app works on the new schema |

Existing stock or F1 problems found during B20 are recorded as release
blockers for their own owners. They are not fixed here and not marked passed.

## 4. Switching on (production: CJ only)

Prerequisites: spec, plan and review approved; CI green; Gates A and B
recorded; **the real roster supplied by Max/CJ** (department names, who is in
which, which logins are shared). Nothing in this repo contains a real roster.

1. Apply `0052`, `0053`, `0054` in order at a quiet time (they briefly lock
   `production_events`). Check `enabled = false`. Record one event with the
   current app: it must save, with status `disabled`.
2. Deploy the app (the batched release). Check Team, stations and stock.
3. As an owner on the Team page, create the real departments and give each
   working person their home. Each takes effect at the moment you click.
   Shared kiosk/service logins get none. Nothing can be backdated.
4. Check the People list against the roster ("N of M accounts have no home").
5. **Last:** Team → Departments → "Turn on…", with a reason.
6. Run `08-health.sql` now and again during the first 30 minutes.

From the moment it is on, each new event keeps its department. Everything
before that moment stays "unknown" for ever: it is never filled in.

## 5. Health: what to look at

There is no health screen in the app in F5. Run
[`08-health.sql`](../../supabase/staging/departments/08-health.sql)
(read-only). If a query errors, the answer is "unavailable", not "all clear".

| You see | Meaning | Do |
|---|---|---|
| Mostly `assigned`, some `unassigned` | Normal. `unassigned` = people without a home | Compare with the roster |
| `disabled` | The switch is off | Expected until step 5 |
| `resolution_busy` (a few, brief) | A scan arrived while an owner was saving a change | Nothing. If it persists, a change is stuck: check for a long-running session |
| `resolution_error` | The lookup failed; the scan was still saved | Check Postgres logs for `f5_departments resolution_error`; if it repeats, switch off (section 6) |
| `control_missing` | The switch row is gone | Stop and investigate; do not re-create it by guesswork |
| `resolver_unavailable` | The resolver trigger did not run (emergency mode) | Expected only during section 6b |
| `future_clamped` | A tablet clock is up to 5 seconds fast | Credited at receipt time. Fix the tablet's clock when convenient |
| `invalid_time` | A tablet clock is more than 5 seconds fast: **no department** | Fix that tablet's clock now |
| `reported_old` | Reported more than 5 minutes before it arrived | Today there is no offline queue, so this usually means a slow tablet clock or a stuck request. It is still credited at the reported time |

Saved statuses are never repaired later. An event saved as unknown stays
unknown; F8 reports must show those separately and never join them to today's
membership.

## 6. Switching off and rolling back

### 6a. Normal: the switch (no deploy, seconds)

Team → Departments → "Turn off…" → reason → confirm. Or, if the Team page is
unavailable, as a signed-in **owner** call the function (it needs an owner's
session; the SQL editor's own role is not an owner):

```
POST /rest/v1/rpc/department_set_snapshot_enabled
{ "p_request_id": "<a new uuid>", "p_enabled": false,
  "p_expected_version": <current version>, "p_reason": "<why>" }
```

New events are then saved with status `disabled` and no department. Scanning
is unaffected. Nothing already saved changes.

### 6b. Emergency: the resolver itself is failing

Only if scans are failing **because of** the resolver and the switch cannot be
reached. Run as the database operator, exactly these statements:

```sql
-- 1. Disable ONLY the resolver trigger.
ALTER TABLE public.production_events DISABLE TRIGGER production_events_f5_20_resolve;

-- 2. Verify: sanitize and freeze still enabled, and any other trigger untouched.
SELECT tgname, tgenabled FROM pg_trigger
 WHERE tgrelid = 'public.production_events'::regclass AND NOT tgisinternal ORDER BY tgname;
-- Expect: production_events_f5_10_sanitize = O, production_events_f5_10_freeze = O,
--         production_events_f5_20_resolve = D, every other trigger as it was.
```

3. Prove the fallback is safe before relying on it: record one event from a
   station and check it saved with `business_department_status =
   'resolver_unavailable'` and all four department fields NULL. (On staging,
   case M01/M02 of `02-assertions.sql` proves a forged insert is cleared.)
4. Write down: when it was disabled, why, and the range of affected events
   (`08-health.sql` queries 3 and 6). Those events stay `resolver_unavailable`.

Never: `DISABLE TRIGGER ALL` or `USER`, disabling sanitize or freeze, touching
`production_events_reporting_capture` or any stock trigger, changing grants,
or bypassing row-level security.

To recover, after the cause is fixed and re-tested on staging:

```sql
ALTER TABLE public.production_events ENABLE TRIGGER production_events_f5_20_resolve;
```

then record one event and check its status, and only then (if the switch was
also turned off) turn the switch on again from the Team page.

### 6c. Rolling back the app

Promote the previous deployment in Vercel as usual (`docs/RELEASING.md`).
The old app works on the new schema: it sends the same inserts as before, and
the database fills the snapshot (or `disabled` if the switch is off). Leave
the migrations, tables, history and the extension in place. There is no down
migration and no backup restore to "remove" F5. Decide the switch separately:
leave it on if attribution is healthy, off if attribution is the problem.

Rollback rehearsal on staging (Gate B21): point the Preview at the previous
build of the app, record events as kiosk, edit a note in Reports as manager,
confirm both work; turn the switch off and on; do 6b and its recovery once.

## 7. Known limits (by design, for now)

- A wrong tablet clock in the past is taken at its word (marked `reported_old`
  only when more than 5 minutes behind). F6 must add clock checks before
  offline scanning ships.
- Clock in/out events use the database's own time.
- A scan that arrives during the split second an owner is saving a change is
  saved as `resolution_busy`, with no department, rather than made to wait.
- Reports do not show departments yet (F8). Managers, staff, kiosk and CS can
  see nothing new in F5.
- Events can still be deleted by managers as before; F5 does not change that.

## 8. Contract for F6, F7 and F8

- **F6 (scanners / offline):** save the scan time (UTC), the credited
  worker's Auth id and a stable `(location, id)` on the device *before* any
  network call, and send the same `created_at` and the same id on every
  retry. Never send the sync time as `created_at`. Never send the F5 columns:
  the database ignores them. A duplicate-key answer on retry means "already
  saved": read it back, do not update it or mint a new id. F6 must tell an
  honestly old queued scan apart from a wrong clock; F5's `reported_old`
  cannot.
- **F7 (dispatch):** a manual "framed by" is a separate fact with its own
  source, actor and time. Do not create a `line_verified` event with an
  invented time to carry it: its department snapshot would be resolved at
  that invented time.
- **F8 (reports):** group by `business_department_id`; show
  `business_department_name` (the name at the time). `NULL` status = legacy
  (before F5); each other non-`assigned` status is a separate "unknown"
  reason and must be counted and shown, never joined to current membership.
  `department_time_status` is a separate warning that applies to assigned
  rows too. Use the event's `location` and the approved 04:00 site-local
  day / Monday week. Read access for managers, staff and CS is F8's to design;
  F5 grants none.
- Snapshot contract version: `department_snapshot_version = 1`.
