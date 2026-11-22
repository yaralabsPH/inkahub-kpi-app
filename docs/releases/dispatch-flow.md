# Release record: F7 dispatch flow

Branch `feature/dispatch-flow`. Staging only; production and `main` untouched.
Base: reviewed F6 `0c47ace` (plan commit `ab37988`).
Migrations: adds `0056_dispatch_flow.sql` only (`git diff --name-status ab37988 HEAD -- supabase/migrations` = `A 0056`).
0048–0051 stay reserved for F3; 0052–0055 (installed on staging) are unchanged
(0055 still `3e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620`).

## SQL to apply / run (sha256 of the committed LF text)

| File | sha256 |
|---|---|
| `supabase/migrations/0056_dispatch_flow.sql` | `f25fd410fd8722861969b0e808d87e0dffa3ddc9b2c0234ab66744be17d3f07d` |
| `supabase/staging/dispatch-flow/01-fixtures.sql` | `f5634e9a3e620acd5c66e620c9252f7fcd5e68b8024954f23a6a7f84c18afd9f` |
| `supabase/staging/dispatch-flow/02-assertions.sql` | `4525f4dabfe84a8bb396173fbfce9316e10edf4a5df7915efae0ad9992807266` |
| `supabase/staging/dispatch-flow/05-session-a.sql` | `9302d3e1a851c3a327d9dd35b5b263e3b4e870fd0f0b3da5f9b023c7673344ce` |
| `supabase/staging/dispatch-flow/05-session-b.sql` | `617c7260173789d0309971b8639f6070d74ea8474740b5762329d5003e450d65` |
| `supabase/staging/dispatch-flow/09-cleanup.sql` | `b4d110b2502db981503ec81ce9315101e952d2cbf3e11e2104f5372655eeac27` |

(A Windows checkout may have CRLF; hash `git show HEAD:<path>` to compare.)

## Contracts (for the reviewer)

- RPCs (authenticated; owner/manager/kiosk at the site; captured caller checked before replay or any write):
  `scanner_activate_dispatch(loc, request, receiver, scanner, badge, expected_caller)`,
  `scanner_dispatch_evidence(loc, order, lines, expected_caller)`, `scanner_dispatch_people(loc)`,
  `scanner_commit_dispatch(loc, request, receiver, scanner, staff, badge, order, scanned_at, items, lines, components, packaging, choices, expected_caller)`.
- Receipts: `dispatch_requests` (kind activate|dispatch; unique saved dispatch per site/order); a request id held by
  either receipt table is refused by the other's RPCs. F6 `scanner_requests`, its index and the c6 guard are untouched.
- Attribution: `dispatch_framer_attributions`, one row per (site, dispatch event, SKU); `scan` rows name the verifying and
  completing events, `manual` rows none; immutable; owner/manager select only; no client writes.
- Event ids: dispatched `dsp-<request>-d`, dispatch clock-in `dsp-<request>-ci`; attribution `dfa-<request>-NN`;
  F4 apply request `dsp:<request>`.
- Client queue: dispatch jobs have `mode: "dispatch"` and scope `<F6 scope key>|dispatch`; F6 rows (no mode) keep their
  exact key and payload and are read as framing. Unknown-outcome payloads are frozen; a framer choice changes only a
  blocked dispatch job with nothing possibly saved.

## Checks run by the coder (2026-11-23)

| Check | Result |
|---|---|
| `npx tsc -b` | pass |
| `npm run typecheck:digest` | pass |
| `npm run typecheck:api` | pass |
| `npm run test -- --run` | 46 files, 1013 tests pass (final code; tsc re-run too) |
| `npm run build` | pass |
| Local PGlite: 0031, 0047, 0052–0055, 0056 twice, then F7 `02-assertions.sql` | `F7 verify: ALL CHECKS PASSED (136 cases)` — local, **not staging evidence** |
| Local PGlite: F6 `02-assertions.sql` with 0056 applied | 160 cases pass — local |
| Local PGlite: 01-fixtures → R1–R6 steps in documented order (sequential) → totals; 09-cleanup | every step gave its expected answer, totals all `true`, cleanup leaves nothing. One connection cannot block — **not race evidence** |
| Mutation: same-person rule removed from the evidence reader | case C03 fails as expected |

## Staging (Codex)

| Step | Result |
|---|---|
| F7 `02-assertions.sql` on staging inside its rollback, before install | _pending_ |
| Apply 0056 (hash above) | _pending_ |
| F6 `02-assertions.sql` re-run after 0056 | _pending_ |
| Two-connection races R1–R6 (`05-session-a/b`), totals all true, cleanup | _pending_ |
| Real PostgREST roles: kiosk/owner/manager allowed; staff/CS/anon denied; caller mismatch; direct attribution/receipt writes denied; kiosk cannot select attributions | _pending_ |
| Preview: dispatch badge → order with measured framing → green with "Framed by ✓" | _pending_ |
| Preview: missing framing → chooser → manual save → Reports order lookup shows Manual; CSV `framed_by`/`framer_evidence` | _pending_ |
| Preview: blocked (picture frame / open case) → red classic reason; uncertain retry → exact replay | _pending_ |
| Preview: old F6 queued framing job still saves; F6 framing mode unchanged; classic dispatch unchanged | _pending_ |
| Final bundle uses staging; production deployment unchanged | _pending_ |

## Not verified (needs hardware, real rules or production)

Real scanners at a dispatch desk, real dispatch box rules, real staff
badges/names in the chooser, and anything in production. See
`docs/runbooks/dispatch-flow.md` → Commissioning.

## Release and rollback

Expand-only: 0056 adds two tables, one index set and functions; the previous
app keeps working on it. Roll back by switching receivers to Framing mode,
turning shared scanners off, or returning to the previous Preview. Receipts
and attribution rows are kept. No external messages, Shopify writes,
credentials, new dependencies or scheduled jobs.
