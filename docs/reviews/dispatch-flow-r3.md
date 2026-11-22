# F7 dispatch flow — staging acceptance R3

Final reviewed implementation:1c84eb9e56c78b00ddc3340be324bfc0f5d514d7. Fresh reviewer cleared the focused R2 correction and CSV paging with no residual material findings. Application gate passed1016tests/46files +tsc/digest/API/build at81f2c00; SQL-onlyR2 then passed175F7+160F6 local assertions and15manifest checks.

## Actual isolated staging results, 2026-11-23 00:25–00:27 Asia/Shanghai

Supabase project ybrzhrgfrnvtcwymjdrq only. No production operation.

- Exact reviewed0056 plus all175 assertions passed inside a rollback transaction on actual PostgreSQL. Existing products,ledger and all240123 production-event full-row hashes remained unchanged.
- Created real F6 activation/framing receipts before0056 inside another rollback transaction, applied0056, replayed both: saved results/hashes unchanged, no duplicate framing credit.
- Installed0056 through Supabase apply_migration successfully. It is now immutable. Committed LF SHA256:b13cd1d2f7daea4b2d8b4b73e34b4571329beba85e45f6b97d062ab12d07fa2e. Windows working-file CRLF SHA256:26eb76768b80caad3d0aa81a016811340631cf85d1cf8d04a1b5fb15fde0bcfc; normalizing CRLF to LF matched the reviewed commit exactly.
- Re-ran all160 F6 assertions against the installed F7 schema: pass; old data hashes unchanged.
- Two actual PostgreSQL connections ran R1–R8 plus R3b, observing real Lock waits in pg_stat_activity. Verified competing devices, arriving framing evidence, exact lost-response replay, original rollback, both classic/shared arrival orders, shared framing/dispatch clock-in, cancellation before dispatch, and classic dispatch insertion before deduction. All16 totals true: one dispatch/stock/box where expected, no invented framing credit. Fixtures cleaned.
- Actual PostgREST JWT roles: owner/manager/kiosk picker allowed, staff/CS/anonymous denied; expected-caller fence; missing evidence; manual dispatch and exact replay with one dispatched event and no fake framing events; attribution read scope owner/manager only; direct attribution update denied. Fixtures cleaned.

Operator evidence is outside the repository in C:/Users/cjgom/dev/overnight-20261122/: f7-staging-rollback-schema.json, f7-f6-replay-compatibility.json, f6-staging-installed.json, f7-concurrency.json, f7-postgrest-roles.json, f7-clean-verification.json. Private staging credentials are not part of the repository or deployment.

Combined hosted Preview and actual new UI/IndexedDB flows remain the final release checks. Real cordless scanner commissioning and approved business box rules remain setup work; department tracking stays OFF until the real roster is configured. Existing F1 capture stays OFF.
