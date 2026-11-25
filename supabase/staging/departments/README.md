# F5 departments — staging verification scripts

**Staging only. Never run any of this against production.** The scripts that
change anything refuse to start unless the database has a location with key
`staging`. `08-health.sql` is read-only and is also the production health
check (run by CJ).

Full instructions, the evidence template and the rollback steps are in
[`docs/runbooks/departments.md`](../../../docs/runbooks/departments.md).

| File | What it does | Keeps data? |
|---|---|---|
| `00-preflight.sql` | Read-only snapshot. Run before AND after applying the migrations and compare. | No (reads only) |
| `01-fixtures.sql` | Creates synthetic "F5X" people and departments for the two-session script. | **Yes** (commits) |
| `02-assertions.sql` | About 320 named cases: privileges, roles, admin rules, snapshots, time boundaries, frozen history, legacy rows, removal, pages, failure injection, emergency mode. | No (rolls back) |
| `05-session-a.sql`, `05-session-b.sql` | Concurrency, step by step, in two `psql` windows. | **Yes** (uses the F5X fixtures) |
| `06-composition.sql` | With the item-counting capture trigger: one captured insert with the final F5 fields. | No (rolls back) |
| `07-performance.sql` | Cost of the lookup per insert, with a query plan. | No (rolls back) |
| `08-health.sql` | Read-only operator health queries. | No (reads only) |
| `09-cleanup.sql` | Removes the F5X fixtures and proves none are left. | Removes |

Roles and failure injection are sections D, L and M of `02-assertions.sql`
(not separate files), so they share one set of fixtures and one rollback.

## Order

1. `00-preflight.sql` (save the output), then apply `0052`, `0053`, `0054` in
   order, then `00-preflight.sql` again.
2. `02-assertions.sql` — pass is the final notice
   `F5 verify: ALL CHECKS PASSED (N cases, 0 skipped; ...)`. A failure raises
   `F5 verify FAILED [<case>] ...`. A skipped case is **not** a pass.
3. `06-composition.sql`, `07-performance.sql`.
4. `01-fixtures.sql`, then `05-session-a.sql` + `05-session-b.sql` in two
   `psql` windows, then `09-cleanup.sql`.
5. `08-health.sql` at any time.

## How they were checked before staging

Each script was executed on a throwaway local Postgres (PGlite) with stand-ins
for the Supabase roles and the recovered tables. That catches SQL errors and
logic mistakes; it is **not** staging evidence. It cannot show Supabase's real
role privileges, two real sessions, or real timings. Record staging results in
[`docs/releases/departments.md`](../../../docs/releases/departments.md).
