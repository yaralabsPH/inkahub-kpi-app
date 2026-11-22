# Release record: F7 dispatch flow

Branch `feature/dispatch-flow`. Staging only; production and `main` untouched.
Base: reviewed F6 `0c47ace` (plan commit `ab37988`). Review R1 fixes: `cdb0af2`, `98d84a5`.
Migrations: adds `0056_dispatch_flow.sql` only (`git diff --name-status ab37988 HEAD -- supabase/migrations` = `A 0056`).
0048–0051 stay reserved for F3; 0052–0055 (installed on staging) are byte-identical to `0c47ace`
(0055 still `3e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620`). 0056 is NOT installed anywhere.

## SQL to apply / run (sha256 of the committed LF text)

| File | sha256 |
|---|---|
| `supabase/migrations/0056_dispatch_flow.sql` | `583814909dd5ae1afecbcb094d37e5f2fee5139896b79ec121f562830da867c9` |
| `supabase/staging/dispatch-flow/01-fixtures.sql` | `521f34fe5447ac1c27920aef025da617df41bc28463da9292ba23ae07cf5d19a` |
| `supabase/staging/dispatch-flow/02-assertions.sql` | `f1170bf145b7f5d711a9849ee4239d6ed85943a2ac1b08f0219ba470900ffc94` |
| `supabase/staging/dispatch-flow/05-session-a.sql` | `e5be20d9837470c43ebd8afe5e2abf0466c84128d5eed10642cc0fc3c4944c20` |
| `supabase/staging/dispatch-flow/05-session-b.sql` | `5cb21f90cac396056bd9f2773a11a07768d7055fef0feb27e450c3c4e32d36d6` |
| `supabase/staging/dispatch-flow/09-cleanup.sql` | `b4d110b2502db981503ec81ce9315101e952d2cbf3e11e2104f5372655eeac27` |

(A Windows checkout may have CRLF; hash `git show HEAD:<path>` to compare.)

## Contracts

- RPCs (authenticated; owner/manager/kiosk at the site; captured caller checked before replay or any write):
  `scanner_activate_dispatch(loc, request, receiver, scanner, badge, expected_caller)`,
  `scanner_dispatch_evidence(loc, order, lines, expected_caller)`, `scanner_dispatch_people(loc)`,
  `scanner_commit_dispatch(loc, request, receiver, scanner, staff, badge, order, scanned_at, items, lines, components, packaging, choices, expected_caller)`.
- Evidence (one SQL reader, preview and commit): only the CURRENT framing attempt counts. Uncancelled `line_verified`
  of the SKU/work type (not CS, enough quantity) + the FIRST `completed` at or after it by the same person for the
  whole order or that SKU; ended by any parentless whole-order/same-SKU `cancelled` of that work type at or after the
  verification, or a `started` of that work type (whole order/SKU) after the completion. Equal-timestamp F6 pairs work.
  Several framers = conflict. Doubt = missing (manual choice). >1000 events = `evidence_overflow`.
- Commit: regular framed lines (`work_type = 'framed'`) require a packaging object (`packaging_required` for SQL or
  JSON null); A0-only / no-framed orders may omit it.
- Classic insert guard `production_events_c7_dispatch_guard` (BEFORE INSERT, runs after F6 c6, before F5): a
  `dispatched` row without `cs_case_id` takes the per-order lock and is refused
  (`already_dispatched_by_shared_scanner`) when a saved shared dispatch receipt exists; CS replacement dispatches and
  orders never shared-dispatched behave as before; the shared commit's own row passes (receipt written after).
  `started`/`cancelled` rows at Framed/A0 Framed take the same lock only, so they serialize with a dispatch's
  evidence read (F6 c6 already locks `line_verified`/`completed`).
- Receipts: `dispatch_requests` (kind activate|dispatch; unique saved dispatch per site/order); a request id held by
  either receipt table is refused by the other's RPCs. F6 `scanner_requests`, its index and the c6 guard are untouched.
- Attribution: `dispatch_framer_attributions`, one row per (site, dispatch event, SKU); `scan` rows name the verifying and
  completing events, `manual` rows none; immutable; owner/manager select only; no client writes.
- Event ids: dispatched `dsp-<request>-d`, dispatch clock-in `dsp-<request>-ci`; attribution `dfa-<request>-NN`;
  F4 apply request `dsp:<request>`.
- Client queue: dispatch jobs have `mode: "dispatch"` and scope `<F6 scope key>|dispatch`; F6 rows (no mode) keep their
  exact key and payload and are read as framing. Unknown-outcome payloads are frozen; a framer choice changes only a
  blocked dispatch job with nothing possibly saved (never sent, or every send definitely refused — `40b3e75`).
- Reports CSV: attribution read per 200 exported shared-dispatch event ids, each batch paged by `range` in
  (dispatch_event_id, sku) order, 1000 rows a page, until a short page.

## Checks run by the coder (2026-11-22 UTC, after review R1 fixes)

| Check | Result |
|---|---|
| `npx tsc -b` | pass |
| `npm run typecheck:digest` | pass |
| `npm run typecheck:api` | pass |
| `npm run test -- --run` | 46 files, 1016 tests pass |
| `npm run build` | pass |
| Local PGlite: 0031, 0047, 0052–0055, 0056 twice, then F7 `02-assertions.sql` | `F7 verify: ALL CHECKS PASSED (167 cases)` — local, **not staging evidence** |
| Local PGlite: F6 `02-assertions.sql` with 0056 applied | 160 cases pass — local |
| Local PGlite: each R1 fix removed in turn / previous 0056 | fails C16b (previous 0056), C19a, D15a, G01, G06 respectively — the cases bite |
| Local PGlite: 01-fixtures → R1–R8 in documented order (sequential; waiting steps placed where they return) → totals | every step gave its expected answer; 16/16 totals `true`. One connection cannot block — **not concurrency evidence** |

## Staging (Codex / root)

| Step | Result |
|---|---|
| F7 `02-assertions.sql` on staging inside its rollback, before install | _pending_ |
| Apply 0056 (hash above) | _pending_ |
| F6 `02-assertions.sql` re-run after 0056 | _pending_ |
| Two-connection races R1–R8 (`05-session-a/b`), totals all true, cleanup | _pending_ |
| Real PostgREST roles: kiosk/owner/manager allowed; staff/CS/anon denied; caller mismatch; direct attribution/receipt writes denied; kiosk cannot select attributions; classic kiosk `dispatched` insert refused after a shared dispatch | _pending_ |
| Preview: dispatch badge → order with measured framing → green with "Framed by ✓" | _pending_ |
| Preview: missing framing → chooser → manual save → Reports order lookup shows Manual; CSV `framed_by`/`framer_evidence` | _pending_ |
| Preview: blocked (picture frame / open case) → red classic reason; uncertain retry → exact replay | _pending_ |
| Preview: old F6 queued framing job still saves; F6 framing mode unchanged; classic dispatch unchanged for orders not shared-dispatched | _pending_ |
| Final bundle uses staging; production deployment unchanged | _pending_ |

## Not verified (needs hardware, real rules or production)

Real scanners at a dispatch desk, real dispatch box rules, real staff
badges/names in the chooser, and anything in production. See
`docs/runbooks/dispatch-flow.md` → Commissioning.

## Release and rollback

Expand-only: 0056 adds two tables, indexes, functions and one BEFORE INSERT
trigger; nothing of 0001–0055 changes. The previous app keeps working on it;
the only behaviour it sees change is that a classic `dispatched` insert for
an order the shared scanners already dispatched is refused (by design: no
second dispatch credit), and framing started/cancelled inserts briefly wait
for the per-order lock while a save of that order runs. Roll back by
switching receivers to Framing mode, turning shared scanners off, or
returning to the previous Preview. Receipts and attribution rows are kept.
No external messages, Shopify writes, credentials, new dependencies or
scheduled jobs.
