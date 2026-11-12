# item-counting · staging fixtures and measurements

Task 4's staging gate in `docs/plans/item-counting.md`: synthetic AU/UK/US
data, more than 100,000 rows in one authorized read, the one-call evidence
function (migration `0034_load_production_evidence.sql`), and measured load
times: median paired total (loader + reducer) one day ≤ 2 s, three months ≤ 10 s.

**Staging only (`ybrzhrgfrnvtcwymjdrq`).** These are not migrations. Every
fixture SQL file stops if it finds the production `default` location, or if it
doesn't find the `staging` location and test users.

## Before the first run (CJ)

Apply `supabase/migrations/0034_load_production_evidence.sql` to **staging
only**, as one transaction, in the SQL editor. It only adds one read-only
function and its grants. `03-query-evidence.sql` checks that the function is
STABLE, SECURITY INVOKER and has `search_path=""`, that only `authenticated`
and `service_role` can execute it, and records a hash of its definition.

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
   Run the command.
2. **all-sites**: CJ temporarily adds the manager test user to `uk` and `us`
   through the existing membership flow, then runs
   `npm run staging:item-counting -- --measure-only`.
3. **denied-after**: CJ restores the manager to AU-only, then runs
   `--measure-only` again.

The gate is COMPLETE only when all three phases passed, in order, against the
same function definition. `--manager-phase=<phase>` overrides the inference.

## Progress and stopping

The console prints each step and, during each load, a heartbeat every 10 s:
case, run, elapsed time, stage (waiting / receiving / validating) and bytes
received. The report is rewritten after every statement, finished case and
heartbeat. If you stop the command with Ctrl+C, or it is killed, the report
keeps everything that finished and ends with `STATUS: FAILED – … stopped
during <step>`.

## What COMPLETE means

- the function's catalog definition and grants are as above;
- 48 labelled `EXPLAIN ANALYZE` plans (owner and manager × six scopes ×
  three call runs + one body plan), each with a measured execution time;
- for every role and scope, the function's `rowCount` equals an independent
  SQL expectation written with `EXISTS` (plus staff, empty-window and
  invalid-input fixtures);
- every timed run made exactly one evidence RPC, loaded exactly the
  independent expectation, and recorded headers, body, parse, load, reducer
  and total time;
- every permitted-site case's median paired total is within its target.
  **A missed target fails the gate.** The coder then records the measured
  bottleneck as an Open question for CJ and does not start Task 5.

## Files

| File | What it does |
|---|---|
| `01-sites.sql` | Adds the `au`/`uk`/`us` sites with settings, worker barcodes and test products. Owner and kiosk get all three sites; manager, staff and cs get AU only. |
| `02-volume.sql` | Adds about 236,000 synthetic production events (two years, three sites; AU Aug–Oct 2026 is busy) plus clock rows. Re-running it adds nothing. |
| `03-query-evidence.sql` | **Generated** by `npx vite-node tests/staging/generate-query-evidence.ts --write` from migration 0034 and the measured cases (a test fails if it is stale). Function, plan and expectation evidence as owner/manager/staff with RLS on. Rolls back. |
| `99-remove-volume.sql` | Deletes only the synthetic volume rows. Run it by hand if needed; the command never runs it. |

## History

The first gate run (2026-11-12) used the old paged loader. CJ stopped the
owner benchmark after about 20 minutes. Read-only plans showed about 2,000
sequential requests per three-month load, so the plan was amended to the
one-call function. The earlier runtime estimates in the plan's log are that
baseline, not acceptance evidence.
