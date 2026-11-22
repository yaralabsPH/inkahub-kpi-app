# F7 dispatch flow — staging verification scripts

**Staging only. Never run any of this against production.** Every script
refuses to start unless the database has a location with key `staging`.

| File | What it does | Keeps data? |
|---|---|---|
| `02-assertions.sql` | 136 named cases: privileges, roles, caller fence, internal helpers, no client writes, people list (A); dispatch badge sign-in: dispatch clock-in, replay, one clock-in per workday across framing/dispatch, unknown/unusable badges, cross-table request ids (B); framing evidence: F6 same-instant ids, verification without completion, another person's completion, cancelled verification, scrapped attempt then a valid one, two framers = conflict, other site, short quantity, completion before verification, CS / other SKU / other work type, classic lower-case SKU + A0, same-SKU cancel, >1000 events = overflow, grammar (C); dispatch commit: measured save with stock + F4 Dispatch pick + attribution, replay, changed payload, second device, missing evidence = nothing written, manual choice labelled manual with no framing events, inactive / other-site framer, measured evidence preferred over a choice, per-SKU mix, unframed-only, all-or-nothing on stock and packaging, input bounds, classic dispatch first, immutable rows, legacy deduction afterwards charges nothing, RLS by role (D); F6 framing then dispatch exactly once each, A0 stock/box never charged at dispatch, c6 guard still refuses duplicate framing credit (E). | No (one transaction, ROLLBACK) |
| `01-fixtures.sql` | Synthetic site `f7race`: two kiosks, two framers, a dispatcher, two products, auto mode, one rule set, recorded framing on five orders. Does not touch the real `staging` site. | **Yes** (commits) |
| `05-session-a.sql`, `05-session-b.sql` | Two-session races, step by step: R1 two devices dispatch one order, R2 measured evidence arrives (classic framing holding the order lock) while a manual-choice dispatch waits — measured wins, R3 lost-response retry racing the original, R3b original rolls back then the retry saves once, R4 classic dispatch + deduction first, R5 shared dispatch first while a classic deduction waits, R6 framing and dispatch sign-in of one person at once (one clock-in). Ends with a totals query that must be all `true`. | **Yes** (uses the fixtures) |
| `09-cleanup.sql` | Removes `f7race` and the f78000… accounts and proves nothing is left. | Removes |

## Order

1. Apply `supabase/migrations/0056_dispatch_flow.sql` (after 0047 and 0052–0055).
2. `02-assertions.sql` — pass is the final notice
   `F7 verify: ALL CHECKS PASSED (136 cases; rolling back, nothing kept)`.
   A failure raises `F7 verify FAILED [<case>] ...`. While it runs it sets
   the staging site's packaging mode to auto and retires its active rule set
   inside the transaction (rolled back). Re-run the F6
   `scanner-stations/02-assertions.sql` too: it must still pass with 0056.
3. `01-fixtures.sql`, then `05-session-a.sql` + `05-session-b.sql` in two
   `psql` windows following the step names, then `09-cleanup.sql`.

## How they were checked before staging

`02-assertions.sql` passed (136 cases) on a throwaway local Postgres
(PGlite 0.2, the F5/F6 harness) applying 0031, 0047, 0052–0055 and 0056
twice (re-run safety); the F6 `02-assertions.sql` still passed (160 cases)
with 0056 applied. One mutation (dropping the same-person rule) made case
C03 fail as expected. The race scripts were run there sequentially in the
documented step order: every step returned its expected answer and the
totals query was all `true`. PGlite has one connection, so this shows no
blocking at all. **None of this is staging evidence.** Record staging
results in [`docs/releases/dispatch-flow.md`](../../../docs/releases/dispatch-flow.md).
