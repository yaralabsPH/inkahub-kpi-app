# Reporting storage and capture on staging (item-counting Task 12)

STAGING ONLY: `ybrzhrgfrnvtcwymjdrq`. Never point any of this at production.
Agents never apply SQL to production; CJ (or the planner on CJ's instruction)
applies `0037` to staging as one transaction.

## What 0037 adds

- Schema `reporting_private` (server-only; never add it to the Data API
  exposed schemas) with the tables from the plan's data model.
- Role `reporting_capture`: NOLOGIN, NOINHERIT, no BYPASSRLS, no memberships.
  It owns only the capture trigger function. Grants: schema USAGE, `control`
  SELECT, `changes` INSERT and the change-id sequence. Two policies address
  only it (control SELECT, changes INSERT). Clients get nothing.
- One trigger on `public.production_events`
  (`production_events_reporting_capture`, AFTER INSERT/UPDATE/DELETE, per
  row). It writes one journal row in the same transaction as the save, for
  supported sites (au, uk, us) only; an identical-row UPDATE writes nothing.
  Any journal failure aborts the save.
- Capture starts **disabled**; processors start off; every site reads
  `legacy`. Every change of `control.capture_enabled` advances
  `capture_epoch`.

PostgreSQL 16+ is required (`GRANT … WITH INHERIT FALSE, SET TRUE`,
`UNIQUE NULLS NOT DISTINCT`). Staging runs 17.x. CJ confirms production's
version before any production step (agents do not inspect production).

## Runner

`npm run staging:reporting-capture -- <one mode>` reads `.env.staging.local`
(same keys as `staging:item-counting`; values are never printed). It refuses
any database that is not staging: the URL must carry the staging ref, and the
database must have the `staging` location and its test users. That guard runs
before every phase. Every phase is ONE transaction that is always ROLLED BACK.

| Mode | Needs | Does |
| --- | --- | --- |
| `--rehearse-migration` | 0037 NOT installed | Applies 0037's statements inside the rolled-back transaction, then runs all checks below against it. Afterwards checks the schema is gone again. |
| `--check` | 0037 installed | Catalog/ACL checks, capture steps, write-compat replay, trigger overhead. |
| `--concurrency` | 0037 installed, capture **enabled** (committed operator step) | Two connections: the first saves at au and stays open; the second saves at au with `lock_timeout = 3s` and must finish without waiting. Both roll back. |

Checks (`tests/staging/reportingCapture.ts`):

- **Catalog and access**:
  - exact tables, RLS on everywhere, the capture role's attributes and memberships;
  - function owners, SECURITY DEFINER/INVOKER and `search_path=""`, no dynamic SQL;
  - exactly the two policies; exactly one trigger on `production_events`;
  - schema/table/function privileges for anon, authenticated, service_role and reporting_capture; no PUBLIC ACL;
  - not exposed through the Data API;
  - `production_events` policy hash still the installed 0036 hash.
- **Capture steps** (`c..`, `d..`, `e..`), using real session claims for each role:
  - save, correction (order/person/time), move au→uk, no-op update and delete are journalled with full images;
  - the staging site is not journalled;
  - identical saves are both kept;
  - a rolled-back save leaves no journal row;
  - a refused journal insert, or a missing control row, makes the save fail;
  - anon/staff/kiosk/cs/manager/owner cannot read or write any reporting table or call the capture function;
  - service_role reads but cannot call it;
  - disabling capture advances the epoch and older generations stop being continuous;
  - the epoch cannot go back, a second active batch per site is refused, negative Items are refused, a published generation is immutable.
- **Existing write paths**: the Task 4 write-compat steps (kiosk/staff/manager/owner inserts, RLS denial, inventory deduction exactly once plus idempotent retry, corrections, deletes, Reports remove, digest read, anon denial) run with capture enabled and must behave exactly as before. They write no journal rows, because they use the staging site.
- **Overhead**: 3 alternating rounds of 200 staff inserts at au with capture off/on; median ms per row, delta and ratio.

Report: `staging-results-reporting-capture-<mode>.md` (git-ignored), ending
with exactly one `STATUS: COMPLETE` or `STATUS: FAILED – <reason>` line.

## Suggested staging order (planner/CJ decide each step)

1. `--rehearse-migration` (nothing kept).
2. Apply `0037` to staging as one transaction.
3. `--check`.
4. Operator enables capture on staging (`update reporting_private.control set capture_enabled = true where singleton;`, committed; advances the epoch), then `--concurrency`.
5. Decide whether capture stays enabled on staging. Disabling it again advances the epoch too.

Rollback (a new migration if ever needed): drop the trigger (stops capture
immediately; source writes are exactly as before 0037), then
`DROP SCHEMA reporting_private CASCADE; DROP ROLE reporting_capture;`.
