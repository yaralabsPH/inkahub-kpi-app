# Release record: F6 shared scanner stations

Branch `feature/scanner-stations`. Staging only; production and `main` untouched.
Base: reviewed F5 `25c4c808` (+ review-doc commits up to `119d52a`).
Migrations: adds `0055_scanner_stations.sql` only (`git diff --name-status 25c4c80 HEAD -- supabase/migrations` = `A 0055`).
0048–0051 stay reserved for F3; 0052–0054 (F5, installed on staging) are unchanged.

## SQL to apply / run (sha256 of the committed LF text)

| File | sha256 |
|---|---|
| `supabase/migrations/0055_scanner_stations.sql` | `3e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620` |
| `supabase/staging/scanner-stations/01-fixtures.sql` | `8d943e39cce7df592beec931128a0e62266390dc93b62ea9d0898d7d55af5c93` |
| `supabase/staging/scanner-stations/02-assertions.sql` | `5448803a57fc41fbaf90a3703486c3192c38e9dfdf81a5fefb733a7c2d92f225` |
| `supabase/staging/scanner-stations/05-session-a.sql` | `171fd3d8025af0f713585e8a9e8d9c51ff1fdf72f7d251aff0d1385265e0b101` |
| `supabase/staging/scanner-stations/05-session-b.sql` | `62d21a32d1f513b84562daa92fb76e4b9bad5cbca513eb95cd4b43125f7abbaa` |
| `supabase/staging/scanner-stations/09-cleanup.sql` | `d8e92593ef7f91fd4de75115d93322705d0bd422e58544586431fbd5ebaf8bcd` |

(A Windows checkout may have CRLF; hash `git show HEAD:<path>` to compare.)

## Checks run by the coder after R1 and R2 fixes (2026-11-22)

| Check | Result |
|---|---|
| `npx tsc -b` | pass |
| `npm run typecheck:digest` | pass |
| `npm run typecheck:api` (new: Shopify order endpoint + test) | pass |
| `npm run test -- --run` | 40 files, 957 tests pass (after R2 client fixes) |
| `npm run build` | pass (existing chunk-size warning only) |
| Local PGlite: 0031, 0047, 0052–0055, 0055 again, then `02-assertions.sql` | `F6 verify: ALL CHECKS PASSED (160 cases)` (0055 applied twice first) — local, **not staging evidence** |
| Local PGlite: 01-fixtures → session B R1-B1 → session A → session B from R1-B2 (sequential) → 09-cleanup | SQL valid; sequentially the c6 guard refuses the classic credit insert as expected. One connection cannot block — **not race evidence** |

## Staging evidence (Codex, recorded in docs/reviews/scanner-stations-r2.md)

0055 is **installed on STAGING** at sha256 `3e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620` and is now immutable (later fixes are client-only). Evidence files (Codex root, `overnight-20261122/`): `f6-staging-rollback-schema.json`, `f6-concurrency.json`, `f6-postgrest-roles.json`.

| Step | Result |
|---|---|
| `02-assertions.sql` on actual staging, inside a rollback transaction, before install | **pass** — 160 cases |
| Apply 0055 to staging (hash above), `apply_migration` | **done** — persistent, success |
| Separate-connection races R1 shared/classic, R2 classic/shared, R3 exact retry, R3b original rollback, R4 two scanners, R5 clock-in, plus R6 classic `line_verified` held open without deduction (proves the insert-trigger lock) | **pass** — all final credit and stock totals true |
| Real PostgREST roles: owner/manager/kiosk allowed; staff/CS/anon denied; captured-caller mismatch refused; real kiosk save, exact replay with no extra events; direct receipt write denied | **pass** |
| Existing products/ledger/events full hashes before vs after | **unchanged**; synthetic fixtures cleaned; F1 and F5 tracking OFF |
| Combined Preview, staging env, receiver opt-in: badge → order → green (regular framed) | _pending_ |
| Preview: A0 order with auto rules → green, pick visible on Packaging attention/history | _pending_ |
| Preview: offline order → amber → back online → green; offline 8-digit → red + signed out | _pending_ |
| Preview: unsupported order (cancelled / unframed only) → red, blocked list, Retry/Recorded on classic | _pending_ |
| Preview: reload → identities gone, queue kept; account switch → other account's jobs not sent | _pending_ |
| Preview: manager Welcome shows receiver row; close receiver → red after 3 min | _pending_ |
| Preview: classic station and F4 packaging unchanged (one classic A0 and one dispatch order) | _pending_ |

## Not verified (needs hardware or production)

Real cordless scanners (prefix/suffix programming, radio range, true
simultaneous bursts, keyboard layouts), Wake Lock / audio on the actual
receiver device, OS kiosk auto-start, real packaging rules at a site, and
anything in production. See the commissioning checklist in
`docs/runbooks/scanner-stations.md`.

## Release and rollback

Expand-only. Apply 0055 → deploy Preview → opt a test receiver in. Rollback:
receiver "Classic station" (device setting) or the previous Preview; keep
0055, queues, receipts and history. Part of the bulk release, never per-feature.
