# Spec: Count production items separately from orders

- Slug: `item-counting` · Roadmap ID: `F1` (see [ROADMAP.md](../ROADMAP.md))
- Status: approved by CJ
- Author: planner (GPT-6 Astra)
- Source baseline: `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7` (main after digest-auth PR #6)
- Decision sources: [ROADMAP-REVIEW.md](../ROADMAP-REVIEW.md), especially the CJ decision register, F1 analysis and shared report-period recommendation. Draft details below become implementation requirements only after CJ approves this spec.

## Problem

Owners, managers and workers see inconsistent production totals. Unframed prints are excluded from Items, even though they are physical output. Sets already have a multiplier, but the browser and digest have different SKU parsers and counting loops. Reports counts orders from verified lines, whereas other views use completion events. Production reload counts repeated completion rows and can include excluded items; Welcome misses verification cancellations. A change to the eligibility predicate alone would preserve these disagreements and could incorrectly include unframed work in frame-time averages.

F1 must give Reports, Welcome, the Production live counter and the authenticated daily digest the same results for the same saved evidence, location, person/work-type scope and reporting window. A count is production work credit, not an inventory movement or a shipment count.

## Goals

- Count eligible physical pieces separately from distinct completed orders, including unframed prints and set quantities.
- Use one browser/server-compatible pure item-counting function and one shared effective-event counting contract across every affected summary and drill-down.
- Handle cancelled verifications, repeated completion events, rework and incomplete history explicitly.
- Use the approved site-local production day consistently, and make partial-day/different-scope comparisons understandable.
- Recompute historical views from saved events without rewriting history; explain the changed totals in release notes and report labels.
- Retain the digest-auth protection merged in PR #6 and existing inventory, routing and production capture behavior.

## Non-goals

- No scanner hardware/session/outbox work, department administration, new reporting permissions, timing-method redesign, report aggregation service, Shopify timeline or Make/Slack integration. Those remain F5–F12 or shared prerequisites identified in the review.
- No new canvas credit, fuzzy SKU recognition, price-based classification, catalogue cleanup, guessed quantities or retroactive worker/team reassignment.
- No stock or packaging deduction changes, automatic data repair, event deletion or new production write/idempotency system.
- No new cron schedules, digest recipients, credentials or public reporting endpoint. No production database access during development/testing.
- No full F8 trends/summary-export redesign. Existing KPI displays and calculated export values must be consistent; existing raw event exports retain their raw quantities and timestamps.

## User stories / flows

- As a worker, I verify two units of an unframed two-piece set and see four Items. After saving a qualifying order completion, Orders increases by one. Refreshing or changing away and back does not change either result.
- As an owner or manager, I select a site, person/work type and period in Reports and reconcile its totals with the equivalent Welcome/live/digest scope. Department/work-type order subtotals can overlap; the overall distinct order total is not their sum.
- As a worker, I undo a verification and see only that verification's item credit removed. A later reload or digest applies the same correction.
- As CJ, I can distinguish normal output, identifiable CS/rework output and incomplete historical coverage without guessing missing facts.
- As CJ, I can download a staging digest with the staging secret and verify counts without sending email or weakening authentication.

## Acceptance criteria

### A. What counts as an item

- [ ] A normalized, recognized single-print SKU with variant `FB`, `FW`, `FN` or `UN` contributes its saved product quantity. A framed print is one item, not a print plus a frame.
- [ ] A recognized set-print SKU with one of those variants contributes `product quantity × set piece count`. Supported set counts are the existing single-digit positive counts 2–9, including `GW` size composites. Reject invalid counts such as S0/S1 for this contract; do not silently turn malformed sets into singles. General routing/parser expansion is outside scope.
- [ ] Recognized frame-only `PF` products with variants `PB`, `PW` or `PN` continue to count as one item per unit. They are not the excluded accessories.
- [ ] Gift cards, free-print SKUs (including recognized current `INKA-AUX…` and legacy `INKA-AUX-FP-…` forms), hooks/other accessories and packaging contribute zero items. The same exclusion applies when such a line appears in a mixed order.
- [ ] Canvas (`SC`) remains excluded in F1; it needs separate explicit approval before becoming eligible. Unknown/missing SKUs, unsupported formats and malformed set codes contribute no guessed pieces and are identified as unclassified coverage.
- [ ] Quantities must be finite nonnegative safe integers with a safe-integer multiplication result. Zero contributes zero; missing/null, negative, fractional, nonfinite or overflowing values are uncountable and flagged. Do not default missing historical quantities to one or silently clamp negative totals.
- [ ] Normalize case and surrounding whitespace consistently. Browser and server use the same classifier/counting function, including explicit `counted`, `excluded` or `unclassified` outcomes and a reason where useful. There must not be a second digest copy of the business rules.

| Saved verified line | Product quantity | Items |
| --- | ---: | ---: |
| `INKA-S2BON0064-A1-UN` | 2 | 4 |
| `INKA-S3WIL0049-A2-FN` | 2 | 6 |
| `INKA-KAN0566-A4-FB` | 3 | 3 |
| `INKA-KAN0566-A4-UN` | 3 | 3 |
| `INKA-PF0004-A0-PW` | 2 | 2 |
| Recognized six-piece GW set, framed or UN | 1 | 6 |
| Gift card, free print, accessory or box | any valid quantity | 0, excluded |
| Canvas | any valid quantity | 0, excluded in F1 |
| Missing/unknown SKU or eligible SKU with null quantity | unknown | No guessed count; coverage warning |

### B. Saved evidence, orders and rework

- [ ] Items come from effective `line_verified` events, at the verification time and with the recorded person, site, work type, SKU and quantity. A `started`, `completed` or `dispatched` event does not add its order-level `line_quantity` to Items. Items may therefore appear before order completion.
- [ ] A `cancelled` event with a valid `parent_event_id` removes that parent's verification contribution once, using the parent's saved quantity. Apply cancellation resolution before person/work-type/display-period filtering. A cancellation saved later may change an earlier period; it does not create negative production in the cancellation day. An orphan/mismatched parent remains a coverage issue, not an arbitrary subtraction. A line cancellation does not automatically erase a separate order completion.
- [ ] Repeated retrieval of the same `(location, event id)` is counted once. Do not collapse distinct verification events just because order/SKU/person match: the current data lacks a stable line/attempt ID and may represent two lines or real repeat work. If apparently duplicated legacy rows cannot be resolved from saved evidence, flag ambiguity rather than claim retry-safe or uniquely reconstructed history. F1 adds no writes that create further event duplicates.
- [ ] **Draft completion definition:** Orders uses `completed` for the three production work types and `dispatched` for dispatch, with a nonblank saved order identity and valid saved site/work type. A verification by itself is not a completed order. Resolve any explicit terminal-event reversal by its saved parent reference; never infer an order cancellation from a line undo alone.
- [ ] Within normal output, count an order once per site/work type/selected report period. Repeated completion rows do not increase it. The overall count is a distinct union of `(site, order number)` across included work types, never a sum of work-type or daily distinct counts. A site boundary prevents the same displayed number at another site from colliding.
- [ ] Person Orders counts that person's qualifying saved terminal events; person Items uses that person's effective verifications. Do not transfer credit to today's owner, most recent verifier or current team. Personal/work-type totals can overlap and must not be presented as additive distinct-order totals.
- [ ] **Draft qualification context:** for each terminal event, inspect original saved `line_verified` rows with the same site, order number, work type and CS case (including null for normal work), whose event time is at or before that terminal's time and which exist in the report's data snapshot. Include all recorded workers in that context before applying the display's person filter; never join another work type/site/case or later verification. Terminal-row quantities/SKUs are not substitute line evidence. At least one recognized eligible product in this context establishes eligible completion; missing/bad quantities still require an item-coverage warning.
- [ ] An order completion with absent or unclassified line context counts as a distinct completed order but carries incomplete/uncertain item coverage. Only a nonempty context made exclusively of positively classified excluded products disqualifies it. Do not treat failed/unauthorized context retrieval as an empty context: show unavailable/limited coverage instead. This conservative historical rule does not infer individual completion attempts from order/SKU matches; retain that limitation when multiple attempts share the available identity.
- [ ] Qualification uses original line evidence, not the effective item sum after cancellation. Thus a mixed order remains one completed order when its eligible verification is later undone, even if only accessory verifications remain effective; its Items decrease and its correction is visible. Only an explicit reversal of the terminal removes that completion. A verification whose event time is after the terminal cannot qualify the earlier completion. This separates completed-order evidence from corrected piece credit without inventing an attempt linkage.
- [ ] Events with `cs_case_id` are a separate CS/rework group, with the same piece and distinct-order rules, not silently added to normal output. Its order key includes case ID so separate documented replacement cases can be distinguished. All four consumers expose normal and CS/rework totals, or an explicit separate labeled detail. Untagged repeated work cannot be reliably classified as rework; show that limitation instead of inventing a case or adding repeated Orders.
- [ ] An all-work-type Items total is the sum of credited pieces processed at the included work types; the same physical piece handled at two work types can contribute twice. Label the scope as work processed, not unique products manufactured or shipped. Unique physical-item tracking is outside the evidence available to F1. Keep per-work-type detail available.

### C. Reporting windows and consistency

- [ ] Store/interpret event times as UTC instants. Use the site's IANA timezone: AU `Australia/Sydney`, UK `Europe/London`, US `America/Chicago`. A production date D means `[04:00 on D, 04:00 on D+1)` in that zone. Convert each local boundary independently; do not add a fixed 24 UTC hours across DST transitions.
- [ ] Date-range filters include each selected production date; custom end dates convert to the next day's 04:00 exclusive boundary. Existing weekly comparisons use Monday-start local weeks. No new F8 calendar UI is required, but existing comparison values must use the same boundaries as their displayed totals.
- [ ] Live/current-day results are as of the data snapshot, with the production date and scope available to the reader. Digest `date=D` uses the same period; without a date, use the current production date at that site. Do not change cron expressions. A scheduled send before 04:00 closing time is an as-of report, not a claim that the full production day has ended. Historical re-downloads can differ after later activity/corrections; label the window and generation time.
- [ ] Reports summaries, person/order drill-downs, existing count-based comparisons, Welcome, Production immediate updates and reloads, and digest summary/staff sheets use the shared rules. For equal evidence and scope, they agree exactly. Distinct counts across a longer range are recomputed over that range, not summed from daily totals.
- [ ] Adding UN Items does not add UN observations or pieces to frame-time, per-frame cost/effort or framing benchmark denominators. Separate item eligibility from timing eligibility; retain current frame-only timing behavior until F9. Do not silently relabel a new mixed-output rate as a framing rate.
- [ ] Display unclassified/missing-detail counts and an incomplete-coverage indication where totals are shown, including the digest. Expected exclusions are distinguished from broken/missing data. If fetch/pagination fails, show an unavailable/incomplete state rather than a valid-looking zero or silently truncated total. Failed digest reads return an error before email generation/sending; bounded known data-quality gaps can produce a clearly labeled report.

### D. Regression and release gates

- [ ] Counting changes are read-only. Existing saved SKU/quantity/person/time values, stock/ledger rows, cancellation writes, clocks, routing and package selection remain unchanged. Tests demonstrate the same inventory deduction for a set before/after F1, not an extra deduction for its KPI piece multiplier.
- [ ] Digest auth runs before database/report work. Preserve secret-only access, recipient allowlist validation, method/error precedence and no-store responses, including diagnostics and `dry=1`; all existing S1 tests continue to pass.
- [ ] Release notes state that UN output now counts, historical totals are recomputed, Orders uses completed/deduplicated evidence, CS/rework is separate, production-day boundaries are consistent, and missing history is not reconstructed. No historical data migration is used to manufacture agreement.

## Data and backend impact

- **Tables / migrations needed:** read existing `production_events`, including event ID, location, staff ID, work type, event type, created time, SKU, raw quantity, parent reference and `cs_case_id`. No new tables, backfill, destructive change or persisted summary is required for F1. Any necessary read-performance index must be justified in the plan and added through a new append-only migration; CJ applies it to staging first. Do not modify recovered migrations or assume the missing 0027 schema.
- **Repository interface changes (both Dexie and Supabase):** no interface change is expected. These production views currently query Supabase directly; the shared functions must be storage-independent and testable with plain fixtures. Dexie remains supported for existing app flows/builds, but F1 does not create offline production persistence. If the plan changes `Repository.ts`, implement both adapters or obtain explicit approval of a documented scope exception.
- **`api/` endpoints touched:** only `/api/reports/daily-digest` for shared count/period integration and clearly labeled output. The helper must import safely in both Vite and the Vercel Node function, without browser state or client secrets. Include it in `typecheck:digest` coverage. No new endpoint, subscription or external API request per item.
- **RLS / role access:** preserve existing authenticated role/site visibility; F8's approved permissions redesign is not implemented here. Fetch cancellation/qualification context only through an authorized site-scoped path. If RLS hides necessary evidence, mark that view's scope/coverage; do not grant broad read access or expose the service-role credential to reconcile it. Digest remains restricted by S1 and uses its existing server credential/site validation.
- **Likely implementation surfaces, not a task plan:** `src/lib/domain/skuRouting.ts`, a shared pure count/period module, `src/pages/Reports.tsx`, `Welcome.tsx`, `Production.tsx`, `api/reports/daily-digest.ts`, focused domain/API tests and release notes. Preserve raw event export fidelity. Updating this spec does not authorize those code changes.

## Staging test plan

CJ runs these against a Vercel Preview tied only to Inka Staging (`ybrzhrgfrnvtcwymjdrq`), with synthetic orders/users and a separate staging digest secret. Never use production data, keys or email recipients. Record site, period, role, filters, data snapshot and expected values for comparisons.

1. **Owner:** seed the table examples at each site, including a completed order containing two UN two-piece sets: four Items, one Order. Add an excluded accessory without increasing Items. Exercise a mixed order, PF product, GW set, canvas, legacy unknown SKU, invalid quantity and a completion with missing line detail. Verify normal/rework and coverage labels across Reports/Welcome and authorized digest XLSX.
2. **Manager:** verify permitted-site summaries and drill-downs match the owner for equal accessible scope. Attempt another site's data and confirm existing restrictions remain; limited visibility must not masquerade as full-site completeness.
3. **Staff:** verify items, finish an order, undo/re-verify a line, reload and change person/filter. Check immediate and persisted totals agree for accessible scope and credit stays with saved people. Include another person cancelling a referenced verification where current permissions permit it; resolve by parent, not the cancelling person's credit.
4. **Kiosk:** repeat the ordinary completion/clock flow and counter reload with authorized station identity. Verify two identical terminal deliveries count one order; repeat retrieval of the same event adds nothing. Test a failed summary fetch and ensure no misleading zero or blocked normal capture caused by KPI calculation. Do not claim F6 offline capture is delivered here.
5. **CS:** create an authorized synthetic replacement case through the existing flow, verify its events appear separately from normal output, and retain existing CS access restrictions. Do not expose new staff-performance detail to CS.
6. **CJ / digest caller:** use staging `dry=1` for AU/UK/US and a fixed test date; compare normal/rework orders/items and coverage with equivalent UI scopes. Repeat missing/wrong-secret, diagnostics, method and allowlist checks. Do not send emails as part of count verification; S1 delivery smoke tests use safe test inboxes only.
7. **Corrections and boundaries:** cancellation of a prior-day verification updates that prior period and does not subtract from the next day; duplicate cancellation subtracts once. Test 03:59:59/04:00 boundaries, browser timezone different from site, DST changes, Monday/year/month boundaries, a verification before a range with completion inside it, and a correction by someone outside a selected person filter. Historical/current-day reports must state their as-of/window semantics.
8. **Deduplication and scope:** two work types process the same order: each work-type Orders is one, overall Orders is one; the same number at another site is distinct. Two genuine same-SKU line events remain separate. Test same order across two days and a full-range query, separate CS case IDs, re-fetches, shuffled input and repeated IDs. An excluded-only completion yesterday stays excluded when an eligible verification is saved with today's event time. Undoing the eligible line of a completed mixed order reduces Items but keeps one Order until an explicit terminal reversal. Surface ambiguous legacy repeats rather than silently merge them.
9. **Performance and integration:** use synthetic two-year/three-site volume including more than 1,000 and more than 100,000 events. Complete authorized reads with stable pagination/context resolution, or fail visibly before presenting/sending totals. No external item lookups. Verify frame-time/cost benchmarks do not gain UN samples and stock/ledger behavior is unchanged.
10. Run the complete [RELEASING.md smoke test](../RELEASING.md#2-smoke-test-staging-preview-about-10-minutes). Most at risk: Production counter/verification, Dashboard/Reports totals and the digest; also check stock once-only behavior, role logins, Shopify lookup, shipments, CS cases and returns. Rehearse rollback to a release that still contains S1 authentication.

## Hardening

### 1. Failure modes

Summary network/Supabase failures show a retryable unavailable state or a clearly dated prior snapshot, never a successful zero. Do not erase persisted events or make a reporting failure block an otherwise valid existing production action. Shopify/Dropbox/Make/Slack are not count dependencies: use saved facts and mark missing SKU/detail instead of live enrichment. Retry reads are side-effect-free; deduplicate retrieved event IDs and cancellations. Concurrent inserts require a stable as-of/read boundary and deterministic pagination, plus explicit handling of later corrections; the implementation plan must state its snapshot approach. Unknown/malformed barcodes, cancelled orders and wrong-site capture still use existing capture validation; counting rejects invalid saved facts or marks them unclassified. Recovery is a reload/retry or authorized data investigation, not automatic repair/re-credit. Unresolvable legacy duplicate identities remain a documented limit.

### 2. Data correctness

Use one piece-count function and effective-event contract for every consumer. Use saved attribution/quantities; no joins to today's department assignment to rewrite credit. Apply parent cancellation once, including outside display ranges, with site matching and deterministic event-ID handling. Distinguish exclusions, incomplete evidence, normal work and tagged CS/rework. UTC instants and independent site-local 04:00 boundaries handle DST. No inferred/manual quantities are invented; later manual/source schemas belong to F7/F10. Frame-time eligibility stays separate. Report the work-type scope of Items so a cross-stage total is not mistaken for unique physical stock.

### 3. Security

No new endpoint/table/Storage permission is required; new-table RLS is n/a unless an approved plan changes that scope. Preserve existing role/site reads and S1's authentication/allowlist/no-store guards. New query parameters, if any, require validation and bounded workload; do not introduce them merely to bypass auth. Keep all secrets server-only and omit them from code, logs and generated reports. Cancellation/context lookup must not disclose another site's events. Counting adds no email recipient or external cost surface; digest request replay remains the existing shared-secret behavior, not a new delivery guarantee.

### 4. Release and rollback

No data rewrite is required; any justified index migration is expand-only and compatible with the old app. CJ first verifies staging/Preview separation, tests this spec per role, confirms CI/review approval, and records a rollback deployment that already contains S1. Preserve `CRON_SECRET`, recipient settings and schedules; CJ has confirmed Production's secret for S1, but F1 must not depend on exposing or changing it. No new Shopify/Dropbox/Make/Slack configuration is required. Publish the historical-count/period/rework release note before the quiet-time merge. Monitor next AU/UK/US reports and UI samples. Roll back the app to the protected S1 baseline if needed; no counter/stock data rollback. A new feature flag is not required for this read-only calculation change: capture remains unchanged and deploy rollback restores prior formulas. Never roll back to pre-auth digest code to fix a count regression. F1 approval is not deployment authorization.

### 5. Performance

The reducer should be linear in retrieved events; avoid per-line API calls or full-history scans per visible row. Fetch only required columns, use stable `(created_at, id)` ordering and bounded/batched context queries for cancellation parents, reversals and completion qualification. No silent 1,000-row truncation or 100-page ceiling. Test two years/three sites without mixing sites in unauthorized queries. Proposed acceptance target for representative staging volume: one-day views within two seconds and a three-month summary/digest within ten seconds after authentication, excluding email delivery; record fixture size and measured timings. If the existing direct-read approach cannot meet safe limits, stop at plan review and propose an indexed read strategy or prerequisite; do not silently deliver partial counts or add an aggregation subsystem without approval.

### 6. Operations

Show coverage/unclassified counts, period/scope and current-data/error status; use existing server error logging for failed digest reads without credentials or customer detail. Compare staging UI/XLSX fixtures before release and sample subsequent scheduled reports through CJ. No remote station-health alert is added (CJ deferred it). Existing production capture remains the shop-floor fallback if reporting is unavailable; use the protected prior release for a calculation rollback. No new storage, webhook subscription or token-maintenance task is introduced. Counts can change after late corrections; retain raw evidence and report generation time for reconciliation.

### 7. Tests

Add table-driven pure tests for eligible variants, PF, set/GW quantities, both free-print forms, exclusions, normalization and invalid quantities/multipliers. Add reducer tests for terminal-only Orders, parent cancellation across periods/person filters, duplicate IDs/cancellations, genuine same-SKU lines, CS separation, overlapping work types/sites, missing detail and deterministic input order. Add site-period/DST and as-of tests, UI/reload/digest parity fixtures, pagination/incomplete-read error tests, and regressions proving UN cannot enter frame-time denominators or alter stock writes. Preserve S1's auth/no-work-on-rejection/recipient tests. Required checks: `npx tsc -b`, `npm run typecheck:digest`, `npm run test -- --run`, `npm run build`; api/ is outside the general TypeScript build. Unit tests alone do not prove RLS or Preview integration: complete the staging plan before release.

## Roadmap decisions honoured

| F1 decided point | Requirement here |
| --- | --- |
| Orders and items are separate; two UN two-piece sets = four items, one order | Acceptance A/B and the example fixture; terminal completion determines the order count. |
| Sets multiply piece count by quantity | Shared pure item function, safe quantity checks and set/GW cases. |
| UN prints count | UN is eligible alongside framed print variants in every consumer. |
| Gift cards, free prints and accessories stay excluded | Explicit classifications; PF frame-only products retain existing eligible treatment. |
| Historical reports recompute and release notes disclose changes | Read-only saved-event recomputation, coverage warnings and release checklist. |
| One shared rule in Reports, Welcome, Production and digest | Browser/server-safe shared function and event/period contract; parity tests cover summaries and drill-downs. |

CJ's review decisions also require deduplicated completed Orders, separate rework, unknown-history visibility, 04:00 production days and confirmed site zones. Managed business departments remain separate from fixed work types; F1 retains existing work-type keys. The shared period subset is included here to make all four outputs comparable, without bringing in the rest of F8.

## Risks and open questions

- **Draft choices for this approval:** the explicit terminal/legacy completion rule, valid set range 2–9, CS-case grouping, summed work-type Items interpretation, current-production-day/as-of digest semantics, missing-quantity treatment and performance targets above. These fill implementation gaps; they are not claimed to have been separately approved in the roadmap.
- **Canvas:** preserve exclusion for F1. Enabling it later needs CJ's explicit product/routing decision; it is not a blocker to approving this bounded scope.
- **Historic identity limits:** no stable line/scan attempt ID means distinct stored events cannot always be distinguished as duplicate capture versus legitimate repeat work. F1 must not invent certainty or silently destroy credit. A requirement to repair/deduplicate those historical records would need a separate approved spec.
- **Counts and operational expectations:** historical Items, Orders, rankings and date assignments may change; they are not an automatic payroll adjustment. Keep framing-only benchmark metrics separate and label work-type totals. A per-person total need not add up to a site's distinct Orders.
- **Digest timing:** the unchanged cron can send before the 04:00 period closes. The as-of label is intentional; changing schedules or sending an additional finalized report needs separate approval. Cross-period corrections can change a later download of an earlier report.
- **Read scope and scale:** cancellation/qualification context must work within RLS, paging and function time limits. The coder must surface a blocking question in the plan if required evidence cannot be retrieved safely; do not widen privileges or silently omit records.
- **Release verification:** PR #6 is merged at the baseline above, but this session could not observe a Vercel production deployment record for it. CJ must confirm a protected production rollback target before F1 release. This spec/branch does not deploy F1 or authorize any further merge.
