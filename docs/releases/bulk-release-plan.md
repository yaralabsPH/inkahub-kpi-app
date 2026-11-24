# Bulk release plan: F1 and F4-F11 (draft for CJ and the planner)

- Status: **DRAFT, not approved.** Written by the coder from the planner's release review
  ([release-stack-r1.md](../reviews/release-stack-r1.md), verdict "changes required") and the
  per-feature release notes in this folder. Every step marked **CJ** is a human step: agents never
  merge to `main`, deploy to production or apply SQL.
- Built from branch `feature/staging-fixes` at `206ea68` (PR #22, top of the stack).
- Goal: put everything built so far on the live app in one planned release, with every risky
  feature **switched off at first** and a short, tested way back.

## What is in and out

| In (merge in this order) | Out |
|---|---|
| #7 item-counting, #10 station-screen-redesign, #13 box-auto-pick, #11 departments, #14 scanner-stations, #15 dispatch-flow, #16 item-counting-integration, #17 reports-v2, #18 frame-timing, #19 order-timeline, #20 make-milestones, #21 order-timeline-commissioning, #22 staging-fixes | #12 artwork thumbnails (F3, not part of this stack; migrations 0048-0051 stay reserved for it) |
| | #8 team page redesign and add-member (separate release; needs its own edge functions) |
| | the new UI redesign (wireframes; no spec yet) |

This order is one safe topological order, not numeric order: #7 and the #10 to #15 chain are
independent until #16. After each parent lands, retarget its child to `main` and check the diff and CI.
Use merge commits (no squash or rebase of stacked children). **Hold automatic Production promotion**
while merging, so no half-finished combination reaches staff; promote one final build.

## Gates that must be closed BEFORE release day

| # | Gate | Who | State |
|---|---|---|---|
| G1 | Packaging retry bugs (review Must-fix 1 and 2) | coder | **fixed** (commit 774d69e), re-review pending |
| G2 | The three 15-minute refresh schedules back in `vercel.json` | coder | **done** (commit 206ea68) |
| G3 | **Ordered upgrade rehearsal**: apply the exact files below, in order, to a staging copy that has the same schema as live and realistic (sanitised) data volume. Record lock time per file, disk headroom and any failure. Use a bounded lock/statement timeout and stop on the first error. Then smoke-test the OLD app against the new schema | CJ and coder | **done 2026-11-24** ([evidence](release-rehearsal-2026-11-24.md) §1): fingerprint-identical copy of live, live-sized data, all 25 files passed, longest write block 123 ms, old app 9/9 |
| G4 | Reporting proof at real size: one full first publication and one incremental refresh on representative data, with measured disk and time. Never repeat "raise the timeout and hope" | CJ and coder | see [evidence](release-rehearsal-2026-11-24.md) §2 |
| G5 | Rollback drill on staging: write with the new app, switch back to the previous build, run the smoke test, check stock and queues | CJ | **done 2026-11-24** ([evidence](release-rehearsal-2026-11-24.md) §3): only the documented second-box edge, visible in the ledger |
| G6 | Planner re-review (round 2) says "approved" | planner | **open** |
| G7 | Staging smoke test as owner, manager, staff, kiosk and CS (docs/RELEASING.md section 2) on the final build | CJ | **open** |

## Production settings to check in Vercel (CJ)

Set these in the **Production** environment. Never put a secret in a `VITE_` variable.
Preview keeps pointing at staging with its own throwaway secrets.

| Variable | Needed for |
|---|---|
| `VITE_BACKEND=supabase`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | the browser app (the live project only) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | server functions. `SUPABASE_URL` and `VITE_SUPABASE_URL` must be the SAME project |
| `CRON_SECRET` | daily digest and the 15-minute refresh (random, not blank) |
| `REPORTING_OPERATOR_SECRET` | reporting commissioning. **Must differ from `CRON_SECRET`** |
| `REPORTING_CURSOR_SECRET` | signs report pages and CSV. **Missing from older notes.** Without it reports answer 500 |
| `REPORT_RECIPIENT`, `RESEND_API_KEY`, `FROM_EMAIL` | the daily digest (set `FROM_EMAIL` explicitly) |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | order lookup and owner timeline refresh |
| `DROPBOX_ACCESS_TOKEN`, `DROPBOX_IMAGE_FOLDER` | artwork lookup (already used) |
| Leave UNSET for now: `ORDER_TIMELINE_INGEST`, `ORDER_TIMELINE_ROUTING`, `SHOPIFY_WEBHOOK_SECRET`, `MAKE_MILESTONE_SCOPES` | order timeline and Make features stay dormant until commissioned |

## Release-day sequence (CJ, in a quiet window, not at a shift start or digest time)

1. Write down the **current production deployment**. As of 2026-11-24 it is
   `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf` (`inka-arthouse-pkdt9gaoa-…`), whose code equals git `79a0031`
   (checked file by file). That is the rollback target. The Vercel project has **no Git connection**:
   merging does not deploy, so nothing reaches staff until step 6.
2. Take a Supabase backup and note the recovery point. Check free disk space.
3. Check the Production settings table above.
4. Apply the migrations below **in numeric order, one file at a time, stopping at the first error**.
   Start each file with `set lock_timeout = '10s'; set statement_timeout = '600s';` (as rehearsed).
   0046 has no BEGIN/COMMIT: run it as one atomic unit (one SQL editor run). Do not run 0001-0033 and do not use the
   consolidated staging baseline. If a file fails, earlier files stay; leave the old app live and diagnose.
   Rehearsed on a fingerprint-identical copy of live: all 25 files ≈ 0.7 s in total, longest write block 123 ms (0055).
5. Merge the 13 pull requests in the order above. Wait for CI on the final `main`.
   Note: `main` already holds PR #6 (digest auth) and PR #9 (order display), which were never deployed;
   they go live in this release too. PR #6 needs `CRON_SECRET` set in Production first.
6. Deploy the final `main` to Production (one CLI deploy, or deploy as Preview and promote it).
   Check the function durations (300 s) and the six cron entries.
7. Smoke test on production (read-only where possible): log in as each role, kiosk clock in and out
   (**one** clock-in per scan), complete and dispatch one real order and check stock moved **once**, Shopify lookup,
   shipments, CS cases and returns, Welcome and Reports, the daily digest endpoint.
8. Watch Vercel logs for 30 minutes. Tell staff a release went out. Tag it: `git tag v<yyyy.mm.dd>`.

## Everything starts OFF (what staff see on day one)

| Feature | Starting state | Switch-on (later, one site at a time) |
|---|---|---|
| Box auto-pick (F4) | every site in **scan mode** | Settings: box rules, then switch the site to automatic |
| Departments (F5) | tracking **off** | owner enters the real roster, then turns on "Save the department on new work" |
| Shared scanners (F6/F7) | not turned on at any station | Station settings, after the real scanner prefix/suffix test |
| Published reports (F8/F9) | read mode **legacy**, capture **off** | commission with the operator endpoint: enable capture once, rebuild each site until published, check against the old numbers, then set read mode to summary |
| Order timeline (F10), Make (F11) | env unset, dormant | own commissioning |

Visible on day one even with switches off: the new station screen (#10), one count rule for
Items and Orders everywhere (#7; **older days are recalculated and unframed work now counts, so past totals look higher**),
the clock-in fix, the missing-stock warning, the Order box focus, the garbled-text repairs.

## SQL manifest (sha256 of the committed LF text; a Windows checkout may show CRLF, hash `git show HEAD:<path>`)

Numbers 0048-0051 are reserved for F3 and 0027 is a known gap. Do not create placeholders.

| File | sha256 |
|---|---|
| 0034_load_production_evidence | be6e2f05715b83ced3f64db744ec6bc1baf305d451bef9697aeaea6b9a6f37af |
| 0035_load_production_evidence_v2 | 939e87f0c860cc6dc3db3589ac605a9d4c0a952569f69eaf672d910b27eedc98 |
| 0036_production_events_select_initplans | 35aba95f1d156000457e81a68e2fefa4523ded454236a5e72ca382ee4c6e0792 |
| 0037_reporting_storage | 531bb2c5706b9ac4d73a7ca3dc74dead7e34a53160e57fe2971aaf061c6a6a4f |
| 0038_reporting_jobs | 002d6e58034aef1c83f94863bb89ce83dadeb225106cd804d2a46798193dd68f |
| 0039_reporting_rebuild_insert | 05d7eff179993a6eeeba3fadaddd345b83bd20c68676cb6bda709937984c3bd5 |
| 0040_reporting_dependency_reads | 4e39243e2ee6526f656eb1b462156d6bc9eabf17cac78fcb2d873cd4498968b2 |
| 0041_reporting_dependency_read_bounds | dfa49d597cc37cef92314a4d2dcaf79d195949741fc0534fc57345c12f419646 |
| 0042_reporting_access_paths | e38aba760a19a70fa3afdddd5155244fb94acb73a53362855d1f63b1a3536a1c |
| 0043_reporting_worker_state | 156ee4d525433c8999c52d83ac4175c44629ce6a8f848796a5638ed944c7f633 |
| 0044_reporting_reads | 84a07d1bd61d2e69df66bf6efa437f541a184512cb1820cc75217db20e5c9b07 |
| 0045_reporting_predecessor_page | 5f42f300ba391aa36845329e53d39581a56d4e60c94ab342bb95f91fe8ccefb8 |
| 0046_reporting_owner_inputs | 4641d7cd4dd3ca48d0ccf5350584bb6c23efec6bac4c5a4e6c26d60b7b0b6141 |
| 0047_packaging_auto_pick | e959aae559e8502b03a07bf7799335e5e920feb478d10b3aa1f75dbe475b8de3 |
| 0052_departments | fb86f6628f27191dce303a88d212a4f2b7a721e386a2346c5a2655d586c16b02 |
| 0053_departments_admin | cc7301877a146f7a62dad8cd93b066f88799a239275f73d254f91a5f754e89c3 |
| 0054_departments_snapshots | 541a7822ae18c9177bca3187a44fde256dcc1037a61c831b40d69d28a5b4a116 |
| 0055_scanner_stations | 3e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620 |
| 0056_dispatch_flow | b13cd1d2f7daea4b2d8b4b73e34b4571329beba85e45f6b97d062ab12d07fa2e |
| 0057_reports_overview | c88dee7ea5d19b5b399fd2847bed4bd9625bf0140a3f989979a2ba8f3022dde3 |
| 0058_frame_timing | 4c11757febc6925cd10afa8db44d8a795af8145406c25e1beffb4045006ed135 |
| 0059_order_timeline | 2d1e135b943bc79fff41e19bda5176b0914b6bd767da0cb28dfbc6623f26edaa |
| 0060_make_milestones | 29267ab1eec37f10b356904981fd5844030548baacd593eb9802d65043040944 |
| 0061_order_timeline_scanner_proof | 5a3156ab9155cc39fb65a8c4e97b4f487031bb383b3169a1e2ea2cb6a7b29d35 |
| 0062_order_timeline_shopify_proof | 885c5f4e82c7c381acd4f49286389723036b8c73611afdd472a3ffa3819b0c52 |

Known lock risks to measure in G3: 0054 (adds eleven nullable columns and builds an index on the
live events table in one transaction), 0047 (unique index on the ledger), 0055 (index on the ledger).
Ordinary index builds block writes while they run.

**Size of the live database (read-only check, 2026-11-24, by the coder through the Supabase connector).**
PostgreSQL 17.6 (the "16 or newer" prerequisite is met). Whole database 78 MB.
`production_events` about 112,500 rows (49 MB), `ledger` about 34,000 rows (13 MB), `products` 209, `profiles` 46.
At this size each index build should take about a second or less, so the write block in 0047, 0054 and 0055
should be brief. That is an estimate, not a measurement: G3 still has to record the real time per file on a copy
of this size. The old disk-full incident happened on a tiny free staging project, not on live; the live disk
allowance and the growth of the new reporting tables are still to be checked in G4.

## If it goes wrong: the way back (CJ)

1. **Switches first.** Packaging back to "Scan the box", F5 tracking off, shared scanners back to classic,
   every reporting site to read mode legacy with the processor off. Do not clear browser data on a scanner
   device while anything is queued, and never rescan an order whose first save is unknown.
2. **Instant Rollback** in Vercel to the deployment written down in step 1. This restores that build's code,
   settings and cron entries. It does **not** change Supabase.
3. **Leave the migrations and all records in place.** The old app ignores the new tables and columns.
   Known exception: re-completing an auto-packaged order on the old build can take a second box from stock.
   Do not re-complete such orders; correct any overlap with an audited stock adjustment.
4. **Fix forward in git** with a reviewed rollback pull request (revert the application files, keep the
   migration files), so `main` matches what is live.
5. A database restore is the last resort and loses real orders recorded since the backup.

## After release (not part of release day)

Commission one feature at a time, each with its own acceptance: roster then F5; real box rules then F4
automatic; real scanner programming and an interleaving test then F6/F7; reporting capture then publication
then summary reads, with a named person watching disk and the first scheduled runs; order timeline and Make last.
