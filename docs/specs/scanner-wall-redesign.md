# Spec: Shared scanner wall redesign

- Slug: `scanner-wall-redesign` · Roadmap ID: `F6` (preserve `F7`)
- Status: Approved by CJ, 2026-11-25 (design approved in chat; mockups listed above)
- Author: planner (GPT-6 Astra)
- Approval: CJ said, “i approve the plan and also the UI redesign. go ahead and implement”. This records the approved design, with implementation choices below; it does not request another design approval.
- Dependency: implement [scanner-stations-tuning](scanner-stations-tuning.md) and its [plan](../plans/scanner-stations-tuning.md) first, on the same `feature/scanner-stations-tuning` branch. Do not restore the old ten-minute/clear-identities behavior found in the pre-tuning wall.

## Problem

Workers watching the shared receiving tablet need immediate, legible confirmation, honest progress while a save is pending, and motivating daily output for the person using each scanner. The current wall has small identity cards and one global result; it has no per-person daily totals or per-scanner order progress. The architecture document describes an older baseline; current executable F1 counting, F6 scanner and F7 Dispatch code governs this plan.

### Approved visual references

Four static 1280 × 800 landscape tablet artboards, read for this specification. Base directory:

`C:/Users/cjgom/AppData/Local/Temp/claude/630a29fd966bcdb1/24e2c122-fb1d-43b4-87b8-f14567e2f99c/scratchpad/kiosk-design/project/`

| File | Approved composition |
| --- | --- |
| `Main.dc.html` | Three scanner panels; name; orders/pieces; Leading today badge and share bar; last order; idle bar; team totals; large green SAVED banner. |
| `Saving.dc.html` | Scanner-local received/checking/saving stages, other workers still visible, full-width progress banner. |
| `Problem.dc.html` | Amber full-width garbled-scan recovery; workers remain visible and signed in. |
| `SignOut.dc.html` | Sign-out progress, goodbye with today's totals, free scanner invitation. |

These are visual references, not executable application templates. Do not import `support.js` or mock numbers. The approved tuning specification takes precedence over illustrative copy: no “1 hook (ignored)” message; recovery says nothing was saved **from that scan**, not that no other work saved; actual sign-out state overrides a static “nobody signed out” heading.

## Goals

- Scan-only normal Framing: workers watch, scan badges and packing slips, and never confirm saves by touching the screen.
- Render every tuning state: persistent recovery, Sign out 1/3 and 2/3, signed out/free, and a fifteen-minute countdown.
- Display accurate, read-only daily person totals and friendly comparisons without changing credit, stock, timesheets or retry behavior.
- Match the app's dark `--hub-*` tokens and green accent with large Atkinson Hyperlegible typography.

## Non-goals

- Classic station redesign, new scanner protocol, new credit/counting rules, F9 frame timing, payroll or productivity scoring.
- Changing Dispatch's shift sign-in, manual framer picker, event attribution or inventory behavior.
- New tables, new write RPCs, reporting materialization, per-receiver historical analytics, automatic clock-out or npm dependencies.

## User stories / flows

### 1. Working wall and daily numbers

After the existing operator Start station gesture enables sound/wake, show site, receiver, mode, site-local clock and health; one to three configured scanner panels (three equal columns at 1280 × 800); team figures; the result banner. Keep the current operator actions reachable: Start, Sign out all/Switch worker, mode switch, Classic station, Retry and definite-only Recorded on classic. No new worker touch action. Startup/focus recovery and exceptional Dispatch choice still need their existing operator interaction.

An occupied Framing panel shows scanner ID, verified worker name, large Orders and Pieces today, ranking/share, last saved order and idle countdown. Preserve the identity/name during an own-badge repeat check. An initial unverified badge shows “Checking badge…” without implying sign-in succeeded.

**Planner choice — scope of “today”:** a person's saved normal Framing output at this site for the current production day, across Classic and all receivers/scanners, restricted to work types `framed` and `a0_framed`. Numbers follow `personId`, never scanner ID, display name, browser account or current home department. Switching scanners must not reset a person's day. Label the summary **“TODAY · PEOPLE ON THIS WALL”**, with “Saved framing at this site · day starts 04:00”. This clarifies the mockup's “TODAY ON THIS WALL”; it is not a claim of receiver-only history.

- Reuse `prepareProductionEvidence` and `summarizeProduction` in `src/lib/domain/productionCounts.ts`. Pieces = `normal.items` (the existing shared SKU/set rule); orders = `normal.orders`, distinct order keys across both framing work types. Never sum completed-row quantities or count receipt rows. One mixed A0/regular order is one order, with all eligible pieces. CS/rework is excluded from the headline competition; show a separate “CS/rework excluded” note when present.
- The team is the set of distinct currently verified active people, not three summed tiles. Use a summary scoped to that set: union order keys for orders, shared-rule pieces for pieces. One person bound twice appears twice but contributes once to team/competition.
- Compare each distinct active person's orders. All tied positive leaders get “Leading today” and “Joint lead”; no leader at all-zero output. Others get competition rank (1, 1, 3). Share = person's orders / sum of distinct active people's order counts, zero when denominator is zero. Label it “Share of active people's order credits”; this denominator can differ from the team's distinct orders when more than one person worked an order. Do not change attribution to force additivity.
- Empty slots have no worker totals. On successful rebind clear old person's panel feedback; use fresh identity-scoped counts. A goodbye card may retain the departed person's last known totals, labelled with their name and freshness, for five seconds or until the next scan on that slot, whichever comes first; then “Scan your badge to start”. This is presentation time only, not a session/gesture timeout.
- A change to the scanner-to-person binding map marks all active people's totals pending until a read started for that binding generation succeeds. Show em dashes/“Updating today's totals” for pending people, and withhold team figures, ranks, leaders and share bars until every active person is ready. An absent person in a complete, fresh snapshot means zero; a person awaiting that snapshot does not. Own-badge repeats with the same binding map do not restart this gate. Generation fencing, not timestamp equality, handles changes in the same millisecond.
- Last order is **“Last saved here”**, derived from saved results/retained done jobs for this receiver, scanner, person and mode. Do not call a queued or refused scan saved, show a previous person's order under the new person, or fetch all historical orders to fill this line. After reload it may be absent because the outbox retains only 50 finished jobs; use “No recent saved order on this scanner”. Use server-confirmed piece totals; size wording is shown only if supported by the stored payload, otherwise “N pieces”.

### 2. Receive, check and save

Stages describe actual work, never an animation timer pretending to perform it:

| Stage | Evidence and display |
| --- | --- |
| Receiving | Scan accepted for enqueue; “Receiving scan…” until durable storage succeeds. |
| Received/queued | Durable outbox enqueue succeeded. “Scan received”; offline/backoff says queued on device, not yet saved. |
| Checking | The claimed job is actually preparing/looking up and validating the order. “Checking order…” |
| Saving | Immutable payload persisted and the commit attempt is about to run. “Saving to <captured person>…” |
| Saved | Existing successful server result, including an idempotent saved replay; green SAVED, scanner, captured person, order and confirmed pieces. |
| Other outcome | Preserve ALREADY RECORDED/no extra credit, definite NOT SAVED, waiting for framer choice, and uncertain outcome with “Do NOT record it on the classic station”. |

The three-step graphic is discrete progress (received/checking/saving), not a percentage/time estimate. Retries of prepared jobs may skip checking. Waiting/auth/storage errors stop or replace the progress animation. Show pending job count when a slot has more than one order; display its oldest outstanding job, without hiding blocked/uncertain jobs in the existing queue section. Jobs retain captured person/site/mode/time across sign-out, rebind and mode changes. If an old worker's job saves after rebind, the global banner identifies the old worker; the new worker's card must not adopt it as their last order or count.

Maintain scanner-local progress separately from the global latest result. Delivery of S1 must not wipe S2's progress/gesture or persistent receiver recovery. Progress is optional transient observation of existing delivery, never permission to send, retry, credit or mutate the outbox. Scope and request IDs fence stale callbacks; bounded state is pruned when jobs finish/disappear and on controller disposal.

The active controller may deliver retained jobs of either captured mode. Validate each job against its own stored mode/scope, not equality with the currently displayed wall mode. Global results and the queue retain those older-mode jobs; current-mode panels select only matching-mode work. A disposed controller may not publish anything.

### 3. Recovery and sign-out

Render the tuning recovery state in an amber full-width alert with its exact approved instruction and unknown-scanner addition. It stays visible until the tuning controller accepts a subsequent good scan; old replies, receipt delivery, totals refresh and timers cannot clear it. Show ordinary save results in a subordinate region while recovery is active, not over it. Retain all auth/storage/offline/capture warnings independently.

Render Framing gesture state directly from the tuning session/controller: “Sign out 1/3” and “Sign out 2/3”, lift/wait-one-second guidance, remaining ten-second gesture window, suppression feedback and “S2 signed out”. The third extra qualifying scan causes the local unbind only; show “<name> is still clocked in” with today's totals if available. Do not implement another gesture in React or add clock-out requests. Clear goodbye on new slot input even if that input fails; worker changes cannot inherit it.

Use `msUntilExpiry` and shared `IDENTITY_IDLE_MS` for the idle text/bar (fresh 15:00, clamped 0–100%). Neither rendering nor refreshing totals extends activity. Dispatch retains next-site-04:00/max-12-hour expiry and its existing once-per-shift badge flow; do not show the Framing idle bar, triple-badge instruction, Framing competition or Framing totals there. Its shared chrome/result/warnings may take the new styling, and its Framed by/manual labels and picker remain fully functional.

Clock domains stay separate: wall-clock `now = Date.now()` drives saved timestamps, workday and idle expiry; a separate `elapsedNow = performance.now()` drives the gesture's remaining window using tuning's elapsed-time fields. Pass both explicitly, or pass controller-derived gesture remaining milliseconds. Never subtract gesture `firstRepeatAt` from wall-clock time. The controller remains the authority on whether progress has expired.

### 4. Typography, theme and accessibility

**Planner choice: self-host Atkinson Hyperlegible**, regular 400 and bold 700 WOFF2, plus the upstream licence, under `public/fonts/atkinson-hyperlegible/`. Obtain from the official font distribution, record provenance in the licence/source file, and use `font-display: swap` with Segoe UI/system fallbacks. No runtime Google Fonts request or npm package. Apply only to a `.scanner-wall` root, not the whole app.

Use a local `dark` wrapper and the existing tokens (`--hub-page` 18/18/18; panel 28/28/28; sidebar 22/22/22; line 46/46/46; text 237/237/237; muted 161/161/161; accent 62/207/142). Do not mutate the user's global theme or copy the old slate palette. Green banner/leader chip uses dark ink, not low-contrast white on bright green. Use warn/bad/info tokens for other states. Names about 56 px, counters about 64 px and primary results at least 40 px at target size; supporting operational text at least 16 px and essential labels at least 14 px. Long names wrap rather than disappearing behind ellipsis.

Match the four compositions at 1280 × 800 with no scroll in their ordinary states. Extra warnings/blocked jobs and 200% zoom must reflow/scroll accessibly instead of being clipped by fixed height or `overflow:hidden`. At narrower sizes stack panels; retain site/mode and all recovery/actions. Visible keyboard focus, semantic buttons, accessible scanner headings, status text plus colour/icon, and adequate contrast remain required. Use polite live announcements for results and assertive alerts for actionable errors; do not announce countdown ticks, changing ranks or each animation frame. Reduced motion disables pulse/sweep; numerical countdown remains. No auto-focus or DOM behavior that breaks scanner key capture or lets a scanner Enter activate a focused operator button.

## Acceptance criteria

- [ ] AC1: All four approved artboard states are recognisable at 1280 × 800 using dark hub tokens and self-hosted Atkinson; long names, font failure, narrower screens and zoom remain usable.
- [ ] AC2: Person/day totals reconcile to shared F1 evidence for normal framed/A0 work, including sets, cancellations and distinct mixed-work-type orders. Rebind, duplicate person slots, ties and zero output are correct. No display calculation writes credit or stock.
- [ ] AC3: One current-site workday read serves the wall; loading, stale, incomplete, unavailable and rollover states never present missing figures as zero or trustworthy leaders. Indexed staging performance and role tests pass.
- [ ] AC4: Received/checking/saving are real stages; only acknowledged saves show green. Simultaneous slots, queued work after rebind, lost response/retry, duplicates and uncertainty preserve original attribution and exact-once behavior.
- [ ] AC5: Persistent recovery, 1/3–2/3 sign-out, signed-out/free, suppression and fifteen-minute countdown retain all tuning boundaries and cancellation rules.
- [ ] AC6: Classic, Dispatch, framer choice/manual attribution, all health/warnings and existing recovery/operator controls remain working and accessible.

## Data and backend impact

**Source:** the existing `load_production_evidence_v2` read-only SECURITY INVOKER RPC through `loadProductionEvidence` (`src/lib/repository/supabase/productionEvidence.ts`). Reuse its strict complete-envelope validation and shared reducer, as Classic Production does. Do not use published management summaries for immediate scan feedback: those are generation-based and can lag. Do not combine receipts with events (double counting), increment local totals after a save, or introduce a new statistics table. `scanner_requests` remains the existing save/idempotency proof; its receipt alone cannot handle corrections, Classic work or F1 evidence rules.

Use `productionDateAt`/`productionRange` in `productionPeriods.ts`: [04:00, next 04:00) in Australia/Sydney, Europe/London or America/Chicago, converted independently to UTC for DST. Stored `created_at` for shared work is original scan time, not receipt arrival; an offline yesterday job saved today belongs to yesterday. Unsupported sites show counts unavailable, never an inferred browser-time day. Recompute day before fetching on resume/focus and at the boundary.

**Bounded read policy:** one RPC for one site and one workday plus the existing linked qualification/parent/cancellation context, a fixed as-of cutoff, one request in flight per wall. No per-person/item read, full-history preload, realtime subscription or per-second poll. Initial load and each new binding schedule a read; successful saves and already-recorded outcomes request a coalesced refresh. Minimum five seconds between starts, one trailing dirty refresh after any in-flight changes, and a sixty-second refresh while visible/online. Use a ten-second client deadline, no immediate automatic retry (`retries: 0` if reusing the hook); next scheduled refresh recovers. Polling pauses hidden/offline, but input/delivery never waits for counts. Reuse/compose hook semantics for cancellation, identity fencing and stale snapshots; do not change Classic's defaults.

Accept only a complete envelope. Add a scanner-local 20,000-row safety limit (including context) before decode/reduction; exceeding it shows unavailable, never a partial sum. This is a client safety ceiling, not a claim that the old RPC limits server rows. SQL statement timeout remains unchanged; a day with excessive context fails visibly. Key state by authenticated caller/role/site access, site, day and mode. Late old reads cannot populate a new scope; clear counts on permission loss. Cached same-day figures on read failure say “Totals delayed · last updated <site time>”; initial failure shows em dashes and “Today's totals unavailable”. Mark stale after 90 seconds even without a reported error. Suppress competition/share when stale, incomplete, limited-visibility or overflowed. A confirmed save remains green even if its new total is still refreshing.

**Tables / migrations:** no new table, column, write function or RLS/grant change. **One index-only migration is required by this read design against the checked-in schema.** `0012` has `(location, staff_id, created_at)` and `(location, department, created_at)` indexes, neither directly covers the RPC's site/time predicate without a person/department constraint. Add a partial B-tree `production_events_count_window_idx` on `(location, created_at)` WHERE `event_type IN ('line_verified','completed','dispatched','cancelled')`. The existing location/order, location/parent and primary-key indexes support linked context. Next checked-in number is currently `0064`; coder must recheck allocation after tuning. Never edit existing migrations. If staging already has an equivalent valid index, reconcile that evidence with CJ before application rather than adding duplicate infrastructure. CJ alone applies SQL. Index installation and full RPC plans under kiosk RLS are a release gate, not a performance claim from source inspection.

- Repository: `Repository.ts`, `DexieRepo.ts` and `SupabaseRepo.ts` unchanged. This remains a Supabase-only production screen; Dexie is only existing outbox storage. No new backend interface needs dual implementation.
- API: no `api/` endpoint change. Add only scanner-local read/projection glue and optional transient delivery-stage observations; no changed RPC payloads or persisted queue versions.
- Access: wall use remains owner/manager/kiosk with site membership. Existing evidence RLS allows site-wide reads for those roles (and CS), staff own rows only. UI denial is not a claim of new database denial: preserve existing CS/staff read policy, withhold competition for limited visibility, and test cross-site/anonymous refusal. Never use service-role credentials for wall reads.

## Staging test plan

CJ uses the branch Preview against **inka-staging-2**, never production. Finish tuning staging checks first. Record results separately from unit/mock results.

1. **CJ database operator:** reconcile the new index against staging, apply the reviewed additive migration, then inspect underlying RPC query plans with the authenticated kiosk role/site RLS (not just an outer Function Scan). Seed synthetic two-year history across AU/UK/US, representative busy-day volume and linked old-order corrections. Confirm the window uses a time-bounded index path and context uses keyed lookups rather than a full site-history scan. Record row count, payload size, ten warm-call durations and concurrent-save latency; target warm p95 under two seconds and no read timeout. Test the 20,000-row ceiling separately with controlled input; do not raise limits/timeout to hide failure. Performance failure blocks release pending a plan amendment.
2. **Kiosk:** compare all four states against artboards at 1280 × 800 with printed `<S1>…</S1>` plus Enter and S2/S3 frames. Bind three people; verify normal scanning is touch-free after Start. Delay lookup and commit independently to observe truthful stages. Check long names, numbers, font served locally, unavailable-font fallback, reduced motion, keyboard controls, zoom and extra warning overflow.
3. **Kiosk + owner/manager inspection:** seed single/set/mixed A0-regular work, same order credited to different people at different work types, cancelled verification/terminal, Classic saves and CS/rework. Reconcile per-person/team figures with F1 at the same cutoff; switch scanners and bind the same person twice, check ties/zero. Replay the same request and scan a duplicate: no extra credit, stock or totals. Save offline work across 04:00; test AU/UK/US rollover and DST with controlled clocks/fixtures. Previous-day data must never carry into today's tiles.
4. **Kiosk:** force read failure while saving succeeds, and the reverse; block RPC, lose focus/auth/network, cause storage/full-queue/corrupt-job warnings and a lost commit response. Confirm reads cannot stall scanning, missing totals are not zero, uncertainty forbids classic re-recording, reload keeps jobs and resynchronises totals. Change account/site/mode while a read/commit is pending; no old response leaks into current-person counts.
5. **Kiosk:** repeat tuning corruption followed by earlier delivery, badge sign-out at 0/2/4 seconds, suppression, timeout and late activation replies; observe 15:00 through expiry. Goodbye belongs to departed person and clears on next slot scan. Let their queued job finish after rebind; global confirmation keeps their name, current worker's last-order line does not.
6. **Owner/manager:** verify all operator actions, heartbeat/silence display, queue and Classic fallback. Switch Dispatch: shift expiry, Framed by measured/manual markers, missing-framer choice/recheck, blocked/uncertain job actions, mode switch and queued-job mode isolation. **Staff/CS:** station remains denied even if page navigation is granted; direct evidence reads retain existing own/site visibility respectively. **Anonymous/cross-site:** no site evidence or scanner write privilege. No new grant is acceptable to make a failed test pass.
7. Run [RELEASING smoke tests](../RELEASING.md#2-smoke-test-staging-preview-about-10-minutes): role logins, clock events, verify/complete, exactly-once stock, Shopify, shipments/CS/returns, Dashboard/Reports. Obtain green CI and planner review before CJ releases.

## Hardening

1. **Failure modes:** Supabase/read delay affects labelled counts only; Shopify/commit delays show true progress and retained queue. Dropbox/Slack/Make are n/a (no new calls). No new writes/idempotency keys: preserve request IDs, leases, concurrency locks and immutable retries. Bad input/unknown barcode/cancelled or wrong-site orders retain tuning/preflight refusal and original sounds. Recovery is specific to refused versus uncertain work; totals never authorize a retry.
2. **Data correctness:** IDs and captured job scope prevent reassignment. Shared F1 rules supply sets, cancellation, distinct orders and separate rework; no parallel formula. Fixed work types do not follow a person's later department changes; existing event history/snapshots stay intact. UTC facts/site-zone workday and display use shared helpers. Manual Dispatch remains labelled; no new inferred production metric. Staleness and incomplete coverage are explicit.
3. **Security:** no new endpoints/tables; existing authenticated invoker RPC/RLS is the boundary. Role/access changes clear display data. No privileged client, new secrets, messages, emails or broad personnel lookup. Bounded/coalesced reads avoid per-scan/per-person API amplification; raw badges/customer details are not displayed or logged by the new observer.
4. **Release/rollback:** additive non-unique index only; old app remains compatible. Existing Classic station is the operator opt-out; no new feature flag. CJ applies/test index on staging, tests Preview, records deployment, applies index at a quiet production window, then merges/releases and refreshes receivers. No env/provider settings. Rollback leaves index and all receipts/events/outbox data intact; see below.
5. **Performance:** current-day scope, context indexes, one shared read, cadence/deadline/row ceiling above. Verify two years/three sites with real query plans under RLS; do not assert calendar filtering alone guarantees speed. No external API per item, and no new long-lived history cache.
6. **Operations:** retain online/auth/storage/queue/focus/wake/audio indicators, heartbeat and silence health; add count freshness/failure status. Browser/RPC logs and failed staging performance reveal read problems; no remote alert is newly promised. Manual Classic fallback respects uncertain work. Monitor polling latency/failure and index size/write overhead; no subscription or token maintenance added and never clear browser storage for recovery.
7. **Tests:** projection/count fixtures, clock/DST/rollover, read lifecycle/fencing, observer callbacks, simultaneous slots and static render/accessibility regressions are in the plan. Existing old/new tuning inventory, credit, parser, outbox and Dispatch suites stay green. Actual SQL/RLS/query-plan and scanner hardware checks are CJ's staging evidence.

### Rollback

CJ uses the existing Classic station action for immediate floor fallback, keeping jobs; resolve uncertain jobs through their original request before any re-recording. App rollback is Vercel's prior deployment followed by receiver refresh and Start. The additive index needs no rollback and does not change old reads/writes. Never delete queues, receipts, ledger/events or restore a database backup. This shares a release with tuning: a rollback to the pre-tuning deployment also restores its prior scan behavior; CJ must brief operators accordingly. Agents never merge, deploy or apply SQL.

## Roadmap decisions honoured

- F6 scan-only framing and automatic sign-in: no worker confirmation controls/pop-ups; setup Start and operator recovery remain.
- Per-scanner shared identity and forgotten badge protection: verified people, explicit IDs, tuning's fifteen-minute expiry and deliberate local sign-out.
- Mixed-up scans: strict parser unchanged, persistent loud recovery, no guessed attribution.
- Offline safety: original captured time/person, durable queue, server confirmation and exact retries; counters do not manufacture saves.
- Kiosk: sound/wake startup, focus/auth/offline warnings and existing signed-in/startup guidance retained.
- Wall/health: large result feedback, preserved tones and current heartbeat/silence status; no new remote alert claim.
- Hardware: one receiver/three configured shared scanners; future receivers keep scoped jobs. Configurable markers, range, battery and HID POS preference remain commissioning requirements; mockups do not prove hardware behavior.
- Cross-cutting/F1/F5: staging/rollback, fixed work types versus managed departments, shared piece/order rules and immutable historical attribution. F7 badge-once-per-shift, framer evidence/manual choice and existing screens remain.

## Risks and open questions

- No unresolved product-design question blocks implementation. The source/index/font/progress choices here are planner implementation choices, not additional statements attributed to CJ.
- Required release evidence: staging index reconciliation and query plans/performance, actual role reads, scanner hardware and layout checks. No database connection, SQL application, performance run or app test is claimed by this documentation task.
- The temporary artboards may disappear. Their exact paths and essential composition are recorded here; coder should view them before layout work and report missing originals rather than invent a different visual design.
- An unusually busy day or large linked history can exceed the safety bound; show unavailable while scanning continues, and return performance redesign to the planner instead of silently truncating totals.
- Counts are normal saved work across the site for people currently on the wall, not a payroll metric or receiver-only audit. Sign-out changes the active-team total. The labels above are required to make that behavior understandable.
- Tuning accepts retaining an identity after a garbled badge. This visual redesign does not eliminate that risk or change its recovery instruction.
