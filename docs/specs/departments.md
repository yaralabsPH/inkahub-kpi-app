# Spec: Managed business departments

- Slug: `departments` · Roadmap ID: `F5`
- Status: approved for implementation by Codex under CJ's delegated approval, 2026-11-22; staging acceptance and release remain pending
- Author: planner (GPT-6 Astra)
- Basis: `feature/departments` at `8519ac9`, inspected 2026-11-22. The brief is approved; the detailed choices below are proposals for approval.

## Problem

There is no managed home department or assignment history. `production_events.department` means routing work type. Joining events to today's membership would miscredit transfers, renames and delayed scans. Owners need administration on Team; F6/F7 need durable attribution and F8 needs trustworthy historical facts.

Evidence: migrations 0012/0022/0028–0033 define Auth-backed workers, seven event types and permissive event policies; 0001 permits profile reads only by self/owner. Production inserts directly, including clocks that omit `created_at`. Reports, Welcome, benchmarks, station settings and the digest use the legacy work-type field. `ProductionEventSchema` lags SQL. Read-only remote refs confirm Team removal preserves Auth users but deletes profiles, and Station still has five direct event insertion sites. A kiosk browser cannot reliably look up another worker's profile.

## Goals

- Owner-managed departments and exactly one home department for each configured working person, globally across their locations.
- Resolve every new production event at its reported occurrence time (bounded forward clock skew clamps to receipt), retaining stable person, department, historical label and assignment identity; explicitly record uncertainty rather than guess.
- Preserve old clients, routing, stock behavior, stable identities and historical unknowns.
- Provide audited administration, failure controls and a usable F6/F7/F8 contract.

## Non-goals

- Business-department reports/CSV (F8), offline queue/hardware (F6), manual framer evidence (F7), changed SKU routing, work permissions, inventory/counting rules or existing event-read policies.
- Department-to-work-type mapping: out of F5. Membership is an organizational fact, not permission to do work. Person 1 from Department A at a `dispatch` station records work type `dispatch` and business department A. A mapping would introduce unapproved restrictions; framing-line scope remains an F6 input.
- Historical event backfill, retrospective assignments, invented initial departments, hard deletion, bulk import or agent-operated database/release changes.
- **Deferred from F5's first release:** Team health panel and manager/staff/CS assignment reads, including the manager directory RPC; no F5 flow consumes them. F5 retains owner management/control, operator health queries and all historical evidence for F8. Request receipts, name history, control and advisory locks remain necessary for retry safety, historical labels, the kill switch and consistent attribution respectively.

## User stories / flows

1. **Owner / Team → Departments:** active list with current member counts, archived filter, create, rename, archive and restore. Show normalized name before save. Archive is refused with a member list until all current members have been transferred. Restore restores availability, not memberships. Conflicting edits require refresh and deliberate reapplication.
2. **Owner / Person → Home department:** current home and dated history; select an active department and confirm. Server supplies effective time. First assignment starts now; a transfer atomically closes the old interval and opens the new one. No ordinary “clear home” action. Correct a mistaken assignment with another transfer now and a required reason; no saved credit changes.
3. All current profiles without a home show **No home assigned**, never a guessed department. This is an account list, not an inferred worker classification; owners use the supplied roster to identify who needs enrollment. Every human who performs work needs one home, regardless of login role. Shared kiosk/service logins need no synthetic assignment. An owner/manager/CS who works can be assigned explicitly. Existing/unconfigured people can still record work with explicit missing attribution: enrollment completeness must not block a scan. Do not automatically classify all accounts of one role as workers.
4. Save states are visible; preserve inputs on failure. Retry the same request ID after timeout/unknown outcome, then refetch. Disable double-submit but enforce correctness server-side. Paginate lists/history/audit and key caches by caller/scope; clear on sign-out.
5. In Dexie mode, Team shows “Department management requires Supabase” before calling `getSupabase()`. No editable mock assignments. Non-owners get no management controls or new assignment reads in F5.
6. On profile deletion, a database lifecycle trigger closes the person's open assignment at server time and audits removal atomically with that deletion. Preserve Auth ID/history; do not change Team Edge Function ban/barcode/location sequencing. Delayed pre-removal events still resolve; post-removal events have no assignment. Reinstating the same Auth ID requires a fresh explicit home; a new Auth ID is a different person even with the same email/name. No identity merging by display name or barcode reuse.

## Acceptance criteria

CJ uses staging-only Person 1 (AU/UK), unassigned Person 2, Departments A/B and unused Department C. Save event E1 while Person 1 belongs to A; capture server-returned transfer/rename times T/R. The plan supplies fixture scripts and inspection queries for each checkbox; synthetic time tests never change tablet/server clocks or expose a client-settable receipt time.

- [ ] Create “  Department   A  ”: Team lists “Department A”.
- [ ] Rename unused C to “Department C2”: Team shows the new name.
- [ ] Archive C2: it disappears from the active picker.
- [ ] Restore C2: it returns to the active picker with zero members.
- [ ] Assign Person 1 to A: their AU and UK home displays both show A.
- [ ] Transfer Person 1 from A to B: history shows adjacent intervals meeting at T.
- [ ] Re-read E1 after that transfer: its department remains A.
- [ ] Rename A to “Department A2” at R: E1's saved label remains “Department A”.
- [ ] Archive B while Person 1 belongs to it: the action is refused with Person 1 listed.
- [ ] Person 2 records an authorized work event: it saves with status `unassigned`.
- [ ] Replay an old payload omitting all F5 fields from each main/#8/#10 insert site: each event saves with a server-produced status.
- [ ] Insert one of each of the seven event types for assigned Person 1: each receives `assigned`.
- [ ] Turn the owner switch off and record E2: it saves with `disabled` and no department references.
- [ ] Turn the switch on and record E3 for Person 1: it receives `assigned` again.
- [ ] Each manager/staff/kiosk/CS account calls create/transfer/control RPCs and direct table writes: every attempted mutation is denied.
- [ ] Each non-owner directly requests the new department/assignment tables: no department-directory or assignment rows are disclosed.
- [ ] Compare a pre-migration event before/after migration and an unrelated update: all added fields remain NULL.
- [ ] With reported time O = receipt S + 2 seconds: the saved tuple is (`assigned`, `future_clamped`, resolution instant S, reported instant O).
- [ ] SQL boundary fixture at O = S + 5 seconds: the time classifier returns `future_clamped`.
- [ ] SQL boundary fixture at O = S + 5 seconds + 1 microsecond: the time classifier returns `invalid_time` with NULL resolution instant.
- [ ] Insert an event reported 30 seconds ahead of receipt: it saves with `invalid_time` and no department references.
- [ ] For a clamped event received before transfer T but reported after T: it retains A after the transfer commits.
- [ ] SQL boundary fixture at O = S − 5 minutes: the time classifier returns `reported`.
- [ ] SQL boundary fixture at O = S − 5 minutes − 1 microsecond: the time classifier returns `reported_old`.
- [ ] With tracked O two hours before receipt, in A's interval, and receipt after transfer to B: the event remains credited to A with `reported_old` (a warning, not proof the clock is correct).
- [ ] Run the health query over those fixtures: `future_clamped` and `reported_old` counts match the inserted cases, including assigned events.
- [ ] Submit a delayed event exactly at T: its assignment is B.
- [ ] Submit a delayed event in A's interval exactly at R: its label is “Department A2” (use a separate rename-before-transfer fixture).
- [ ] With only the resolver trigger disabled, submit forged F5 values: the saved event is `resolver_unavailable` with cleared department references.
- [ ] Retry one transfer request after a simulated lost response: inspection shows one mutation/audit result.

The staging matrix below separately covers concurrency, failure injection, unchanged production/stock behavior, F1 composition and rollback.

## Data and backend impact

### Approach and rejected alternatives

Use an independent **BEFORE INSERT sanitizing guard**, followed by a **BEFORE INSERT resolver trigger** on `production_events`, to overwrite new attribution fields and resolve by credited `staff_id`, not session `auth.uid()`. The guard remains active when the resolver is disabled for repair. Existing INSERT RLS still authorizes the event. An insert RPC alone misses old clients/direct writes; client-supplied snapshots are forgeable and kiosks cannot read profiles. Reject both as the attribution authority. Admin writes do use transactional RPCs.

Departments and assignments are **global**. One person with several locations has one home; event location remains independent and site access is still enforced. Reject per-location homes because that would assign several homes to one person.

### Additive objects and invariants

Names/types below are the implementation contract. All added event columns are nullable with **no defaults populating existing rows**. New tables can have required fields. Never edit existing migrations or update/backfill existing events.

| Object | Shape and rules |
| --- | --- |
| `business_departments` | UUID PK `id`; `name`, globally unique `normalized_name` text; nullable `archived_at timestamptz`; `version bigint`; server created/updated timestamps and actor UUIDs. No hard delete. |
| `business_department_names` | UUID PK `id`, department UUID RESTRICT FK, display `name text`, `valid_from timestamptz`, nullable `valid_to timestamptz`, actor/request IDs. Rename closes open label interval and opens another at the same instant. |
| `person_department_assignments` | UUID PK `id`; `person_id uuid → auth.users ON DELETE RESTRICT`; department UUID RESTRICT FK; `valid_from/valid_to timestamptz` (end nullable); creation actor/time; nullable closing actor/time; reason text; request UUID. Never FK to profiles. Only interval closure may update an existing row. No deletion/replacement. |
| `department_audit` | Append-only UUID PK, request UUID, operation, actor Auth UUID, subject IDs, server/effective timestamps, before/after JSON containing department facts only, reason. Transactional audit for create/rename/archive/restore/assignment/closure/removal/control changes. No rates, email, credentials or profile dumps. |
| `department_requests` | Unique `(actor_id, request_id)` UUID pair, canonical payload hash, stored result, server timestamp. Identical retry returns original result; changed payload errors. Mutation and receipt commit together; retain with audit. |
| `department_snapshot_control` | Singleton, enabled boolean (initially false), immutable `tracking_started_at timestamptz` set by migration, version/audit metadata. Owner control RPC changes enabled; missing row is missing configuration, never assumed enabled. |

Intervals are UTC half-open `[valid_from, valid_to)`; NULL end means infinity. Require finite start/end and end > start. Add GiST exclusion constraints on `(person_id WITH =, tstzrange(...) WITH &&)` and equivalent department/name intervals, plus partial unique indexes for one open row per subject. Supplied read-only staging catalog check (2026-11-22): PostgreSQL 17.11, `pgcrypto` installed, `btree_gist` 1.7 available but **not installed**. The additive migration must execute `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;` before constraints, using Supabase's `extensions` convention and explicitly resolving extension operator classes there. No npm dependency. CJ still confirms production availability, installation privilege and any existing extension schema before release; do not relocate an existing extension silently. Reject trigger-only overlap validation because concurrent writes can bypass it. Retain histories indefinitely for now.

Server name normalization: trim/collapse whitespace to single spaces, reject control characters, require 1–80 Unicode characters after normalization; preserve display casing, use database lower-case normalized text for uniqueness. Browser preview is advisory; server wins. Reserve current names across active **and archived** departments; reject active-only uniqueness because restore becomes ambiguous. Former names may be reused after rename because IDs distinguish departments. Reason max 500 characters, rendered as escaped text. Validate UUIDs, expected versions/current assignment ID, operations and active department on server and in Zod. Opening an assignment requires a current profile, checked under the same lifecycle lock as profile deletion; reject absent profiles even though the Auth ID survives. Historical reads and delayed-event resolution do not require a profile.

Assignments and renames take effect **now only**, with server time chosen after acquiring the mutation lock. No backdating or scheduling in F5: reject those alternatives because they require retroactive correction/pending schedule semantics. An incorrect assignment is corrected prospectively with an audited reason. Archive requires no open assignments, including any orphaned by an incomplete member-removal operation. Restore does not reassign. Delayed events before archive still resolve their historical interval/label. A legitimate assignment cannot extend across archive; inconsistent history returns resolution_error. Audit retains archive/restore times.

### Exact event snapshot contract

The guard/resolver own every added field below; clients omit them, and supplied values are ignored. No FK to profiles. Event snapshot UUID references deliberately have no new event-table FK checks that could turn optional lookup failure into scan rejection; authoritative server lookup and retained records establish provenance.

| Added field | Type and meaning |
| --- | --- |
| `business_department_id` | uuid; stable business department. |
| `business_department_name` | text; display name effective at the resolution instant below. |
| `business_department_assignment_id` | uuid; exact effective interval ID. |
| `business_department_name_version_id` | uuid; exact effective label interval ID. |
| `business_department_status` | text; vocabulary below. |
| `department_snapshot_version` | smallint; 1 for this contract. |
| `department_occurred_at` | timestamptz; verbatim `NEW.created_at` after its existing default, even if suspect. |
| `department_received_at` | timestamptz; server `clock_timestamp()` captured once by the insert guard, before lookup/locks. |
| `department_resolution_instant` | timestamptz; occurrence instant actually used for historical lookup, distinct from attempt time; NULL for invalid time or emergency guard-only insertion. |
| `department_time_status` | text; `reported`, `future_clamped`, `reported_old` or `invalid_time`, independent of attribution status; NULL for legacy or emergency guard-only insertion. |
| `department_resolved_at` | timestamptz; server resolution-attempt time, including failure/disabled path. |

`assigned` requires all four department/name/reference fields. Every other status clears all four together:

- `unassigned`: valid tracked resolution instant with no assignment interval; time warnings still apply.
- `before_tracking`: resolution instant predates tracking start.
- `invalid_time`: nonfinite occurrence or occurrence more than five seconds later than server receipt. Never resolve an assignment in the future.
- `resolution_busy`: concurrent administration prevents safe nonblocking lookup.
- `resolution_error`: lookup or consistency failure.
- `disabled` or `control_missing`: resolver off or configuration absent.
- `resolver_unavailable`: independent insert guard ran but the resolver trigger did not; emergency unresolved event, distinct from legacy NULL.

**NULL status means legacy / never resolved**, not unassigned. Old rows keep all added fields NULL forever, including unrelated old-client updates. F8 must distinguish reasons and coverage counts, never join unknowns to today's membership.

Insert algorithm: the first guard unconditionally discards all supplied F5 fields, clears department references, sets version/reported/receipt timestamps and `resolver_unavailable`, and leaves resolution instant/time status/attempt time NULL. It does no configuration/history lookup and calls no resolver helper. Fixed, tested trigger ordering runs it before the resolver. The resolver sets attempt time, classifies time using the rule below, then reads control (off/missing takes attribution-status precedence but retains time markers); when enabled, invalid time returns `invalid_time`, pre-tracking resolution instant returns `before_tracking`, otherwise obtain the nonblocking lock and resolve assignment plus label in one consistent query. One complete match yields assigned, zero assignments yields unassigned, multiple/incomplete/inconsistent matches yield resolution_error. Catch errors from optional control/lookup work, return cleared department references with resolution_error and a sanitized diagnostic code. Diagnostic logging failure must not reject the event. No network call, audit write, event UPDATE or background retry inside these triggers.

A separate BEFORE UPDATE guard preserves all snapshot fields from OLD, including legacy NULLs. On rows with non-NULL snapshot status, reject changing `staff_id`, `created_at`, `location` or `id` so identity/time cannot diverge from frozen attribution; permit existing unrelated updates. Verify old-client update payloads before release. Existing deletion/cancellation permissions stay unchanged; F5 does not claim to repair event deletion. Saved unknowns are never silently repaired; any later correction overlay requires a separately approved audited design.

### Time, offline and concurrency

Today `created_at` is occurrence time: usually browser-supplied; clock events use its SQL default. Keep its meaning/type/default. F6 must persist original scan UTC time, bound Auth worker ID and stable event/capture ID before network work, then send the same `created_at` on every retry. Never substitute sync time. Cached assignment IDs are hints, not authority. F7 must retain manual source/actor and evidence time separately, without inventing a scan time. F8 groups frozen snapshots by stable department ID, retains historical labels and uses event location for approved reporting periods.

Let O be the reported `created_at` and S the guard's receipt time. Preserve O in `department_occurred_at` without changing `created_at` (timestamp value, not the original ISO string formatting). Set the independent time marker and resolution instant as follows:

| Condition | `department_time_status` | Resolution instant |
| --- | --- | --- |
| O nonfinite, or O − S > 5 seconds | `invalid_time` | NULL; no department credit when enabled |
| 0 < O − S ≤ 5 seconds | `future_clamped` | S = min(O, S) |
| S − O > 5 minutes | `reported_old` | O; do not withhold otherwise valid credit |
| Otherwise (including O = S) | `reported` | O |

**Proposed bounds:** five seconds covers the reported one-to-two-second fast-tablet case with a small margin; larger forward errors remain invalid. Receipt is a sound upper bound on when an already-received event happened, not proof of its exact occurrence. Resolve at S under the shared lock, never at future O: a transfer between S and O cannot change this event's department because its effective time is after S. If a transfer already committed between guard receipt and lock acquisition, historical lookup at S still selects the earlier interval; an in-progress conflicting mutation yields `resolution_busy`. There is no future attribution window. A transfer between true capture and receipt remains unavoidable timing uncertainty, explicitly marked by `future_clamped`.

Main has no offline queue and inserts normally arrive within a second, so **more than five minutes behind receipt** is abnormal enough to flag while tolerating ordinary latency. Count `reported_old` even when assigned; hours/days behind can miscredit an older home after a transfer. Do not substitute today's assignment, reject an otherwise valid scan, or silently repair it. F6 must add capture-time clock-health/provenance and distinguish intentional queue age from bad clocks before shipping offline capture; F5's marker alone cannot distinguish them.

Example: Person 1 scans in A at 09:59 UTC offline, transfers to B at 10:00, syncs at 10:05: record A with `reported_old`. A rename at 10:02 cannot change the 09:59 label. Exactly 10:00 selects the new interval. No maximum queue age after tracking began; retained history resolves an old delayed event with its warning. Resolution instants before tracking stay unknown. Malformed timestamps rejected before trigger execution remain visible write failures; F6 must retain those captures for supervised recovery.

All department/admin/profile-removal mutations take one dedicated transaction-scoped exclusive advisory lock before choosing effective time. Document the key, distinct from F1/inventory. RPCs recheck expected version/current assignment under it, use bounded lock wait, and return retryable conflict on timeout. Two owners using one version get one success and one refresh-required conflict. Same-department assignment returns a no-op receipt, not a zero-length interval. Rename/archive/assignment changes serialize.

Event resolution uses the matching **try-shared transaction advisory lock**, never waits on administration, and queries committed state in a fresh VOLATILE function query after acquisition. Failure to acquire saves resolution_busy. Shared locks allow simultaneous scans; admin waits for existing inserts before choosing effective time. Test READ COMMITTED visibility; unsupported isolation must yield unknown rather than stale attribution. Prefer visible unknown during a rare conflict to blocking/wrong credit. Reject independent unlocked assignment/name reads and event locks that wait for owner edits.

Event retries retain `(location,id)`: conflict retrieves/confirms the saved event, never UPDATEs/re-resolves or invents another ID. F5 does not retrofit a full scan queue into old clients, whose random IDs can still duplicate logical scans. F6 owns durable capture IDs and acknowledgements. Inventory deduplication is separate.

### Permissions, repository and UI boundary

Enable RLS on new tables. Revoke PUBLIC/anon/service_role table/function privileges explicitly; grant only required authenticated reads/public RPC execution. No direct table DML even for owners: owner-checked SECURITY DEFINER wrappers mutate atomically, with `search_path = pg_catalog`, schema-qualified objects and no dynamic SQL. Internal trigger helpers have no caller execution grants. Do not inherit broad historical default grants. Every public RPC authenticates/authorizes, including receipt replays. Narrow trigger privileges permit assignment reads without profiles/rates and do not widen event INSERT RLS.

| Caller | New reads | New writes |
| --- | --- | --- |
| Owner | All departments/assignment history/audit/control across sites; removed Auth IDs with “Removed person” fallback. Operator health queries below. | Admin/control RPCs. |
| Manager | No new department/assignment reads in F5. | None. |
| Staff | No new department/assignment reads in F5. | None. |
| Kiosk | No assignment directory/history; existing operational event confirmation only. | None; existing authorized event INSERT still works. |
| CS | No new department/assignment reads in F5; no new performance access. | None; existing self event INSERT unchanged. |

RLS enforces owner-only reads of new tables; no manager directory RPC or self-history policies ship in F5. This defers access, not stored assignment/name history. F8 must implement approved owner/site/self/operational scopes (manager reads require caller/subject `user_locations` intersection), reconcile existing permissive event SELECT policies and require explicit CS performance grants. Existing event confirmation/reads stay unchanged. Paginate owner lists with maximum 100 rows. No new profile/rate policy/grant; `allowed_nav` alone never grants data access.

**Scoped Repository exception:** production/team persistence is already direct Supabase; F5 remains Supabase-only. No `Repository.ts` method changes, hence neither adapter gains a method. Dexie retains its stores without fake identity/assignment services. Align shared event parsing with SQL's clock/verification types, nullable clock order and case/parent fields; add optional nullable snapshot fields without invalidating old Dexie rows/backups. Do not expand backup scope. No `api/` endpoint, external service, secret or npm dependency required.

### Integration and migration coordination

Recommend an agreed base containing #8 Team and #10 Station, a separate department component on Team and **no Production.tsx edit required for snapshots**. Because main merges deploy, do not merge PRs early solely to obtain a base: use CJ's prepared integration branch while the batched release is pending. Reject stacking on unfinished F1. CJ must choose the base below.

Main ends at 0033 (0027 absent). Read-only F1 remote inspection confirms 0034–0045 and its AFTER INSERT/UPDATE/DELETE `production_events_reporting_capture`, capturing full-row `to_jsonb(NEW/OLD)` and raising on missing control. Supplied discovery reserves local unpushed 0046 and says that trigger is on shared staging; neither that file nor live catalog was accessed here. Reserve F1 0034–0046+; obtain F3/F4 reservations and assign F5 the **next unclaimed number at implementation**, not automatically 0034/0047. CJ reserves a shared-staging window: concurrent migrations must not be applied together. Reconcile schema/extension/grants/control before testing.

F5 BEFORE capture composes with F1 AFTER capture; test added JSON keys against F1 consumers. Never disable/rename/replace F1 triggers. No event UPDATE/backfill on migration or activation, which would emit F1 change records. F1's missing-control exception still aborts outside F5: a combined-release issue for F1's owner, not something this trigger can catch. Test F5 alone and with F1 enabled/disabled. No F1/F3/F4 files or other checkouts are modified.

## Staging test plan

CJ applies reviewed SQL in the reserved staging window and tests staging-only Preview with synthetic Department A/B, Person 1/2, role accounts and AU/UK/US. Migration seeds no invented roster. SQL assertions and two-session scripts are required plan deliverables executed by CJ; Vitest alone does not prove RLS.

| Role | Acceptance matrix |
| --- | --- |
| Owner | Normalize/duplicate validation; assign multi-site person; transfer/rename boundaries; archive blocked then allowed; restore without membership; correction reason; concurrent edits; lost acknowledgement/idempotency; reused key/different payload rejected; audit; remove/re-add same/new Auth IDs; switch off/on and operator health queries. |
| Manager | New department/assignment/history/audit/control reads and writes denied through direct API; existing authorized site event insertion works. |
| Staff | New department/assignment/history/admin access denied; self event succeeds at own site, other-worker and foreign-site spoof denied. |
| Kiosk | Profiles/assignment directory denied; scanned worker event receives correct server snapshot; forged snapshot overwritten; all seven event types work; admin denied. |
| CS | New department/assignment/history/admin access denied; no new performance privilege; self event policy unchanged, other-worker insert denied; CS workflows still work. |
| Anon / service role | New privileges absent as specified; unauthenticated calls rejected. Check grants as well as RLS. |

Cross-role cases: main and #8/#10 old payloads; unassigned worker; legacy row NULL after unrelated update; snapshot tampering; missing control; injected resolver exception; held admin lock; disabled resolver; delayed events across transfer/rename/removal/archive; exact endpoints; skew/pre-tracking timestamps; server receipt time cannot be forged. F1 captures final fields once per successful insert; old event images remain unchanged by migration. Unknown barcode, malformed scan, missing SKU, cancelled/cross-site order retain existing rejection behavior without fabricated attribution.

Time fixtures cover O − S = 0, +1/+2 seconds, exactly +5 seconds and +5 seconds +1 microsecond; S − O = exactly 5 minutes, 5 minutes +1 microsecond, two hours and two days; nonfinite/pre-tracking values; every time marker with resolver off. Exact-boundary assertions use controlled inputs to the internal time classifier in a rollback-only SQL test, with real trigger integration separately asserting saved O/S/instant relationships; no production clock override. Two-session tests cover clamped receipt before transfer (including transfer between receipt and shared-lock acquisition) and receipt after transfer. Health counts must include assigned-but-clamped/old rows. Rehearse disabling only the resolver, forged inserts while disabled, unrelated updates and re-enabling; the independent guards and F1 capture must remain active.

Rehearse rollback to old app with new schema/switch off. Run RELEASING smoke items: owner/staff/kiosk/CS navigation (also manager); kiosk clock in/out; record event; verify/undo; completion/dispatch stock deducts once on retry and concurrency; safe staging Shopify lookup; shipments, CS cases/returns open/save; Dashboard/Reports load without console errors; digest fixtures still group by work type. Existing inventory races must be reported and assigned to production-write-safety, not silently fixed or marked passing under F5.

## Hardening

### 1. Failure modes

Network/Supabase failures remain visible failed saves. Admin retry keeps request ID and input. F5 adds no offline queue to main; F6 must durably retain pending scans. Resolver errors/contention/configuration gaps save explicit missing attribution without changing worker credit or physical workflow. Schema errors, RLS denial, database outage, statement cancellation and other triggers can still reject inserts; no optional trigger can guarantee database availability. No new Shopify/Dropbox/Make/Slack dependency; existing outages follow existing paths. Never guess malformed input or rescan physical work merely to repair a department snapshot.

### 2. Data correctness

Stable Auth IDs, exclusion constraints, serialized mutations, historical names and frozen event fields preserve credit. Manual admin changes are audited separately from client-reported scan time; no inferred departments. Counts/quantities/routing/ledger remain unchanged, with F1 owning shared counting. UTC storage; display explicit site zones AU Australia/Sydney, UK Europe/London, US America/Chicago and label global effect. F8 uses approved 04:00 local days/Monday weeks. Client timestamps remain an attribution limitation: small forward skew uses an explicitly marked receipt bound; large forward skew gets no department credit; old reported times retain historical credit with a warning, not verified clock accuracy.

### 3. Security

Authenticated/owner-checked validated RPCs, owner-only new table reads, explicit grants/RLS and qualified definer SQL are required. Receipt replay never bypasses authorization. Audit is append-only via internal functions. No secrets or extra rate/profile exposure; no provider spend/email/spam path. Bound page sizes, inputs and mutation lock waits. Existing broad event visibility is a documented limitation, not a new assignment-directory grant.

### 4. Release and rollback

Staging first, then CJ's **single batched release**, never per-feature deployment. Gates: approved spec/plan/review, green CI, migration reservations/catalog reconciliation, supplied roster, CJ's production identity parity reconfirmation, passing matrix and recorded rollback target. CJ backs up/applies additive schema with resolver disabled; validates old clients, seeds only approved departments/homes effective now, enables via owner RPC and releases the batch per RELEASING. No new environment variables/cron/provider settings. Preserve digest-auth protection when choosing rollback target.

Release notes must list installation of `btree_gist` in `extensions` (available 1.7 but absent on supplied staging check), the production availability/privilege check, new time markers/bounds and deferred UI/read scope. Keep the extension on rollback.

Owner database switch disables resolution without deployment; resolver writes `disabled` while independent guard clears supplied snapshots. Team retains a small switch/status control; the health panel is deferred. CJ has dashboard/RPC instructions if UI is unavailable. **Emergency design: independent sanitizing guard**, not column-grant changes. If resolver code cannot reach the switch, CJ disables only the named F5 resolver INSERT trigger; the earlier guard still ignores all supplied F5 values and saves `resolver_unavailable` with server receipt/reported time and no department references. The UPDATE preservation guard also remains active. No grant revokes or table-wide trigger disabling. The implementation plan must deliver `docs/runbooks/departments.md` with exact named disable/enable statements, guard-order/catalog checks, forged-payload verification, outage recording and recovery steps, rehearsed by CJ in staging before release. Re-enable only after staged repair. Never bypass RLS, F1 or inventory triggers.

App rollback leaves tables/history/audit/snapshots intact; keep healthy resolver enabled or disable for attribution defects. No down migration, backfill, dropped columns or backup restore to remove F5. Any future correction overlay uses retained evidence under separate approval. Agents never touch databases, apply SQL, merge or deploy.

### 5. Performance

Indexed assignment/name lookups for one worker, no event-history scan or external call per insert/person. Shared locks allow parallel scans and try-lock returns immediately; rare admin writes serialize. Add an index on server receipt time for bounded operator health counts/latest success; query all statuses in that range so assigned time anomalies are not omitted. Event-detail queries use keyset paging. Index person/department/time and request lookups. Test two years/three sites, 100k synthetic assignment/name rows and representative events; target added resolver p95 <20 ms in staging, compare baseline and F1 combined timings before activation.

### 6. Operations

**Required in F5:** saved attribution/time markers, the owner switch and runbook SQL that CJ executes with operator privileges. Queries report switch/tracking start, last-24h attribution-status counts, separate `future_clamped`/`reported_old`/`invalid_time` counts (including assigned rows), affected event IDs/sites with O/S/resolution instant, last assigned event and queried-at time. Query failure is unavailable, never zero missing. **Deferred:** Team health panel and its query RPC; when added, it must show these same counts and time warnings. No remote station-health alerts (CJ deferred). This keeps diagnostics without adding an unused F5 dashboard.

Persisted markers are the diagnostic record; sanitized database warnings contain error category/event key, not customer data. CJ checks the health queries at activation and during the first 30 minutes, and when investigating attribution/clock complaints. Recurring resolver failures: disable resolution and check logs; old/clamped timestamps: inspect tablet clock and retain evidence, never rewrite saved credit. Staff use existing station flow. Monitor unknown rate, unassigned-account count (not a worker count), contention, history/receipt growth and F1 capture health. Retain evidence until separately approved retention policy; no new expiring tokens. Failed saves require supervised reconciliation; never label them saved.

### 7. Tests

- Vitest fixtures: half-open assignment/name boundaries, gaps/overlaps, normalization/Unicode/control characters/limits, UTC/DST display, status coherence and skew thresholds. Repeat temporal/name fixtures in SQL; database is authoritative.
- SQL assertions: exclusion/unique/check constraints, historical labels, removed identity, legacy NULL preservation, frozen fields, direct role/site/grant bypass and definer execution. Failure injection uses disposable synthetic staging fixtures.
- Two-session scripts: owner/owner transfers, archive/transfer, rename/insert, assignment/insert, removal/insert, removal/assignment (absent profile cannot regain an assignment), duplicate request/lost response and same event ID replay. Assert exact result/audit cardinality and no F5 inventory writes.
- Component tests: retry/conflict/error/empty/archived states, pagination, auth cache clearing, Dexie guard; main/Team/Station payload fixtures cover all insert sites.
- Work-type routing, verification/cancellation, count consumers and inventory/retry regressions; combined F1 capture JSON and rollback tests. Expose pre-existing stock failures as separate release issues.
- Implementation gates: `npx tsc -b`, `npm run test -- --run`, `npm run build`, `npm run typecheck:digest` (api is outside tsc -b), append-only CI and human staging evidence. No tests/build/database calls run for this documentation-only task; these gates are not claimed passed here.

## Roadmap decisions honoured

| Approved decision | Treatment |
| --- | --- |
| F5: Max/any super admin (owner) creates, renames, archives, assigns | Owner Team flows and checked transactional RPCs; no new role. |
| F5: one home per person | Global non-overlapping intervals, atomic transfer; unconfigured accounts remain visible without blocking scans. |
| F5: event saves department at that moment | Server resolves historical assignment/label at reported occurrence, with explicitly marked receipt bound for small forward skew; delayed sync uses retained history. |
| F5 / cross-cutting 2: departments differ from work types | Separate tables/fields, unchanged legacy column/four routing values, no mapping restriction. |
| Cross-cutting 1: production live/release safety | Expand-only, old-client tests, staging window, no-deploy switch, CJ batched release and preserved rollback data. |
| Cross-cutting 5: never lose/misattribute scans | No guessed worker/home; explicit resolution failure, visible insert failure; F6 owns queue/replay. |
| Cross-cutting 6: automations fail safe | Nonblocking optional resolution; unknown department permits production to continue. |
| Cross-cutting 7: history correct | Frozen snapshots, temporal names/assignments, no retroactive credit/backfill. |
| ROADMAP-REVIEW F5 / 7–8 | Unknown history stays unknown; Auth identity retained; supplied staging identity verification acknowledged; CJ reconfirms production parity. |
| Related F6/F7/F8 decisions | Original offline scan time/stable worker and clock-health hand-off; manual evidence distinct; retain facts for F8's owner/site/self/operational scopes, defer new non-owner reads, no new CS performance access. |

## Risks and open questions

Approval record (2026-11-22): CJ asked Codex to continue the pending work and approvals without overengineering. Following planner review, Codex approves the existing design for implementation: global homes, effective-now changes, the inclusive five-second forward clamp and greater-than-five-minute past warning, archive blocked while assigned, and unchanged routing. Use the current `feature/departments` main-based checkout; integrate #8/#10 later before combined acceptance. F5 reserves 0052–0054; F1 owns 0034–0046, F4 owns committed 0047, and F3's uncreated files reserve 0048–0051. Recheck reservations before creating or applying files. Scheduling a staging window and supplying the real roster are execution/activation requirements, not reasons to block pure implementation. No SQL, deployment, paid service change or production access is approved here.

The following records the original decisions and remaining release inputs; items 2–4 are settled for implementation by the approval above.

1. **Initial departments/worker roster missing:** Max/CJ must supply actual names, Auth-person assignments and worker versus shared-login classification. Recommend staging validation then prospective enrollment, no historical inference; unassigned capture remains visible. No real names or assignments are invented.
2. **Integration base/release sequence:** approve a base containing #8/#10. Recommend CJ's prepared integration branch until the batch is ready, separate Team component/server capture, no F1 stack. Reserve migration number/window with F1/F3/F4 at implementation. PR statuses, unpushed 0046, staging trigger installation and tighter live grants are supplied discovery evidence, not live verification in this task.
3. **Global scope/effective-now/skew policy:** approve global home, no backdating/scheduling, a **five-second inclusive forward clamp to receipt** and a **strictly greater than five-minute past-time warning without withholding credit**. These are proposed bounds, not measured fleet-clock guarantees. Both anomalies remain countable; F6 must distinguish queue delay from faulty clocks. Archive requires reassignment; returning people need explicit enrollment. Different bounds change the contract/tests.
4. **Framing-line scope still unsupplied:** recommend collect for F6 and leave routing unchanged in F5; no unapproved mapping prerequisite.

Release risks with assigned follow-up, not reopened settled questions: CJ reconfirms production Auth/FK/grant parity; implementation proves function visibility/concurrency and old update compatibility; F1 coordinates missing-control failures; F8/history-correction owns broader event visibility/deletion; production-write-safety owns pre-existing stock races. F5 does not authorize those redesigns. Unknown history and department/work-type separation are settled.
