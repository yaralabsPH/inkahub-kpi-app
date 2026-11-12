# item-counting · staging fixtures and measurements

Task 4's staging gate in `docs/plans/item-counting.md`: synthetic AU/UK/US
data, more than 100,000 rows in one authorized read, and measured load times
(one day ≤ 2 s, three months ≤ 10 s).

**Staging only (`ybrzhrgfrnvtcwymjdrq`).** Not migrations. Every SQL file
stops if it finds the production `default` location, or if it doesn't find the
`staging` location and test users.

## Run it: one command

```
npm run staging:item-counting
```

The command (`tests/staging/run-item-counting.ts`):

1. reads settings **only** from `.env.staging.local` in the repo root, and
   refuses to run unless the staging ref is in the database host or user name
   and in the Supabase URL;
2. runs `01-sites.sql`, `02-volume.sql` and `03-query-evidence.sql` one
   statement at a time and captures **every** result set. If a statement fails,
   it rolls back and stops;
3. times the real loader as the owner test user, then as the manager;
4. checks every expected result is present and non-empty;
5. writes `staging-results-item-counting.md`. That file ends with
   `STATUS: COMPLETE` or `STATUS: FAILED – <reason>`, and the command exits
   non-zero on failure.

`.env.staging.local` and `staging-results-*.md` are git-ignored, and CI fails
if one is ever committed.

**Progress and stopping.** The console prints each step and, during each
load, a heartbeat every 10 s: case, run, elapsed time, requests and rows read.
The report file is rewritten after every statement, finished case and
heartbeat. If you stop the command with Ctrl+C, or it is killed, the report
keeps everything that finished. It ends with `STATUS: FAILED – … stopped
during <step>`, so a stopped run never reads as complete.

**Expected duration.** With the current indexes, the AU three-month case takes
about 12 minutes per run (see the plan's Open questions); 3 runs take about
35 minutes. The other cases are much shorter.

## Files

| File | What it does |
|---|---|
| `01-sites.sql` | Adds the `au`/`uk`/`us` sites with settings, worker barcodes and test products. Owner and kiosk get all three sites; manager, staff and cs get AU only. |
| `02-volume.sql` | Adds about 236,000 synthetic production events (two years, three sites; AU Aug–Oct 2026 is busy) plus clock rows. Re-running it adds nothing. |
| `03-query-evidence.sql` | Lists indexes and table size, and runs `EXPLAIN ANALYZE` on the loader's four query shapes as the owner test user with RLS on. Rolls back. |
| `99-remove-volume.sql` | Deletes only the synthetic volume rows. Run it by hand if needed; the command never runs it. |

STATUS covers whether the evidence is complete. If a measured case misses its
latency target, the report lists it under "Latency targets", and the coder
records it as an Open question in the plan instead of starting Task 5.
