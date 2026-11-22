# F6 shared scanner stations — staging verification scripts

**Staging only. Never run any of this against production.** Every script
refuses to start unless the database has a location with key `staging`.

| File | What it does | Keeps data? |
|---|---|---|
| `02-assertions.sql` | 134 named cases: privileges and roles (A), badge activation and clock-in incl. 04:00 site workday (B), regular framed save / replay / canonical hash / conflict / already recorded / F5 snapshot (C), A0 save with components + F4 packaging and classic alias de-duplication (D), all-or-nothing refusals and stock floor (E), input bounds (F), revoked badge / removed person / open case at commit (G), prior and partial work (H), the replaced legacy deduction: authorization, unchanged skips, retries, aliases (J), health row (K), unique backstop and indexes (L). | No (one transaction, ROLLBACK) |
| `01-fixtures.sql` | Synthetic site `f6race` with two kiosks, two people, two products, auto mode and one rule set. Does not touch the real `staging` site. | **Yes** (commits) |
| `05-session-a.sql`, `05-session-b.sql` | Two-session races, step by step: R1 shared commit first vs classic deduction, R2 classic first vs shared commit, R3 lost-response retry racing the original, R3b original rolls back then the retry saves once, R4 two scanners same order, R5 one badge on two scanners (one clock-in). Ends with a totals query that must be all `true`. | **Yes** (uses the fixtures) |
| `09-cleanup.sql` | Removes `f6race` and the f68000… accounts and proves nothing is left. | Removes |

## Order

1. Apply `supabase/migrations/0055_scanner_stations.sql` (after 0047 and 0052–0054).
2. `02-assertions.sql` — pass is the final notice
   `F6 verify: ALL CHECKS PASSED (134 cases; rolling back, nothing kept)`.
   A failure raises `F6 verify FAILED [<case>] ...`. While it runs it sets
   the staging site's packaging mode to auto and retires its active rule set
   inside the transaction (rolled back).
3. `01-fixtures.sql`, then `05-session-a.sql` + `05-session-b.sql` in two
   `psql` windows following the step names, then `09-cleanup.sql`.

Case E09 (stock floor) adapts to the schema: if `products` still has the
0001 `CHECK (current_on_hand >= 0)`, the commit must fail with 23514 and
write nothing; otherwise it must save and report the negative code.

## How they were checked before staging

`02-assertions.sql` passed (134 cases) on a throwaway local Postgres
(PGlite 0.2) with stand-ins for Supabase roles and the recovered tables,
applying 0031, 0047 and 0052–0055 (0055 applied twice to prove re-run
safety). The race scripts were run there sequentially only to catch SQL
errors: PGlite has one connection, so it cannot show any blocking. None of
this is staging evidence. Record staging results in
[`docs/releases/scanner-stations.md`](../../../docs/releases/scanner-stations.md).
