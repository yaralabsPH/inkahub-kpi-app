# Departments review R2 — isolated staging acceptance

2026-11-22. Candidate `6b5dcd3`, app fixes through `a8ca3a3`. Fresh reviewer rechecked the R1 fixes and approved isolated staging acceptance: no remaining blocker. Actual-session gating/remount, late-result discard, frozen switch intent, bounded People/Members paging and resolver privilege ordering are correct. This review does not authorize production.

Claude's final checks: TypeScript, digest typecheck, build and 836 tests / 30 files passed. Non-superuser local SQL reproduced the original 42501 and verified corrected migrations and 321 assertions. Codex separately ran the following on staging project `ybrzhrgfrnvtcwymjdrq` only:

- Applied reviewed 0052–0054, after rollback-only installation checks. These migrations are now installed and immutable; future changes need a new migration.
- Committed `02-assertions.sql`: 315 cases passed. Its two skipped groups require a provider-disallowed session setting. Six supplemental rollback-only cases independently passed: all four legacy-row invariants and both missing-control behaviours, using only the named control guard where needed.
- Exact full legacy payload hashes, excluding the eleven added fields, matched all 240,123 pre-existing events across AU/UK/US/staging. No history was rewritten.
- Actual PostgREST sign-ins: owner reads succeed; manager, staff, kiosk, CS and anonymous owner-only reads/mutations are denied. Control state is not exposed to nonowners.
- Two physical DB connections: S1, S2, S3, S5, S6, S7, S8 and S9 passed, including real observed lock waits, bounded admin timeout/retry, stale assignment refusal, removal race, exclusion constraint, duplicate event race, parallel scans and isolation refusal. The first harness attempt used the pool proxy PID to observe a lock and stopped; cleanup succeeded. Corrected harness used `pg_backend_pid()` and passed the full run. This was an operator harness issue, not an app change.
- Quick rollback benchmark: 10,000 assignment intervals, 1,000 measured inserts per phase; p95 2.352 ms with resolver, 0.332 ms without, added 2.020 ms. Below 20 ms target. The displayed standalone lookup selected a sequential scan at this distribution (20 people); do not claim the plan used an index or extrapolate to the deferred large benchmark.
- Synthetic fixtures removed; final event count 240,123, departments zero, tracking OFF, control version 5. Version advanced only through test on/off operations. F1 capture remains OFF and all original/F5 triggers enabled.

Evidence JSON and operator harness are outside the repository in `C:/Users/cjgom/dev/overnight-20261122/` (`f5-baseline`, `f5-staging-assertions`, `f5-supplemental-acceptance`, `f5-postgrest-roles`, `f5-concurrency-performance`). They contain no credentials.

Remaining acceptance: actual owner UI/session/switch flows and old Preview rollback smoke on the final combined Preview; CI on the pushed branch. Real roster activation, F1-capture-on/#8 composition, physical hardware and the 100,000-interval/two-year release benchmark remain separate commissioning/production gates. No production deployment, schema, settings or data were touched.
