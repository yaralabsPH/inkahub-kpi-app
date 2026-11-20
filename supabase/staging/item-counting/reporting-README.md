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
(same keys as `staging:item-counting`; values are never printed).

- **Target guard at every query.** The staging target is parsed once and
  frozen. Every client is wrapped, so EACH query (including role changes,
  helper queries, migration statements and cleanup) first checks locally,
  with no SQL, that the frozen target and the client's own connection host
  and user are the staging project. That also works inside an aborted
  transaction. Each new connection also runs the staging-marker check: the
  `staging` location and its test users.
- **No timeout overrides.** The runner sets no statement or idle timeout; it
  records the existing values in the report. The only setting it changes is
  a transaction-local `lock_timeout = 3s` in the concurrency probe.
- Every phase is ONE transaction that is always ROLLED BACK. Afterwards, on
  success AND on failure, a **fresh guarded connection audits** the result.
  It compares the reporting schema/ACL/control/site state, whether the
  capture role exists, the `production_events` triggers, and fixture state
  (test events, synthetic products, test ledger rows, staging stock and an AU
  stock fingerprint) with the state captured at the start. A rollback,
  disconnect or audit failure makes the run FAILED ("restoration not
  verified"); a run is COMPLETE only when that audit passes.
- Each invocation writes its own report,
  `staging-results-reporting-capture-<mode>-<start>-<id>.md` (git-ignored),
  and never overwrites an earlier one. Partial results are saved as it goes.

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
  - an event-ID change keeps the old and new keys and images;
  - a rolled-back AU scenario on two synthetic products (`rc-sup-*`): a kiosk completion is journalled, the ordinary deduction moves stock exactly once with two ledger rows, the retry is idempotent, and nothing remains afterwards. Existing AU products are never touched;
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

Each report ends with exactly one `STATUS: COMPLETE` or
`STATUS: FAILED – <reason>` line. Trigger overhead here is diagnostic only;
Task 19 owns the capture p95 gate.

## Suggested staging order (planner/CJ decide each step)

1. `--rehearse-migration` (nothing kept).
2. Apply `0037` to staging as one transaction.
3. `--check`.
4. Operator enables capture on staging (`update reporting_private.control set capture_enabled = true where singleton;`, committed; advances the epoch), then `--concurrency`.
5. Decide whether capture stays enabled on staging. Disabling it again advances the epoch too.

Rollback (a new migration if ever needed): drop the trigger (stops capture
immediately; source writes are exactly as before 0037), then
`DROP SCHEMA reporting_private CASCADE; DROP ROLE reporting_capture;`.

## Activation fence (Task 13, migration 0038 Part A)

0038 (draft until the planner applies it) changes the capture trigger
function to read the control row `FOR SHARE`. That lock is shared by
ordinary writers and held until the source transaction ends, so a capture
toggle waits for writes that started before it. 0038 also adds:

- `UPDATE(updated_at)` plus a lock-only policy (`WITH CHECK (false)`) for
  `reporting_capture`;
- the service-only `public.set_reporting_capture(boolean)`, with a lock wait
  of at most 3 s that keeps a stricter existing limit;
- per-site batch receipts with delayed global acknowledgement;
- `public.begin_reporting_batch(site)` (a single-statement freeze; refresh
  only) and `public.get_reporting_job_status(site)`.

`npm run staging:reporting-jobs -- --fence` (needs 0038 applied) drives real
connections:

| id | proves |
| --- | --- |
| F1 | two source writers at au with capture enabled do not wait on each other |
| F2 | enabling waits for an open disabled-period write; a READ COMMITTED writer queued behind the uncommitted toggle then journals at the new epoch |
| F3 | a REPEATABLE READ writer whose snapshot predates the enable fails with 40001 |
| F4 | disable → re-enable advances the epoch by one each; a later write carries the new epoch |
| F5 | a toggle blocked by an open writer fails with 55P03 near 3 s, or after 1 s under a stricter session limit, and control is unchanged |
| F6 | as `reporting_capture` (membership granted inside a rolled-back transaction): the `FOR SHARE` lock works; UPDATE of `updated_at` (RLS `WITH CHECK false`) and of `capture_enabled` (no privilege) are both refused with 42501 |

Source writes (`rj-*` ids) are always rolled back. Capture toggles are
committed: each advances the epoch. Capture is returned to its starting
on/off state, and the fresh audit checks the catalog (with the epoch and
`updated_at` excluded), the capture state and that no `rj-*` events or
journal rows remain. Every client is guarded and marker-checked, every
scenario connection is rolled back and ended, and every cleanup failure is
reported. The report is `staging-results-reporting-fence-<start>-<id>.md`.

The per-site receipt orders (AU→UK publication in both orders, one side
failing and restarting, delayed global acknowledgement) need publication.
They are added with Part B.
