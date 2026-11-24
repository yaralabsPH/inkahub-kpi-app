# Bulk release rehearsal: G3, G4, G5 evidence (2026-11-24)

- Written by the coder for [release-stack-r1.md](../reviews/release-stack-r1.md) Must-fix 3, 4 and 5
  and the gates in [bulk-release-plan.md](bulk-release-plan.md).
- Target: staging project **inka-staging-2** (`yqfrtikujqmwykfyrtbb`, PostgreSQL 17.12, Singapore).
  CJ approved resetting it for this. **Live (`lkboboagiikvozvbcpvg`) was only read** (catalog and
  aggregate counts); nothing was written there.
- Code: release head `feature/staging-fixes` @ `30eb6e5` (PR #22). Scripts: `supabase/staging/release-rehearsal/`.

## 0. What "live" is today

| Item | Finding |
|---|---|
| Live production deployment (rollback target) | `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf` (`inka-arthouse-pkdt9gaoa-…`), uploaded with the Vercel CLI by max-5005, no git metadata |
| Live code | Rebuilt from that deployment's own source files: `src/`, `api/` and `package.json` are **identical to git `79a0031`** (the recovery import) apart from line endings. It also carries two stray files (`TeamMembersCard.tsx.broken-…`, a `.txt`) that are not imported by the app. |
| Not live | Everything merged to `main` after the import, including PR #6 (digest auth) and PR #9 (order display). They go live for the first time with this release. |
| Vercel project | No Git connection: merging to `main` does **not** deploy anything. Production changes only by a CLI deploy or a promote. "Hold auto-promotion" in the plan is therefore automatic; the release-day deploy is an explicit step. |
| Live database | PostgreSQL 17.6, 78 MB, no migration history table, `btree_gist` available (1.7) but not installed, `postgres` has CREATEROLE. `production_events` policies are the five names 0036 expects. No `pkg:%` ledger rows, so the 0047 unique index cannot hit a duplicate. |

## 1. G3: ordered upgrade rehearsal

### 1.1 A copy of live's schema, before 0034

1. `00-reset-to-live-baseline.sql` removed every object 0034–0062 had created on staging-2 (public objects,
   `reporting_private`, `departments_private`, `btree_gist`, roles `reporting_capture` and
   `departments_resolver`) and set the `public` schema owner, ACL and default privileges **exactly as live**
   (owner `postgres`; `anon/authenticated/service_role = UC`; defaults: tables `authenticated=arwd`,
   `service_role=r`; functions `authenticated=X`). Before this, staging had Supabase's wide defaults, which
   would have given the new tables different grants than live will.
2. Live's DDL was generated read-only from live's catalog (`05-generate-live-baseline.sql`) and applied.
3. `10-fingerprint.sql` on both databases: columns 284, constraints 154, indexes 73, functions 19 (bodies,
   security, config, owner), policies 63, triggers 8, table ACLs 28, schema ACL, default ACLs, extensions 5,
   schemas 8, roles 0: **all identical**. Function ACLs contain the same entries; only the order inside the
   list differs (`{=X,postgres=X,authenticated=X}` vs `{postgres=X,=X,authenticated=X}`).

### 1.2 Live-sized, synthetic data

`30/31/32-seed-*.sql` (no live rows copied; shapes from aggregate counts only): 114,011 production events in
live's exact location × department × event type counts and date ranges, 35,132 ledger rows in live's reason mix,
209 products, 54 users (49 synthetic, no password), 77 badges, 3,410 weekly sales, 328 bays, 248 weekly entries,
24 shipments. Staging database 66 MB before the upgrade (live 78 MB); `shared_buffers` 256 MB (live 224 MB).

### 1.3 The upgrade: exact files, in order, one at a time

`run-ordered-upgrade.sh`: each committed file unchanged, with `lock_timeout 10s` and `statement_timeout 600s`
set first, stop on the first error. 0046 (no BEGIN/COMMIT) ran as one atomic implicit transaction.
Role: `postgres` (what the SQL editor and `supabase db query` use). Server-side time per file:

| File | sha256 (first 16) | ms | | File | sha256 (first 16) | ms |
|---|---|---|---|---|---|---|
| 0034 | be6e2f05715b83ce | 5 | | 0047 | e959aae559e8502b | **37** |
| 0035 | 939e87f0c860cc6d | 5 | | 0052 | fb86f6628f27191d | 103 |
| 0036 | 35aba95f1d156000 | 5 | | 0053 | cc7301877a146f7a | 11 |
| 0037 | 531bb2c5706b9ac4 | 60 | | 0054 | 541a7822ae18c917 | **44** |
| 0038 | 002d6e58034aef1c | 69 | | 0055 | 3e5981954ad37c99 | **123** |
| 0039 | 05d7eff179993a6e | 5 | | 0056 | b13cd1d2f7daea4b | 19 |
| 0040 | 4e39243e2ee6526f | 10 | | 0057 | c88dee7ea5d19b5b | 5 |
| 0041 | dfa49d597cc37cef | 6 | | 0058 | 4c11757febc6925c | 8 |
| 0042 | e38aba760a19a70f | 6 | | 0059 | 2d1e135b943bc79f | 23 |
| 0043 | 156ee4d525433c89 | 28 | | 0060 | 29267ab1eec37f10 | 17 |
| 0044 | 84a07d1bd61d2e69 | 20 | | 0061 | 5a3156ab9155cc39 | 4 |
| 0045 | 5f42f300ba391aa3 | 5 | | 0062 | 885c5f4e82c7c381 | 10 |
| 0046 | 4641d7cd4dd3ca48 | 27 | | **all 25** | match the manifest | **~0.66 s** |

**Write blocking.** The three files that build an index on a live table hold their lock for at most the whole
file: 0047 ≤ 37 ms (ledger), 0054 ≤ 44 ms (production_events: 11 columns + index in one transaction),
0055 ≤ 123 ms (ledger). At live's size a station's insert would wait well under a second.

**Disk.** 66 MB before, 71 MB after the upgrade (+5 MB, mostly new indexes and empty tables). WAL directory 192 MB, `max_wal_size` 4 GB.

**Failure and resume.**
- Re-running 0037 on the upgraded database fails at its first statement
  (`42710 role "reporting_capture" already exists`) and **nothing** is kept (even its log row rolled back):
  a transactional file is all-or-nothing, so a failed file can be fixed and re-run from that file.
- 0047 re-runs cleanly (all `IF NOT EXISTS` / `CREATE OR REPLACE`).
- Lock-timeout drill: with another session holding a SHARE lock on `production_events`, an `ALTER TABLE` with
  `lock_timeout = 3s` was cancelled after 3 s (`55P03`) and the column was not added. Use the same setting on
  release day so a stuck lock cancels the file instead of queueing every station's writes behind it.

**Effective permissions after the upgrade.** RLS on every public table (49); `anon` has no privilege on any
public table; no new SECURITY DEFINER function is executable by `anon`; `reporting_private` and
`departments_private` are closed to `anon` and `authenticated` (`service_role` uses `reporting_private` only);
`btree_gist` in `extensions`; `reporting_capture` and `departments_resolver` are NOLOGIN, granted to `postgres`
with INHERIT false / SET false; `service_role` holds only the SELECT/INSERT/UPDATE grants the migrations declare.

### 1.4 New-feature checks on the upgraded schema

The repo's own staging assertion scripts, each one transaction ending in ROLLBACK, all **passed** at live size:
`box-auto-pick/01-verify.sql` (F4), `departments/02-assertions.sql` (F5), `scanner-stations/02-assertions.sql`
(F6, 160 cases), `dispatch-flow/02-assertions.sql` (F7, 175 cases). A sentinel `RAISE` appended after each
script's final ROLLBACK fired every time, proving each script ran to the end.

### 1.5 Old app on the new schema

`50-old-app-smoke.sql` replays the exact database calls of the live build (`79a0031`) as the `authenticated`
role with each test user's JWT claims (RLS, grants and triggers all apply). All 9 checks passed:
lanyard clock-in and line events (staff); dispatch deducting frame stock and a package once, and a re-dispatch
adding nothing (manager); shipment created, Delivered (trigger), credited +10, reversed, deleted, status log
cascade; CS case + line, return + line; manual `adjust_on_hand`; owner settings, badge add/revoke, weekly sales
upsert; staff reading clock events; frame A2 500 → 499 and package 200 → 199, exactly once.
A Preview of the old build on the upgraded database is also up for a click-through:
`https://inka-arthouse-ntaglszob-inka-arthouse-s-projects.vercel.app` (Vercel login or share link needed).

## 2. G4: reporting at live size — **not passed (capacity finding)**

Release build `30eb6e5` as a Preview on staging-2 with throwaway `CRON_SECRET`, `REPORTING_OPERATOR_SECRET` and
`REPORTING_CURSOR_SECRET` (the last one was missing from older notes). Operator steps exactly as the runbook:
`enable-capture` (all sites, epoch 2), `set-mode au processorEnabled`, then `rebuild au` repeatedly. AU at live size
has **15,087 owners** to materialise.

| Phase | Where the function ran | Owners done per 4-minute call | Notes |
|---|---|---|---|
| Copy + first owners | Vercel default region (US East) | 348, then 408 | 98 source pages copied in call 1. Only ~17 s of each 241 s call was database time: the worker is **latency-bound** (about 1,300 sequential RPCs per call). |
| Light owners | **sin1** (same region as the staging DB; preview-only `regions` setting, not committed) | **2,070** | 5× faster than US East: confirms the latency diagnosis. |
| Heavy owners | sin1 | 64, 63, 55 | Each order's input journal carries the events of every staff member on that order (6–15 members, up to **2,960 events**), written in pages through `checkpoint_reporting_owner_input` (0046): 679 calls, mean 408 ms. Live staff carry similar per-person volumes (AU framed: 23 people, ~100k events), so production should behave the same. |

- **Duty cycle:** each call uses its 4-minute budget and the lease runs 6 minutes past the last heartbeat, so a
  site gets ~4 minutes of work every ~6 minutes, whether driven by the operator or the 15-minute crons.
- **Progress when stopped (~45 minutes of work):** about 2,900 of 15,087 AU owners. At the heavy-phase rate the
  first AU publication would need **well over a day** of continuous calls; UK and US come after it.
- **Storage:** database 74.5 MB → **329 MB** at the stop (+255 MB for ~19% of AU): `source_candidate` 119 MB,
  `owner_input_pieces` 71 MB, `owner_input_events` 60 MB; WAL 240 MB. After `abandon` + `cleanup` nothing was
  released (the abandoned batch is kept as evidence until retention), so a failed first build keeps its space.
- **Staging left in release-day state:** batch `f0861b99…` abandoned with a reason, AU processor off, **capture off**
  (epoch 3), every site read mode `legacy`. Nothing published.

**What this means for the release.** Published reports (F8/F9 summaries) cannot be commissioned on live with this
worker as it is. The release plan already ships reporting **dormant** (capture off, processors off, read mode
legacy). Correction after review r2: that is only safe with the r2 fix. Before it, a dormant site with no
publication made the summary API answer `UNAVAILABLE`, so the new Reports/Welcome never selected their legacy reads.
The old-app smoke does not exercise that path (it replays old SQL calls, not the new API). See the r2 fix and
`tests/reporting/pg/dormant-legacy.test.ts`.
Before anyone runs `enable-capture` on live, the planner needs to decide on: (1) the owner-input journal cost for
orders whose members have thousands of events; (2) running the report functions next to the database
(`"regions": ["hnd1"]` for live in Tokyo, ~5× on the light phase); (3) storage headroom and releasing an abandoned
batch's working rows. Do **not** enable capture on live as part of the bulk release.

## 2b. Other defects found during the rehearsal

- **Local (Dexie) mode: Settings crashes.** `PackagingRulesCard` calls `useAuth()`, which throws outside
  `AuthProvider`; Dexie mode has no provider, so `/settings` renders blank ("useAuth must be used inside
  <AuthProvider>"). Production (Supabase) is not affected. Fix: use `useAuthOptional()` there, as Sidebar does.

## 3. G5: rollback drill (new app writes, then the old app)

Site `f7race` from `dispatch-flow/01-fixtures.sql` (auto packaging, one rule set). Scripts
`60-rollback-drill-shared.sql` and `61-rollback-drill-classic-auto.sql`.

| Step | Result |
|---|---|
| New app: shared-scanner dispatch (auto box) | saved; component −2, box −1 |
| New app: same request id again (lost-response retry) | `replayed: true`, nothing added |
| **App rolled back.** Old app re-dispatches that order | **refused by the database** (`already_dispatched_by_shared_scanner`), nothing written, stock unchanged |
| Old app dispatches another order classically, then again | first deducts 2 lines, second skips both (per-order idempotency) |
| **Rolled forward.** New app shared dispatch of the order the old app dispatched | `already_recorded`, nothing added |
| New app: classic station in automatic packaging (event → components → `packaging_apply`), retry same request | box −1 once, retry replayed |
| **App rolled back.** Old app completes that order again, scanning the box | components skipped (idempotent); **the box is charged a second time** — the known edge in `docs/RELEASING.md`. Both rows are visible in the ledger (`pkg:pkp-…:f7r-box` and `prod:order_10978004:F7R-BOX`); fix with one stock adjustment. |

Not drillable in SQL: the browser-side packaging queue. Its behaviour after a rollback is covered by the
`774d69e` tests (requests are kept across sign-out and only drained for the signed-in account and site) and
by the database replay shown above (same request id adds nothing). Operator rule after a rollback: do not clear
browser data on a station with "Packaging not saved yet", and do not re-complete orders that were completed in
automatic mode.
