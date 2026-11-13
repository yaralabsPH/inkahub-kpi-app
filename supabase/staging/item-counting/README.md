# item-counting · staging fixtures and measurements

Task 4's staging gate in `docs/plans/item-counting.md`: synthetic AU/UK/US
data, more than 100,000 rows in one authorized read, the one-call evidence
function v2 (migration `0035_load_production_evidence_v2.sql`; v1 from `0034`
stays for old code), and measured load times: median paired total
(loader + reducer) one day ≤ 2 s, three months ≤ 10 s.

**Staging only (`ybrzhrgfrnvtcwymjdrq`).** These are not migrations. Every
fixture SQL file stops if it finds the production `default` location, or if it
doesn't find the `staging` location and test users.

## Before the first v2 run

Apply `supabase/migrations/0035_load_production_evidence_v2.sql` to **staging
only**, as one transaction (0034 must already be there; leave it unchanged).
It only adds one read-only function and its grants. `03-query-evidence.sql`
checks that v1 and v2 are STABLE, SECURITY INVOKER with `search_path=""`, that
only `authenticated` and `service_role` can execute them, and records a hash
of v2's definition. Manager phases are recorded against that hash.

## Policy amendment 0036: staging sequence

`0036_production_events_select_initplans.sql` rewrites only the two SELECT
policies on `production_events` so their checks run once per statement.
Visibility must not change, so the gate proves it on staging, in this order
(the runner never applies SQL; each SQL step is CJ's, or Astra's on CJ's
instruction):

1. `npm run staging:item-counting -- --policy-parity=before` (standard
   memberships).
2. Remove `uk` from the owner and kiosk test users; run
   `npm run staging:item-counting -- --policy-parity=before --arrangement=owner-kiosk-without-uk`;
   restore `uk`.
3. Apply `0036` on staging.
4. `npm run staging:item-counting -- --policy-parity=after`.
5. Remove `uk` from owner and kiosk again; run
   `--policy-parity=after --arrangement=owner-kiosk-without-uk`; restore `uk`.
6. The three manager phases below (`--measure-only --manager-phase=…`).

Parity reads what every role (owner, manager, staff, kiosk, cs, and a session
with no subject) can see at each site, month by month, as `authenticated`
with RLS on, real session claims and the 8 s limit. It also replays each
direct app reader's filters (clock cards, timesheet, completions, package
history, recent activity, Production, Reports, Welcome). Before and after
must match exactly, by row id, not just by count. Only the two SELECT
policies may change: write policies, helpers, grants, RLS flags, role
settings and both evidence functions are fingerprinted and must not. A
privileged fingerprint of all saved events detects data changes in between.
Results go to `staging-results-item-counting.policy-parity.json` and
`staging-results-item-counting-policy-parity.md` (git-ignored, ending with a
STATUS line).

## Real session claims

The runner signs in all five test users and passes each session's real JWT
claims to the SQL as bound parameters (never written anywhere; reports show
only sizes). Through the API, RLS parses those claims on every
`auth.uid()` call, so tiny `{sub, role}` claims under-measure it by about
2 s. 03 fails if it is run without the runner's claims. Add the staff, kiosk
and cs logins to `.env.staging.local` (`STAGING_STAFF_EMAIL`,
`STAGING_STAFF_PASSWORD`, `STAGING_KIOSK_EMAIL`, `STAGING_KIOSK_PASSWORD`,
`STAGING_CS_EMAIL`, `STAGING_CS_PASSWORD`).

## The API's time limit is part of the test

Through the API, every request runs as `authenticated`, whose
`statement_timeout` is 8 s (`pg_roles`). `SET ROLE` alone does not apply it,
which is why the v1 SQL evidence passed while the API timed out. After every
role switch, 03 now reads that setting from the catalog and applies it with
`SET LOCAL`, and runs PostgREST's real statement shape with the whole body
converted to text. If AU three months takes over 8 s in SQL, the statement
is cancelled, the gate fails, and **no API timing starts**. Never raise the
setting.

## Run it: one command

```
npm run staging:item-counting                  # first time: fixtures + evidence + loads
npm run staging:item-counting -- --measure-only   # later: evidence + loads only
```

The command (`tests/staging/run-item-counting.ts`):

1. reads settings **only** from `.env.staging.local` in the repo root, and
   refuses to run unless the staging ref is in the database host or user name
   and in the Supabase URL;
2. runs `01-sites.sql` and `02-volume.sql` (skipped with `--measure-only`), then
   `03-query-evidence.sql`, one statement at a time, and captures **every**
   result set. If a statement fails, it rolls back and stops;
3. times the real one-call loader as the owner test user, then the manager:
   three runs per case, with the fixed cutoff `2026-11-12T00:00:00Z`;
4. checks everything (see "What COMPLETE means");
5. writes `staging-results-item-counting.md`. That file ends with
   `STATUS: COMPLETE` or `STATUS: FAILED – <reason>`, and the command exits
   non-zero on failure.

## Manager runs in three membership phases

The plan needs the manager measured both while denied UK/US and while
permitted at every site. The runner works out the phase from the manager's
site memberships and records each finished phase in
`staging-results-item-counting.phases.json`:

1. **denied-before**: manager is AU-only (as `01-sites.sql` creates it).
   Run `npm run staging:item-counting -- --measure-only --manager-phase=denied-before`.
2. **all-sites**: temporarily add the manager test user to `uk` and `us`
   through the existing membership flow, then run
   `npm run staging:item-counting -- --measure-only --manager-phase=all-sites`.
3. **denied-after**: restore the manager to AU-only, then run
   `npm run staging:item-counting -- --measure-only --manager-phase=denied-after`.

A phase is recorded only when its own SQL gate and every owner and manager
API run passed. It is tagged with the v2 function name, definition hash,
encoding version, harness version, the policy hash and the parity artifact
hash, so records from before 0036 (or from v1) never count. The SQL gate
also requires completed parity for the current policies before any API
timing. The gate
is COMPLETE only when all three phases passed, in order, for that same
identity. A `--manager-phase` that doesn't match the manager's real
memberships is refused. Until the later phases are run, the report ends with
`STATUS: FAILED – awaiting manager phase(s) … (expected; no query or performance failure)`.

## Progress and stopping

The console prints each step and, during each load, a heartbeat every 10 s:
case, run, elapsed time, stage (waiting / receiving / validating) and bytes
received. The report is rewritten after every statement, finished case and
heartbeat. If you stop the command with Ctrl+C, or it is killed, the report
keeps everything that finished and ends with `STATUS: FAILED – … stopped
during <step>`.

## What COMPLETE means

- both functions' catalog definitions and grants are as above;
- the authenticated role's catalog `statement_timeout` (8 s) applied and in
  effect after all four role switches, with RLS on;
- 48 labelled `EXPLAIN ANALYZE` plans (owner and manager × six scopes ×
  three call runs + one body plan), each with a measured execution time;
- 36 runs of PostgREST's real statement shape with the full body converted to
  text (three per owner/manager scope), all inside the time limit;
- for every role and scope, the function's `rowCount` equals an independent
  SQL expectation written with `EXISTS`; for day scopes and staff, every
  decoded field and both dictionaries match the table rows (plus
  empty-window and invalid-input fixtures);
- every timed run made exactly one v2 evidence RPC (and none to v1), loaded
  exactly the independent expectation, and recorded headers, body, parse, load, reducer
  and total time;
- every permitted-site case's median paired total is within its target.
  **A missed target fails the gate.** The coder then records the measured
  bottleneck as an Open question for CJ and does not start Task 5.

## Files

| File | What it does |
|---|---|
| `01-sites.sql` | Adds the `au`/`uk`/`us` sites with settings, worker barcodes and test products. Owner and kiosk get all three sites; manager, staff and cs get AU only. |
| `02-volume.sql` | Adds about 236,000 synthetic production events (two years, three sites; AU Aug–Oct 2026 is busy) plus clock rows. Re-running it adds nothing. |
| `03-query-evidence.sql` | **Generated** by `npx vite-node tests/staging/generate-query-evidence.ts --write` from migration 0035 and the measured cases (a test fails if it is stale). Function, time-limit, plan, full-body and expectation evidence as owner/manager/staff with RLS on. Changes nothing; rolls back. |
| `99-remove-volume.sql` | Deletes only the synthetic volume rows. Run it by hand if needed; the command never runs it. |

## History

The second run (2026-11-13, v1 function from 0034) failed: AU three months
hit the API's 8 s `authenticated` statement_timeout on all six runs, while
the SQL evidence (run without that limit, EXPLAIN only) looked fine. See the
plan's Open questions for the measurements that led to v2.

The first gate run (2026-11-12) used the old paged loader. CJ stopped the
owner benchmark after about 20 minutes. Read-only plans showed about 2,000
sequential requests per three-month load, so the plan was amended to the
one-call function. The earlier runtime estimates in the plan's log are that
baseline, not acceptance evidence.
