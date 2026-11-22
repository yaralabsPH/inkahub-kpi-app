# Release record: F6 shared scanner stations

Branch `feature/scanner-stations`. Staging only; production and `main` untouched.
Base: reviewed F5 `25c4c808` (+ review-doc commits up to `119d52a`).
Migrations: adds `0055_scanner_stations.sql` only (`git diff --name-status 25c4c80 HEAD -- supabase/migrations` = `A 0055`).
0048–0051 stay reserved for F3; 0052–0054 (F5, installed on staging) are unchanged.

## SQL to apply / run (sha256 of the committed LF text)

| File | sha256 |
|---|---|
| `supabase/migrations/0055_scanner_stations.sql` | `3f1db293c4419ba06c00a1624144bf94cec2ab0f06e0288e708f2131782ddf37` |
| `supabase/staging/scanner-stations/01-fixtures.sql` | `8d943e39cce7df592beec931128a0e62266390dc93b62ea9d0898d7d55af5c93` |
| `supabase/staging/scanner-stations/02-assertions.sql` | `d7341b9433b7bf4eb60b2d2bb41ad6ca8b7cea1d9590abcea3a8727bd3dce188` |
| `supabase/staging/scanner-stations/05-session-a.sql` | `4ef51a67464d83490cf295dc1a3cb63396d31382f4a33039e1db3be297266007` |
| `supabase/staging/scanner-stations/05-session-b.sql` | `0ad42f9ff17d607ad03ca4db258831f0f8a797eafaf58c58751e14f38cf6545b` |
| `supabase/staging/scanner-stations/09-cleanup.sql` | `d8e92593ef7f91fd4de75115d93322705d0bd422e58544586431fbd5ebaf8bcd` |

(A Windows checkout may have CRLF; hash `git show HEAD:<path>` to compare.)

## Checks run by the coder (2026-11-22)

| Check | Result |
|---|---|
| `npx tsc -b` | pass |
| `npm run typecheck:digest` | pass |
| `npm run typecheck:api` (new: Shopify order endpoint + test) | pass |
| `npm run test -- --run` | 40 files, 940 tests pass |
| `npm run build` | pass (existing chunk-size warning only) |
| Local PGlite: 0031, 0047, 0052–0055, 0055 again, then `02-assertions.sql` | `F6 verify: ALL CHECKS PASSED (134 cases)` — local, **not staging evidence** |
| Local PGlite: 01-fixtures → 05-session-a (sequential) → 09-cleanup; 01 → 05-session-b to R3 → 09 | no SQL errors; no blocking possible on one connection — **not race evidence** |

## Staging evidence (Codex)

| Step | Result |
|---|---|
| Apply 0055 to staging (hash above) | _pending_ |
| `02-assertions.sql` | _pending_ |
| `01` → `05-session-a/b` R1–R5 → A-END all `true` → `09` | _pending_ |
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
