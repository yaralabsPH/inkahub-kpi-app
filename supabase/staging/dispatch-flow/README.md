# F7 dispatch flow — staging verification scripts

**Staging only. Never run any of this against production.** Every script
refuses to start unless the database has a location with key `staging`.

| File | What it does | Keeps data? |
|---|---|---|
| `02-assertions.sql` | 167 named cases: privileges, roles, caller fence, internal helpers, no client writes, people list (A); dispatch badge sign-in: dispatch clock-in, replay, one clock-in per workday across framing/dispatch, unknown/unusable badges, cross-table request ids (B); framing evidence (current attempt only): F6 same-instant ids, verification without completion, another person's completion, cancelled verification, scrapped attempt then a valid one, two framers = conflict, other site, short quantity, completion before verification, CS / other SKU / other work type, classic lower-case SKU + A0, same-SKU cancel, >1000 events = overflow, grammar, scrap AFTER completion then a new attempt, same-SKU vs other-SKU cancel after completion, reopen (started after completion) then a new pair, completion for another SKU vs the same SKU (C); dispatch commit: measured save with stock + F4 Dispatch pick + attribution, replay, changed payload, second device, missing evidence = nothing written, manual choice labelled manual with no framing events, inactive / other-site framer, measured evidence preferred over a choice, per-SKU mix, unframed-only, all-or-nothing on stock and packaging, input bounds, classic dispatch first, immutable rows, framed lines without a Dispatch parcel (SQL NULL and JSON null) refused, A0-only without parcel saves, RLS by role (D); F6 framing then dispatch exactly once each, A0 stock/box never charged at dispatch, c6 still refuses duplicate framing credit (E); c7 guard: classic dispatch after a shared dispatch refused with nothing written, CS replacement dispatch passes, ordinary classic dispatch unchanged, framing cancel/start takes the order lock and other work does not (G). | No (one transaction, ROLLBACK) |
| `01-fixtures.sql` | Synthetic site `f7race`: two kiosks, two framers, a dispatcher, two products, auto mode, one rule set, recorded framing on seven orders. Does not touch the real `staging` site. | **Yes** (commits) |
| `05-session-a.sql`, `05-session-b.sql` | Two-session races, step by step: R1 two devices dispatch one order; R2 classic framing (verification + completion) held open while a manual-choice dispatch waits — measured wins; R3 lost-response retry racing the original; R3b original rolls back, then the retry saves once; R4 classic dispatch + deduction first, shared dispatch waits then adds nothing; R5 shared dispatch first, the classic `dispatched` insert waits and is then REFUSED; R6 framing and dispatch sign-in of one person at once (one clock-in); R7 a classic whole-order scrap held open, the dispatch waits and is then refused `framer_missing`; R8 a classic `dispatched` insert held open without its deduction, the shared dispatch waits and then adds nothing. Ends with a totals query (16 columns) that must be all `true`. | **Yes** (uses the fixtures) |
| `09-cleanup.sql` | Removes `f7race` and the f78000… accounts and proves nothing is left. | Removes |

## Order

1. Apply `supabase/migrations/0056_dispatch_flow.sql` (after 0047 and 0052–0055).
2. `02-assertions.sql` — pass is the final notice
   `F7 verify: ALL CHECKS PASSED (167 cases; rolling back, nothing kept)`.
   A failure raises `F7 verify FAILED [<case>] ...`. While it runs it sets
   the staging site's packaging mode to auto and retires its active rule set
   inside the transaction (rolled back). Re-run the F6
   `scanner-stations/02-assertions.sql` too: it must still pass with 0056.
3. `01-fixtures.sql`, then `05-session-a.sql` + `05-session-b.sql` in two
   `psql` windows following the step names, then `09-cleanup.sql`.
   Step order: R1-A1, R1-B1 (waits), R1-A2; R2-B1, R2-A1 (waits), R2-B2;
   R3-A1, R3-B1 (waits), R3-A2, R3-B2; R3b-A1, R3b-B1 (waits), R3b-A2;
   R4-B1, R4-A1 (waits), R4-B2; R5-A1, R5-B1 (waits), R5-A2;
   R6-A1, R6-B1 (waits), R6-A2; R7-B1, R7-A1 (waits), R7-B2;
   R8-B1, R8-A1 (waits), R8-B2; then A-END.
   Changed from the first version: R5 no longer has a B2 deduction step (the
   classic insert itself now waits and is refused); R7 and R8 are new.

## How they were checked before staging

`02-assertions.sql` passed (167 cases) on a throwaway local Postgres
(PGlite 0.2, the F5/F6 harness) applying 0031, 0047, 0052–0055 and 0056
twice (re-run safety); the F6 `02-assertions.sql` still passed (160 cases)
with 0056 applied. Removing each fix from 0056 in turn made its case fail
(C16b on the previous 0056, C19a SKU match, D15a parcel required, G01
dispatch guard, G06 order lock), and removing the same-person rule fails
C03. The race scripts were run there sequentially, each waiting step placed
where it returns: every step gave its expected answer and all 16 totals
were `true`. PGlite has one connection, so this shows no blocking at all.
**None of this is staging or concurrency evidence.** Record staging results
in [`docs/releases/dispatch-flow.md`](../../../docs/releases/dispatch-flow.md).
