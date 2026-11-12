# Roadmap review

Reviewed by the planner for CJ on 2026-11-12. Source baseline: `556b5f9ad9c9d6988b5a2b87e1da7103f02cfafe` (`main` after PR #4).

This reviews every item in [ROADMAP.md](ROADMAP.md) against the checked-in implementation, [ARCHITECTURE.md](ARCHITECTURE.md), [HARDENING.md](HARDENING.md), [AGENTS.md](../AGENTS.md), and [WORKFLOW.md](WORKFLOW.md). The **CJ decisions and follow-up evidence** section records CJ's subsequent answers on 2026-11-12. Those answers supersede the corresponding initial questions, including the original wall-display requirement. Other recommendations remain proposals, not implementation approval.

Only this review is changed. No production Supabase account/database or live Make/Slack service was accessed. The staging connection was verified earlier in this chat; that does not establish schema parity, seeded test data or working Vercel Preview settings. After the initial review, CJ supplied six local Make exports and a local Dropbox preview folder. The follow-up below records read-only inspection of those files; exported configuration is not proof of current live behavior. Raw exports, identifiers, credentials and image assets are not copied into this repository.

## CJ decisions and follow-up evidence — 2026-11-12

Superpowers skills were already installed in the local Codex skills directory. The planner read `using-superpowers` and its Codex reference, and used the review/brainstorming guidance to verify supplied evidence and distinguish approved choices from missing facts. This is documentation follow-up, not a feature design approval or permission to implement, merge, deploy, or change an external service. ROADMAP.md remains unchanged under the existing single-file scope; future specs must carry these CJ-approved amendments into their brief.

### Decision register

Question numbers refer to the initial questions preserved later in this document.

| Item / questions | CJ-approved decision or supplied fact | Still needed / limits |
| --- | --- | --- |
| F1 / 1–2 | Use the recommended count: once per site/work type/report period after qualifying completion, with the overall order total deduplicated; report rework separately. Count supported print/frame pieces and flag incomplete historical detail. | Canvas eligibility was not supplied by “use recommendation”; do not add it silently. The decided gift/free/accessory exclusions remain. |
| F3 / 3 | Inspect `C:\Users\cjgom\Dropbox\Packing Slip Previews`; local evidence is available, findings below. | Reuse and a composite for sets remain the planner's recommendation; providing the folder did not explicitly approve the composite choice. Current revision selection and canonical keys still require design. |
| F3 / 4 | Immediate background processing, a placeholder while pending, visible failure status, and a two-minute target under normal service conditions. | This is a normal-service target, not a promise during provider outages. |
| F4 / 5–6 | Test Max's examples before activation. Deduct packaging once at the final packing point, including replacement packaging; unresolved rules flag the order without blocking completion. | Max's actual box/rule table is still missing. Approval of the process is not a supplied rule set. |
| F5 / 7–8 | Preserve unknown historical departments rather than applying today's assignment retroactively; retain the recommended distinction between managed departments and fixed work types. | Initial department names, person assignments, framing-line scope and whether every badge user has an Auth identity remain unprovided. |
| F6 / 9 | Three shared Bluetooth scanners connect to one Android tablet. **No wall display and no monitors.** No scanner model has been selected; CJ described any wireless scanner. | “Any” is a preference, not verified compatibility. Require configurable per-scanner prefixes/suffixes, Android pairing and collision tests, reconnection/reboot behavior, range and battery verification. Browser/model details remain a rollout gate. |
| F6 / 10 | Badge required at every handover, after 15 minutes of framing-scanner inactivity, and after receiver restart. This does not clock the person out of attendance. | Per-scanner capture and UI still need design; a software timeout cannot detect every unannounced handover. |
| F6 / 11 | Persist offline captures locally, keep them visibly pending until validated, and use supervised recovery after device failure. | Never credit guessed identities/quantities; local browser storage does not guarantee survival of device loss or storage erasure. |
| F6 / 12 | Alert coverage is 08:00–18:00 in each site's own timezone. CJ separately confirmed the existing zones: AU `Australia/Sydney`, UK `Europe/London`, US `America/Chicago`. | Workdays/holiday exceptions and alert recipient/channel remain unprovided. Five minutes without a heartbeat remains the recommendation; the hours-only answer did not explicitly approve the threshold. |
| F7 / 13 | Authorized dispatchers may manually assign a framer with an audit record. Unknown attribution remains a visible warning and does not block dispatch. | Apply the separate shift-length dispatch session; no fabricated scan time or duplicate credit when real evidence arrives. |
| F8 / 14–15 | Owners see all sites; managers assigned sites; staff their own performance; kiosks operational confirmations; CS only explicitly granted access. Use 04:00 site-local production days and Monday-start weeks, with the confirmed timezones above. | Role/site enforcement, summary export parity and DST tests remain implementation acceptance criteria. |
| F9 / 16 | Proportionally scale fallback time for verified partial shifts and display measured and estimated results separately. | Max's actual size weights remain missing. Approval did not validate the existing weight values or authorize assuming a full shift when attendance is unknown. |
| F10 / 17–18 | Main order-to-ship metric uses complete shipment, with partial shipments visible separately. Max supplies lateness deadlines, cutoffs, holidays and exclusions. | Shop-to-site mapping and actual lateness values are still missing. Do not treat the app's single-shop configuration as proof of all three sites' arrangement. |
| F11 / 19–20 | Use explicit versioned batch mappings and replay from durable records; missing evidence remains missing. CJ supplied exports for all six parts. | The exports answer when the initial batch ID exists and identify recovery candidates; they do not prove a complete retained event log for every stage. Details below. |
| F12 / 21–23 | Infer printing only for the evidenced order and show partial batch evidence. Use a verified interaction endpoint and explicitly authorized users, tested in staging. Preserve earlier inference separately from a late confirmation's actor/time. No reminders initially. | Slack app ownership, workspace and exact authorized users are still unprovided. Part 5's existing text-only post is not an interactive app configuration. |

### F3 evidence: preview reuse is feasible, with mapping limits

The supplied folder contains **605 JPEG files** and `packing-preview-index-v1.json`. The v1 index contains **583 artwork/component keys**, referencing **565 distinct hashes**; every referenced `<hash>.jpg` exists locally. The index includes **181 set-component keys** and **21 entries with more than one candidate hash**. Presence is not proof of complete current catalogue coverage, freshness or image validity for every file.

The index's declared `data_sha256` matches the serialized entries. The planner visually inspected one single-artwork preview (`INKA-ABS0007`) and both components of `INKA-S2-BAU0055`; these samples contain artwork, not customer/address/packing-slip information. They are individual component images, not a prebuilt set composite. Do not extend the sample inspection into a claim that every file was visually checked.

Part 6 modules provide the reuse contract:

- Module 3150 loads `/Packing Slip Previews/packing-preview-index-v1.json`; module 15 checks the version/entry hash and resolves preview candidates. For excluded-from-print products it requires exactly one candidate per component, rejecting missing or ambiguous previews.
- Module 3100 reads `/Packing Slip Previews/<hash>.jpg`. Module 17 validates the JPEG structure, dimensions up to 400 pixels per side, and size bounds.
- On a cache miss, modules 3102/3104 fetch source artwork and validate its Dropbox content hash. Modules 3106/3108 resize to a maximum 256-pixel side and convert to JPEG. Modules 3110/3113 validate and upload the preview under the source hash.
- A set component key such as `INKA-S2-BAU0055-01` differs from the app's canonical set key `S2BAU0055`. Group and order all expected components explicitly; never select the first hash or component as if it represented the complete set. Multi-hash entries need authoritative revision evidence.

Recommended F3 refinement: reuse verified component JPEGs as the initial artwork source, create the proposed set composite where appropriate, and store the selected version in Supabase Storage as already decided. Preserve all four auto-generation triggers and source-replacement handling. The cache and index do not establish an automatic, unambiguous mapping for every new/replaced artwork. The two-minute target is now approved; the composite presentation remains a narrow open choice.

### F11 evidence: batch identity exists before Part 3

The six supplied exports were parsed locally. Relevant modules establish the following:

| Part | Export evidence | Consequence for the spec |
| --- | --- | --- |
| 1 | Module 4 creates `batch_id` from the supplied stamp plus a random UUID fragment, builds the accepted order list, and excludes already-logged orders. Module 6 persists order name, queued status/time and batch ID. History lookup checks AU/UK/US by displayed order number. | **The initial batch ID and accepted membership already exist in Part 1.** Close the initial uncertainty about having to wait for Part 3. Send accepted orders, not skipped/malformed inputs. Re-executing the generator can create a new ID, so recovery must use the stored identity rather than regenerate it. Cross-shop order-number uniqueness is still unverified. |
| 2 | Module 24 records order/SKU/file path/quantity and batch ID; module 29 records the Shopify legacy order ID and processing status/time. There are separate failure and excluded-from-print paths. | There are candidate order/file mapping records. A generic `done` flag is not proof that every requested file was found; distinguish partial, excluded and failed outcomes. |
| 3 | Module 3 carries the input batch ID into the folder/roll plan. Module 7 records planned placements and timestamp; module 12 writes roll records with batch ID/root. | Preserve the initial batch identity through planning, and attach membership/plan revisions for retries or later changes. |
| 4 | Module 9 updates roll status to cut and writes `now` to the same numbered column populated during planning. | Mutable sheet state cannot reconstruct the original planning event time reliably. CJ's instruction not to change this behavior remains in force. |
| 5 | Module 1302 verifies completed-folder contents and roll counts before producing an images-ready message, with a deterministic message key. Module 34 sends the resulting text to Slack. | Reuse verified completion evidence, not merely entry into Part 5. A message key is useful evidence but not proof of a durable milestone log or exact retained transition time. |
| 6 | Stable production job keys, attempt counts, included/excluded/pending orders, report/manifest records, READY JSON files and Packing Slip Activity event keys are present. Module 44 publishes the report JSON; module 33 updates the durable job record. Retry logic limits which excluded orders may be retried. | These are concrete reconciliation sources for packing-slip readiness and partial results. Use their attempt/order detail, preserve missing event times, and do not claim they recover earlier Parts 1–5 transitions automatically. |

The supplied Part 6 export explicitly contains AU-specific paths/validation. Do not assume it demonstrates equivalent UK/US deployments. Before F11's plan, define retained source, event time, replay key and partial-success semantics for each of the five reporting steps. No supplied export was executed, imported, modified or uploaded.

### F12 evidence: the Slack post currently has no button

Part 5 module 34 is `slack:CreateMessage`, receiving `{{1302.result.text}}`. Its mapper has no Block Kit `blocks` or interactive button. It references a Make connection; that reference does not reveal an installed app's signing-secret ownership, Interactivity Request URL or authorized users. F12 therefore still needs app-ownership/configuration evidence before specifying exact delivery wiring. Inspection did not contact Slack or reveal connection credentials.

### Remaining inputs after CJ's answers

These are narrower than the original 23 questions; approved decisions above should not be asked again.

- **F1:** explicit canvas eligibility if canvas is in scope.
- **F3:** accept or replace the recommended set-composite presentation; current-source selection for ambiguous index entries is a technical design task.
- **F4/F5/F9:** Max's box rules/examples, initial departments/assignments and framing-line scope, and approved size weights. Badge-user identity compatibility needs staging-only verification before schema design.
- **F6:** actual scanner/tablet/browser details and a successful hardware trial; alert recipient/channel, workdays/holiday exclusions, and confirmation of the proposed five-minute heartbeat threshold. The hours, timezones, Android/Bluetooth choice, no-monitor constraint, idle timeout and offline policy are settled.
- **F10:** shop/site mapping and Max's late-order thresholds/calendars.
- **F11:** per-stage retained evidence and replay/time contract. Initial batch identity is now established from Part 1; live retention and non-AU deployment parity are not.
- **F12:** the posting Slack app/workspace owner and exact confirmation permissions. Order-level inference, separate late confirmations and no reminders are settled.

### Local evidence provenance

Exports were read from CJ's Downloads directory; only filenames and fingerprints are recorded for reproducibility. No raw export, customer data, credential, webhook address or provider connection identifier is included here.

| Supplied file | SHA-256 |
| --- | --- |
| `Part 1 - Get Orders v5.blueprint (5).json` | `4878c05de16234c78631891cfa2d814f31d2561a1d6f9a8cf7448d1d58a6d9b8` |
| `Part 2 - Process Products v5.blueprint (3).json` | `fa6487d7b9233dda0d90f54c48def9321a1a86bf6a3ea7491f428084aa34fa5b` |
| `Part 3 - Plan Rolls & Copy v7.blueprint (4).json` | `40317cf1c7a1cc94b2f978b048df296a6815d9db0d6731d85d3ab28812399c5d` |
| `Part 4 - Cut Sequence v5.blueprint (3).json` | `8f66ce50393f629a37941eeb2bec2969935e78df7a19988948fd1e90b5eb04e4` |
| `Part 5 - Floor Placement v6.blueprint (3).json` | `4732228ac7e9d23c776f9c6ae8fbecfcfafda45df89515d748a5c68b78e453e5` |
| `Part 6 - Folder First (LIVE AU).blueprint (1).json` | `45a6e33ee1e771a01c64865be875604ad6608a4ef114d6c975f13dfdea1dd26a` |
| `packing-preview-index-v1.json` | `840db6dd77808db80e979999009bd83065c2c5db25a0828906d2fec3377b6420` |

## Overall assessment

The roadmap is coherent, but the size labels and dependency board understate the work around reliable event capture, attribution, external ingestion and historical reporting. Do not implement it as twelve independent UI changes.

The highest-impact findings are:

- F1 needs a shared event-counting contract, not only a change to SKU eligibility. Current screens disagree about cancellations, repeated orders, reporting days and eligibility after reload.
- F3 is a thumbnail production pipeline with four triggers, durable retry, revision handling and launch backfill. The existing code is a temporary-URL cache. Client and server set-artwork keys disagree.
- F4/F6/F7 need a shared, authorized, transactional and replay-safe write boundary. Completion and inventory deduction are currently separate calls; the deduction RPC does not enforce caller/location authorization and its existence check can race.
- F5 must add business departments alongside the existing work-type field. Replacing the current four-value enum would break routing, historical events and old code.
- F6 cannot obtain per-scanner identity from the current one-worker/one-buffer page. Prefixes and delimiters help reject malformed input but do not, on their own, prove that concurrent keyboard streams cannot form a plausible wrong scan. Hardware acceptance is a release gate.
- F10 needs shop/order/line/fulfillment identity and durable milestones before its reporting UI. F11 needs a stable batch-to-order mapping and a recovery source when an ignored HTTP call is lost.
- F12's first-order fallback proves that at least some batch printing happened. It does not prove that every order in the batch was printed, or give the exact print time. Preserve that distinction.

## Evidence map

These are the main code paths inspected; line references are at the baseline above.

| Area | Evidence and current behavior |
| --- | --- |
| Counting | [SKU helpers](../src/lib/domain/skuRouting.ts#L704), [Reports reducer](../src/pages/Reports.tsx#L152), [Welcome](../src/pages/Welcome.tsx#L100), [Production counter reload](../src/pages/Production.tsx#L422), [digest aggregation](../api/reports/daily-digest.ts#L200). |
| Production capture | [Production](../src/pages/Production.tsx#L198) has one active person; `insertEvent`, `handleCompleteOrder`, `processScan` and the keyboard effect own writes, completion and input. |
| Identity/schema | [station config](../src/lib/state/productionStation.ts), [domain event schemas](../src/lib/domain/schemas.ts#L723), [0012 production tables](../supabase/migrations/0012_production.sql), [0022 verification fields](../supabase/migrations/0022_production_verify.sql), [TeamMembersCard](../src/components/TeamMembersCard.tsx). |
| Packaging/stock | [routing and package helpers](../src/lib/domain/skuRouting.ts#L533), [completion write sequence](../src/pages/Production.tsx#L950), [0031 deduction RPC](../supabase/migrations/0031_order_based_idempotency.sql). |
| Artwork | [ProductImage](../src/components/ProductImage.tsx), [artwork endpoint](../api/dropbox/artwork-image.ts), [0024 cache migration](../supabase/migrations/0024_artwork_images_cache.sql), `artworkCodeFromSku` in the SKU helpers. |
| Reports/history | [Reports](../src/pages/Reports.tsx), [paging helper](../src/lib/repository/supabase/pageThrough.ts), [shift helper](../src/lib/domain/shifts.ts), [benchmark settings](../src/components/ProductionBenchmarksCard.tsx). |
| External data | [Shopify order lookup](../api/shopify/order.ts), [Vercel cron configuration](../vercel.json), [digest handler](../api/reports/daily-digest.ts#L492). There are no checked-in Shopify/Dropbox change receivers, Make milestone receiver or Slack interaction receiver. |

## Item-by-item review

This retains the original baseline analysis. Apply the decision register above when a recommendation/question below has since been answered; targeted evidence updates are noted where relevant.

### S1 — digest-auth

**Understood:** protect every digest path with `CRON_SECRET`; retain the configured default recipient and restrict overrides to an allowlist. Downloads and diagnostics require the same credential.

**Current code/conflicts:** the handler on this review's `main` is still unguarded. The fetched `origin/feature/digest-auth` branch at `23913d0` contains the approved spec, implementation, tests and an r1 review. Its review distinguishes source approval from release clearance. It is not merged into this baseline; do not infer deployment or CI success from the branch's existence. No other PR is authorized for merge here.

**Risks/dependencies:** F1 will change the same digest module and must preserve S1's guard, error precedence and no-work-on-rejection tests. Production configuration must be set by CJ before deploying S1. Rolling back to an unguarded version reopens the leak.

**Suggested split:** keep the existing `digest-auth` spec and plan; finish their verification/release gates rather than rewrite the approved requirements. Carry the new hardening checklist into the release review. No new product decision is needed for S1.

### F1 — item-counting

**Understood:** count orders separately from eligible physical pieces; `2 × INKA-S2BON0064-A1-UN` is four items and one order. Include unframed prints, retain the exclusions, recompute historical reports, and use one shared rule everywhere named in the roadmap.

**Current code/conflicts:** `isKpiEligibleSku` excludes UN; `kpiUnitMultiplier` already multiplies sets. Reports derives order sets from `line_verified`; Welcome/digest use terminal events for orders. Production reload counts completion rows and sums verification quantities without applying the item eligibility test, while its immediate verification increment does apply it. Welcome does not fetch cancellation parents. A predicate-only patch will leave visible inconsistencies. Reports' timing is coupled to item eligibility, so adding UN can accidentally turn unframed activity into frame-time samples (F9).

**Risks/missing decisions:** decide what qualifies as an order completion, how repeat/replacement work is represented, and how legacy/unparseable lines are reported. Keep physical stock deduction separate from KPI multiplication to avoid multiplying stock twice. Cross-period cancellations need a defined effective-event lookup, not only cancellation rows fetched inside the displayed period. Historical records without sufficient line detail must show incomplete coverage rather than invented quantities.

**Suggested specs:** `item-counting` for the pure SKU/quantity contract plus a shared effective-event reducer and integration in all four consumers; `report-periods` for common site/day boundaries, shared with F8. Preserve the planned historical-total change and release note. Questions **1–2**.

### F2 — order-display

**Understood:** large title, framed/unframed label, bold size and unmistakable black/white/natural colour blocks at one metre; reserve thumbnail space before F3, then frame the image in that colour.

**Current code/conflicts:** the live line list already has `ProductImage`, SKU-derived labels and `variantChipClass`, but uses small text/chips; it is separate from the older `LineCard`. Change the rendered path, not just the legacy component. Unknown SKUs use Shopify text fallbacks. A colour block must not turn an unknown or unframed line into an apparent frame colour. F6's scan confirmation is a different view from a detailed order card; CJ subsequently removed the separate wall display.

**Risks/missing decisions:** validate physical legibility on the actual Android tablet from F6, in both themes. Retain written colour labels and neutral placeholders; colour alone is insufficient. Long titles, mixed orders, orientation, gallery walls and missing images must not hide quantities or warnings. Confirmations/errors must work on the tablet itself; there will be no monitor.

**Suggested specs:** one `order-display` spec, independently releasable with the reserved image area; F3 supplies the image source later. No additional product question; device details are covered by question **9**.

### F3 — artwork-thumbnails

**Understood:** one permanent Storage thumbnail per canonical artwork code, shared across variants; automatic Shopify, Dropbox, on-demand and scheduled triggers; one launch backfill; automatic refresh on file replacement. Inspect Make Part 6 previews before choosing the source.

**Current code/conflicts:** `ProductImage` caches by full SKU and keeps missing/expired URLs for the tab session. The server searches Dropbox and stores temporary URLs, not thumbnail files. Client `artworkCodeFromSku` returns `S3WIL0049` for a set; server `artworkCodeFromQuery` produces `S3-WIL0049-01`. Free-print key conventions also differ. `artwork_images.dropbox_path` is required, so adding only a nullable Storage path does not permit a brand-new pending row without a source path. Keep unresolved jobs in a separate durable queue or explicitly design compatible schema expansion. Existing cache mutation RPCs are definer functions callable directly; an API guard alone does not protect them.

**Risks/missing decisions:** a new Shopify variant may arrive before its Dropbox source; immediate creation cannot be guaranteed then. Use a visible pending state and retry automatically. Coalesce jobs by artwork and source revision, prevent an older job overwriting a replacement, and use versioned object paths/cache invalidation. Bound image dimensions, payload sizes, concurrency and provider calls; failed image work must not block scans. Keep old URL columns/read fallback for rollback, with new Storage access policies. A private bucket is the proposed default, not an approved privacy decision.

Dropbox notifications identify accounts with changes, not individual changed files; signed notifications need a cursor-based folder reader. Shopify delivery authentication and duplicate handling are required. See the official references below.

**Suggested specs:** `artwork-source-contract` (Part 6 evidence, canonical keys, set representation); `artwork-thumbnail-store` (generation, versioning, client and on-demand path); `artwork-thumbnail-ingestion` (all change triggers, durable retry and safety scan); `artwork-thumbnail-backfill` (resumable launch job and coverage gate). Earlier slices may be tested separately; F3 is complete only when all decided triggers and launch coverage work. Questions **3–4**.

### F4 — box-auto-pick

**Understood:** remove mandatory box scanning at every station; predict and deduct packages from order contents using admin-editable rules; permit a one-tap dispatch override; preserve old scan paths for rollback.

**Current code/conflicts:** `PACKAGE_TYPES` and tube IDs are hard-coded. `OrderActionBar` blocks A0, dispatch and unframed without a package. The UI's blocking rule is not identical to `stationRequiresPackages`. Stock is deducted after a completion event in a separate RPC. `0031` keys deductions by order plus supplied code, so a changed box can consume both old and new codes, while an increased quantity of the same box can be skipped. It also has a concurrency race and does not check caller/location permission. It cannot safely implement corrective packaging changes as-is. F6's no-tap completion cannot depend on a missing box scan or rules decision.

**Risks/missing decisions:** Max must supply positive and negative rule examples, precedence, capacity, mixed sizes/sites, quantity multiplication, multi-box and replacement handling. Rules require versioned snapshots; later edits must not recalculate historical stock. Distinguish packing prediction from the physical packing action, especially A0 orders that currently finish without dispatch. CS events currently skip the entire deduction RPC, including packages: decide who owns replacement packaging. When no rule matches, do not silently invent a package or deduct one.

**Suggested specs:** `production-write-safety` as a prerequisite shared with F6/F7; `box-rules` for owner-managed, versioned rules and simulator; `box-auto-pick` for packing-point application and auditable override/delta reconciliation. Test repeated/concurrent saves, stock shortages, reversals and old-client rollback. Questions **5–6**.

### F5 — departments

**Understood:** owners create, rename and archive business departments, and assign each person one home department. New events retain the facts at the time. Work types remain the four fixed routing values.

**Current code/conflicts:** `production_events.department`, station settings, routing, benchmark keys, report groupings and SQL CHECKs currently mean work type. There is no managed-department table, home assignment or event snapshot. Team data uses Auth IDs; comments about barcode-only people are not proof that deployed constraints support them. `ProductionEventSchema` also lacks verification/clock types and newer fields present in migrations/page-local types. Reusing that schema unchanged would reject or discard new capture data.

**Risks/missing decisions:** add stable business-department IDs and historical label/assignment snapshots while retaining the legacy `department` work-type column. Archive rather than delete; do not backfill old team membership from today's assignment. Old clients should still write valid rows, with missing historical team identified explicitly. Home department and permission to perform a work type are separate. A mapping may support several work types but must not silently reroute mixed orders. Store the assignment effective at scan time so offline sync after a transfer does not move credit.

**Suggested specs:** `departments` for owner administration, one home assignment and mapping; `event-attribution-snapshots` for compatible fields, effective-time resolution and legacy reporting. Production-only persistence can remain Supabase-specific if the spec explicitly states that scope; any Repository change still requires both adapters. Questions **7–8**.

### F6 — scanner-stations

**Understood:** three shared scanners feed one tablet; badge identity is per scanner; an order slip saves all applicable framing lines without taps. Persist offline captures, retry without duplicate credit, give visible/audible outcomes, preserve kiosk access and detect unhealthy stations. Support additional receivers later.

**Current code/conflicts:** Production holds one `activeStaff`, one station work type, one current order and one keyboard buffer. `processScan` returns immediately while busy. Input is ignored in editable fields, a 200 ms gap can submit data, and eight hexadecimal characters can trigger badge handling before a complete frame. It adds a `10` prefix to some order numbers. Badge sign-in uses a confirm dialog; cancelled/repeated/CS work can show preflight dialogs. These contradict framed, scan-only input. Shopify must currently respond before order lines exist. The event key is random per attempt; local verification uses order plus SKU rather than Shopify line ID. The same SKU on two lines can collapse. There is no durable scan outbox or per-scanner lease.

**Risks/missing decisions:** scanner identity must be preserved by the actual receiver hardware, not inferred from the current person on the tablet. An accepted scan needs a durable envelope with stable capture ID, scanner/receiver/site, bound worker and assignment version, event time, receipt time, payload and validation state. Queue before starting slow work; do not use a React busy flag as a queue. Resume after reload and lost acknowledgements, preserve ordering within a scanner, and prevent two receiver tabs draining the same record twice. Store only necessary customer data. Unknown offline orders remain pending validation; never credit a guessed worker or fabricate line quantities. Validate cancellation/site/order version again on sync and surface conflicts.

Strict framing rejects malformed input, but delimiter-only keyboard multiplexing cannot guarantee correct attribution under every collision. Bench-test simultaneous scans with the chosen models/receiver; if valid-looking corruption remains possible, require hardware serialization or a transport retaining scanner identity before rollout. The requirement is unchanged; this is a feasibility gate. Software cannot detect a new person holding a still-active scanner without a badge scan. Timeout, visible names and the badge-on-handover operating rule reduce that risk but cannot prove it absent.

Kiosk persistence in `client.ts` is an opt-in browser-storage mode, not OS auto-start or a guarantee that sessions never expire. Screen wake, sound activation, focus loss, reboot and receiver reconnect require device-specific testing. A scanner read beep is not proof of database acceptance. With CJ's no-monitor decision, confirm that workers can see the tablet or hear application error feedback from their benches; the tablet is the only specified display. Health checks must distinguish a live idle receiver from a failed one. Hours/timezones are now confirmed above; alert ownership and working days remain open.

**Suggested specs:** `scanner-hardware-protocol` (bench proof and purchase requirements); `scanner-sessions` (per-scanner identity/expiry/work-type binding); `scan-outbox-and-ingestion` (durable queue, server idempotency, validation and recovery); `scan-only-framing` (atomic multi-line capture and compatibility); `kiosk-health` (startup, tablet feedback and monitoring). Requires F1, F5 snapshots, production write safety and F4's nonblocking packaging contract. Questions **9–12**.

### F7 — dispatch-flow

**Understood:** a dispatcher identifies once per shift, then scans slips; each framed line shows its framer or a warning and quick manual assignment, with manual attribution visible in reports.

**Current code/conflicts:** dispatch currently shares Production's active person, station configuration and interactive completion path. Existing event rows identify order and SKU, not a stable Shopify line. A single order-level name cannot represent two framers, repeated SKUs or partial work. The per-scanner identity from F6 must distinguish the dispatcher who records an action from the framer being credited. Reusing a normal `line_verified` event for a manual name would fabricate a measured scan and contaminate F9/F12.

**Risks/missing decisions:** preserve actor, credited person, source (`scan` or `manual`), capture time and correction history separately. Define permissions and conflicts when a real scan arrives after manual attribution. F6's idle expiry and F7's once-per-shift session are different policies; apply the appropriate work-type policy without letting one scanner change another's identity. Historical framing absence must remain visible. Manual attribution must not bypass site restrictions, cancellation checks or packaging deduction idempotency.

**Suggested specs:** `dispatch-attribution` for line-level lookup, audited manual assignment and conflict handling; `dispatch-scan-flow` for the minimal station interaction and shared completion/packing transaction. Depends on F5, F6 and F4; contract work can start earlier. Question **13**.

### F8 — reports-v2

**Understood:** extend Reports with person/team summaries, day/week/month/custom periods, trends and summary CSV, while retaining usable performance over months.

**Current code/conflicts:** Reports already has person/work-type filters, ranges, raw CSV and timing, but these are not business departments. `pageThrough` has a maximum page count and can silently return an incomplete result; paging by timestamp without a stable tie-breaker also needs review. Loading all events into the browser for every summary will not satisfy two-year, three-site use. Current names come from current team records rather than historical snapshots. Reports can delete events and related ledger entries; this is incompatible with reliable history and replay suppression unless corrections retain an audit record. Removing a ledger row also does not restore physical stock automatically.

**Risks/missing decisions:** specify report visibility per role/location and whether a person sees their own results or the whole team. Do not expose payroll rates through new summary endpoints. Use UTC storage with site-local period boundaries; Welcome currently uses a 04:00 boundary while other views use different/browser-local ranges, and the digest has separate timezone arithmetic. Test DST and cancellations that cross a period boundary. Aggregate with indexed, bounded server queries or rebuildable summaries; ensure raw export and totals have explicit completeness/coverage. Historical department unknown must stay unknown. Provide a correction policy before treating deletable events as an audit trail.

**Suggested specs:** shared `report-periods` from F1; `production-history-corrections` for reversible, audited corrections; `report-aggregates` for authorized queries, indexes and reconciliation; `reports-v2` for UI, trends and summary CSV. Depends on F1/F5; manual/source fields from F7 must be understood, even if dispatch ships separately. Questions **14–15**.

### F9 — frame-timing

**Understood:** use consecutive framer-scan gaps, spread across the scanned pieces, excluding gaps over 30 minutes; use Max's 405 productive minutes per 450-minute shift and size weights when scan evidence is unavailable; label the method.

**Current code/conflicts:** Reports already computes gaps from verification events, with a 30-minute threshold, but F6 will emit several lines from one slip scan. Treating those line rows as separate scans gives the first line the gap and the others zero. Current grouping/filtering can also pair scans across days or lose the preceding scan outside the selected range. `shifts.ts` estimates attendance using clocks and activity with different break/silence logic; attendance duration and frame-cycle timing are not interchangeable. F1's newly eligible UN items must not enter framed-time denominators.

**Risks/missing decisions:** retain capture ID to group a whole scan, count pieces with F1, and use scan time rather than sync receipt time. Pair within the same worker/site/shift across scanners; do not pair different workers on one scanner. Exclude manual attribution, duplicate captures, invalid/reversed work and first scans without a valid predecessor. A gap is a production estimate, not proof of uninterrupted labour. Mark small samples and coverage. For fallback, snapshot weights and denominator: one consistent interpretation is unit minutes = `405 × sizeWeight / sum(pieceQuantity × sizeWeight)` for a full productive shift. The policy for partial shifts and partially measured work still needs approval; do not add a full fallback shift on top of measured time.

**Suggested specs:** `scan-gap-timing` for scan grouping, boundaries and measured coverage; `weighted-shift-timing` for Max's weights, partial shifts and explicit method labels. Depends on F1/F6/F8 contracts and F7's manual-source distinction. Question **16**.

### F10 — order-timeline

**Understood:** persist source-qualified milestones for Shopify and app stages, then show per-order history, site dwell times, order-to-ship median/P90 and current late orders. Replay must be safe, and later sources must fit without redesign.

**Current code/conflicts:** the Shopify endpoint is an authenticated, on-demand lookup using one configured shop; it is not a durable feed. Its GraphQL request takes the first 50 lines and first fulfillment, and line IDs are not in the output. The current carrier string does not supply delivered timestamps. Production mainly links by displayed order number and SKU. Reports' order lookup only sees app events, so it cannot list unstarted Shopify orders or calculate complete order-to-ship cohorts. Repeated order numbers across sites/shops and split fulfillments are identity hazards.

**Risks/missing decisions:** establish shop + immutable Shopify order/line/fulfillment IDs, site mapping, and display numbers as separate fields. Persist source event ID, event time, receipt time, evidence type and revision/correction linkage. Quarantine unmapped events; do not infer site from a worker's current location. Handle duplicates, out-of-order delivery, cancellation/refund, reprints, split shipments and unavailable carrier data. A dispatch scan is not proof of carrier shipment/delivery. Missing stages must not produce zero dwell, negative duration or fabricated delivery. Define cohorts, complete versus partial shipment, percentile meaning, late thresholds, business calendars and historical import coverage. Old app events can be linked only when identity is unambiguous.

Shopify delivery verification requires the raw request body and HMAC; delivery identifiers support duplicate handling. Validate the shop as well as the signature, acknowledge only durable acceptance, and reconcile missed events. These are ingestion requirements, not proof that the current store has the required subscriptions or permissions. See [Shopify webhook delivery guidance](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

**Suggested specs:** `order-identity-and-milestones` early, before F6 finalizes capture schemas; `shopify-order-ingestion` for signed events, pagination, backfill and reconciliation; `order-timeline` for display/app adapters; `order-flow-metrics` for dwell, shipping cohorts and lateness. Full UI can follow F6/F7; its identity contract cannot safely wait until then. Questions **17–18**.

### F11 — make-milestones

**Understood:** add one authenticated reporting HTTP step plus Ignore handler to Parts 1, 2, 3, 5 and 6; map batch events to orders and display missing data. Keep printing independent of app availability.

**Current code/conflicts:** there is no Make receiver or batch mapping in the repository. Follow-up inspection now confirms that Part 1 creates the initial batch ID and accepted order list before Part 3. Parts can still exclude orders or retry partial results, so initial membership must not be confused with successful membership at every later stage. A receiver cannot recover an event it never received, so idempotency alone does not solve an Ignore-handled failed request.

**Risks/missing decisions:** use stable source occurrence/run keys, explicit site/shop, batch membership version, source timestamp and schema version. Validate bounded payloads, caller scope and order mapping before crediting milestones. Accept out-of-order batch events durably and resolve only after mapping exists. Retry/reconcile from a retained Make log, manifest or other agreed recovery source; until recovered show missing. If no such source exists, report that limitation rather than promise eventual completeness. Rotate the hard-coded cancellation-registry token through CJ's separate manual task; do not reuse it for ingestion. Never publish secrets in payloads or Slack.

Part 4's `planned_at` overwrite remains untouched, as CJ decided. Store a source-qualified Part 3 planned event; do not later replace that fact by reading the mutable Part 4 value. Distinguish genuine replanning occurrences from retries.

**Suggested specs:** `make-batch-contract` for scenario evidence, identities and mapping; `make-milestone-ingestion` for receiver, source credentials, idempotency and recovery; `make-reporting-rollout` for the five step/Ignore changes and staging replay fixtures. F10's storage/identity contract is required; full F10 analytics need not block receiver development. Questions **19–20**.

### F12 — print-confirmation

**Understood:** Part 5 posts a batch button; clicking saves the actor/time once. Without a click, framing/dispatch evidence supplies an explicitly inferred stage. Late/repeated clicks remain safe. Nothing stops printing.

**Current code/conflicts:** no Slack interactivity handler, app manifest, batch membership or confirmation model exists here. A Make Slack message with blocks does not establish which installed Slack app owns interactions or where they are delivered. One order's first framing scan proves printing for that order, not completion of the entire batch. A dispatch event for an order containing only frame accessories proves no artwork was printed. Manual attribution also cannot supply a measured print time. This is a conflict requiring CJ's decision, not permission to silently redefine the approved fallback.

**Risks/missing decisions:** keep `confirmed`, `inferred` and `missing` evidence distinct, with source/actor and original timestamps. A fallback scan gives an upper bound (printed by this time), not the actual print instant. A late click records confirmation time; replacing an earlier inferred bound with it can put printing after framing and create false dwell. Repeated actions need a database uniqueness rule, while corrections need a separate authorized path. Validate workspace, app, user authorization and batch token; a correct Slack signature alone does not establish that a user may confirm that batch.

The concrete delivery path is a Slack app's enabled Interactivity Request URL pointing to a server endpoint. Verify the signature against the raw body and reject stale requests using Slack's timestamp before parsing/processing; acknowledge within three seconds, after durable acceptance or through a durable queue. Later UI updates can be asynchronous. Confirm the actual app installation, posting method and scopes during discovery. See [Slack interactivity](https://docs.slack.dev/interactivity/handling-user-interaction/) and [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/).

**Suggested specs:** `slack-print-confirmation` for the app/Make message/receiver and authorized idempotent action; `print-evidence-and-inference` for bounded inference, late clicks and report presentation. Depends on F10/F11 and trustworthy app capture. Recommend no reminder in the first release: make missing confirmations visible, measure their frequency, and add at most one reminder later only if useful. Questions **21–23**.

## Hardening obligations across the roadmap

These are required acceptance areas for future specs/plans, not claims that the current code passes them.

| Checklist area | Required treatment and owning slices |
| --- | --- |
| Failure modes | F3 durable thumbnail jobs and retry/backoff; F4/F6/F7 transactional completion with stable IDs; F6 loud malformed-input rejection and durable offline capture; F10–F12 durable ingestion, replay and visible missing evidence. Bound retries and expose a recoverable failed state. |
| Data correctness | F1 shared effective-event counts; F5 snapshots; F6 stable scan and line IDs; F7 separate actor/manual credit; F8 site-local periods and corrections; F9 coverage/method; F10–F12 source time versus receipt time and confirmed versus inferred facts. |
| Security | S1 credential on every branch; F3 authorized on-demand work, restricted Storage writes, signed provider events and bounded generation cost; F4–F12 RLS and caller/site validation. Review SECURITY DEFINER functions and grants, not only UI roles. Kiosk access must not become a general stock/credit editor. |
| Release/rollback | Expand-only numbered migrations; first inspect staging against the recovered migrations, including the missing 0027. CJ applies SQL and external settings. Verify old and new clients against expanded schema. Feature flags for shop-floor changes, preserve/reconcile queued captures on rollback, and retain new records for later replay. S1 CRON_SECRET must precede deployment. |
| Performance | F3 shared code/revision cache, batched backfill and bounded workers; F6 responsive capture while work is queued; F8/F10 indexed bounded queries or rebuildable aggregates tested with two years/three sites. No silent paging cap or external request per rendered row. |
| Operations | Show queue depth/oldest age, rejected captures, thumbnail failures, last source event, missing batch links and evidence coverage. Define site hours/alert owner. Monitor webhook subscriptions, expiring credentials, storage and retained queues. Keep existing station flow as a tested fallback; replay must not duplicate physical work. |
| Tests | Table-driven SKU/set/exclusion, period/DST, box-rule and timing tests; concurrent/replayed event and ledger tests; RLS role/site tests; malformed/interleaved scanner hardware tests; offline/reload/lost-ack tests; signed-webhook/reordered-source fixtures; rollback and old-client staging smoke tests. |

Dropbox webhooks identify changed accounts rather than supplying each changed filename. F3 therefore needs a persisted folder cursor and change processing, plus signature verification and durable recovery. A notification endpoint alone does not satisfy file replacement tracking. See [Dropbox webhook guidance](https://docs.dropboxapi.com/dropbox-api/docs/webhooks).

Release prerequisites still belong to CJ: staging schema/data preparation, Vercel Preview separation, branch protection, production secrets and external configuration. The connection visible in this chat does not prove those steps are complete. Do not connect development to production to fill evidence gaps.

## Suggested build order and dependencies

The existing linear order is directionally useful but hides prerequisite contracts. This is a proposed refinement for CJ's approval, not an edit to ROADMAP.md.

| Wave | Work | Why / exit gate |
| --- | --- | --- |
| 0 | CJ release setup; finish S1; collect Max's box rules, scanner hardware details, Make exports and Slack ownership. | Security and staging gates first. External evidence can be collected while documentation proceeds. |
| 1 | F1 counts + shared report periods; F2 display; F3 source/key discovery; F6 hardware feasibility. | Deliver small independent improvements; catch hardware/source assumptions before purchase or schema design. F2 reserves image space until F3. |
| 2 | F5 department/event snapshots; early F10 order/line/milestone identity; production write safety and history-correction contracts. | Establish identity, audit and transaction rules used by F4/F6/F7/F8. Keep old client shapes compatible. |
| 3 | F3 thumbnail store, triggers and backfill; F4 editable rules and safe packaging application. | These can be separate branches after their contracts; F4's nonblocking behavior must be ready for scan-only stations. |
| 4 | F6 sessions, queue, scan-only framing and kiosk health; then F7 dispatch attribution/flow. | Hardware gate passed, per-scanner credit durable, stock replay-safe, rollback rehearsed. |
| 5 | F8 aggregates/reports; F9 timing. | F8 can begin earlier with F1/F5 fixtures; final integration includes new scan/manual facts. F9 needs actual scan grouping and weights. |
| 6 | F10 Shopify ingestion, timeline and flow metrics; F11 batch mapping/Make receiver and rollout. | Ingestion can start after wave 2; full timeline combines trusted app events. F11 storage can precede final F10 analytics. |
| 7 | F12 Slack confirmation and inference. | Batch identity, authorized Slack delivery and evidence semantics settled. |

No simultaneous writers are proposed. “Can begin earlier” means dependency flexibility, not permission for agents to edit together. Each suggested slug above becomes a separately approved spec/plan only when CJ selects it; tightly related slices may share one feature spec if the plan retains clear release gates.

Important new dependency edges: S1 → F1 digest integration; F1/F5/F10 identity contract + write safety → F6; F4 → F6/F7 nonblocking completion; F7 source semantics → F9/F12; history correction + periods → F8/F10 reporting; F11 mapping → F12. These remove the apparent cycle in which scanner capture would ship before its order/line identity was designed.

## Initial questions for CJ — answers recorded above

The original numbering is retained so CJ's answers can be traced. The decision register and remaining-input list above are current; this historical list is not a request to answer settled questions again. “Use recommendation” approves the stated policy but cannot supply an artifact, hardware detail or Max's actual rule values.

### F1 — counting

1. **What makes an order count, and how should repeat work count?** Recommend one distinct order per site/work type/report period after qualifying completion; count distinct orders across work types without summing them. Show separately credited rework/CS pieces as such; retries never add credit. A worker's own qualifying contribution can count toward their personal orders, so person subtotals need not sum to the site total.
2. **How should legacy unknown/canvas lines be handled?** Recommend eligible known print/frame pieces only, retain the decided exclusions, and show unsupported/missing detail as a coverage warning rather than guess. Confirm whether canvas is an eligible physical product now; its routing and quantity contract are currently incomplete.

### F3 — thumbnails

3. **Can CJ/Max provide the Part 6 preview index and representative single/set previews, and should a set show a composite?** Recommend reusing previews only if they contain the exact artwork without customer/order data; use a composite for a set rather than silently showing only its first print. Otherwise generate from canonical source files.
4. **What does “right away” mean operationally?** Recommend queueing immediately, showing a placeholder while processing, and targeting a thumbnail within two minutes under normal service conditions. Show missing-source/retry status and alert on sustained backlog; external outages must not block framing.

### F4 — boxes

5. **Can Max supply the initial rule table and examples for mixed sizes, sets, multiple boxes, sites and replacements?** Recommend a tested priority-ordered rule table with versioning and an admin simulator; no inferred initial rules.
6. **Where is packaging consumed, including A0/UN and CS replacements?** Recommend exactly once at the physical final packing point: dispatch for orders that reach dispatch, otherwise the completing packing station. Apply auditable quantity deltas for overrides, include real replacement packaging, and allow completion with a visible unresolved-packing flag when no rule matches.

### F5 — departments

7. **What are the initial departments, assignments and allowed work types?** Recommend keeping the four routing types unchanged and assigning each person one home department; confirm whether “all framing lines” includes A0, unframed and frame-only lines, since the current framing-page filter is broader than strict framed-product routing.
8. **May old rows remain “department unknown,” and do all badge users have Auth identities?** Recommend unknown for history without trustworthy assignment evidence, never today's team retroactively. Preserve each worker's stable identity; validate staging identities before specifying any barcode-only staff migration.

### F6 — scanners

9. **Which scanner/receiver models, tablet OS/browser and wall display will be used?** Recommend a purchase/rollout gate requiring a successful three-scanner collision, range, battery, reboot and offline bench test; hardware must retain scanner identity or serialize input if strict keyboard framing proves insufficient.
10. **Accept a proposed framing-session rule?** Recommend badge at every handover, clear active names, and badge required after 15 minutes of scanner inactivity or receiver restart. This is a starting operational threshold to pilot; scanner-session expiry must not clock the person out of payroll/attendance.
11. **What offline recovery process is acceptable?** Recommend saved local captures remain visibly pending; uncached orders cannot be credited until validated online. After device failure, recover from the queue where available or an audited supervisor reconciliation, never blindly rescan and assume duplicates are harmless. No browser-only queue can survive loss of the device itself.
12. **Who receives health alerts, and what are site work hours?** Recommend a receiver heartbeat, alert after five minutes of missing heartbeat during configured work hours, and a clear on-screen fault immediately. Use an existing operations channel and named owner; ordinary absence of production scans alone is not evidence of a failed receiver.

### F7 — dispatch

13. **Who can manually assign a missing framer, and may dispatch continue if the name is unknown?** Recommend an authorized dispatcher can select an active worker at that site, recording dispatcher/time/manual source. Keep unknown visible and allow dispatch with a warning; later real evidence is reconciled without duplicate credit. Use a shift-length dispatch session, distinct from framing idle expiry.

### F8 — reports

14. **What report visibility should each role have?** Recommend owners across sites, managers within assigned sites, staff their own results, kiosk only operational confirmations, and no CS performance access unless explicitly granted. Summary CSV follows the same permissions.
15. **Which business-day boundary and week start apply at each site?** Recommend 04:00 site-local production days and Monday-start weeks, consistently across Reports, Welcome, live counters and digest; calendar months use that same boundary. Confirm each site's IANA timezone and intended shift boundary before adopting this recommendation.

### F9 — timing

16. **Can Max approve the size-weight table and partial/missing-scan fallback rule?** Recommend the existing weights only as a starting proposal, not assumed approval; scale 405 productive minutes proportionally for a verified partial shift, and show measured and fallback samples separately. Do not treat a missing clock/shift as a confirmed full shift or add a fallback shift to already measured work.

### F10 — timeline

17. **How do AU/UK/US map to Shopify shops, and does “shipped” mean first or complete shipment?** Recommend immutable shop/order IDs and explicit site mapping; retain all fulfillments, with full-order shipment as the main order-to-ship endpoint and partial shipment visible separately.
18. **What makes an order late at each site?** Recommend Max supplies service thresholds, cutoff times, holidays and exclusions; measure median and P90 for explicitly stated cohorts, and list currently open overdue orders. Do not invent lateness thresholds or treat missing delivery evidence as an on-time delivery.

### F11 — Make

19. **Can CJ supply redacted scenario exports and examples showing when batch IDs and membership first exist, including splits/reprints?** Recommend persist explicit versioned order/batch membership; if Part 1 cannot know the final batch, approve a later mapping update rather than guessing it.
20. **What retained source can recover an Ignore-handled failed milestone call?** Recommend replay from a durable manifest/log with stable event keys; if none exists, retain the approved nonblocking Ignore behavior and show missing data until an explicit replay/recovery path is supplied.

### F12 — print confirmation

21. **How should one-order evidence represent a partly printed batch?** Recommend infer “this order was printed by this time,” show partial batch evidence, and claim full batch completion only with full supporting evidence or explicit confirmation. This resolves the roadmap's batch-inference ambiguity and requires CJ's decision.
22. **Which Slack app/workspace posts Part 5 messages, and who may confirm printing?** Recommend the posting app owns the verified interactivity endpoint, use a staging channel/app installation, and authorize named printing roles/users. Supply app ownership/configuration evidence before planning exact Make/Slack setup.
23. **How should a late click affect print time?** Recommend retain the earlier inferred upper bound and separately record who confirmed and when; never replace it with a later timestamp that makes printing occur after framing. Keep confirmed/inferred coverage distinct in metrics. Omit reminders initially.

## Verification and limits

- Read the required documents and inspected the production, reporting, SKU/routing, stock, artwork, Shopify, auth/role and migration paths supporting all thirteen roadmap items.
- `npx tsc -b`: passed on this baseline. As AGENTS.md states, this does not type-check `api/`.
- `npm run test -- --run` with `VITE_BACKEND=dexie`: passed, 35 tests. The existing suite is payment-terms coverage, not evidence that scanners, RLS, stock races or integrations are safe.
- `npm run build` with `VITE_BACKEND=dexie`: passed. Warnings concern stale Browserslist data, an XLSX mixed import and large chunks; no app changes were made to address them in this docs-only task.
- No migrations, provider writes, live endpoint calls or production-database access were performed. The follow-up inspected all six supplied local exports, checked preview-index references/integrity and visually inspected three artwork previews. Initial Make batch identity and Part 6 recovery candidates are now documented. Staging schema parity, hardware collision behavior, live Make retention/non-AU parity, Slack ownership and actual Shopify/carrier capabilities remain unverified and are explicit spec gates above.
- PR CI must pass for this document branch. CJ alone approves the resulting specs/plans and performs later merges/releases; the one-time merge authorization for PR #4 does not apply to this review PR or any feature.
