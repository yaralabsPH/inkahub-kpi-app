# F10 Order timeline

CJ authorized this feature and F11 on 2026-11-23 and delegated routine choices to Codex and Claude. Codex plans/reviews; Claude implements. Work is isolated from production. Staging is currently disk-full and unavailable: no database writes, billing changes, live integration changes, or deployment acceptance until recovery. The overnight stop time remains 10:00 Asia/Shanghai; checkpoint unfinished work honestly.

## User experience

Add an Order timeline card inside Reports: select the current site and look up an order number. Show ordered, framed, dispatched, shipped, delivered, with source, actual event time, and explicit missing evidence. F11 inserts its automation stages in the same display. UTC storage, existing site timezones for display. Dispatch does not prove shipment; label partial shipment separately. Cancellation and replacement evidence must not silently count as original-order completion. Keep the existing order lookup and all production flows working.

Add bounded site/date flow metrics: stage waiting times and order-to-complete-shipment median/P90, cohort/sample/coverage labels, and currently open late orders. The first version reports elapsed hours, not invented business calendars. A positive site-specific late threshold is optional configuration, initially unset; unset shows "Late-order rule not configured". Do not label orders late from a guessed threshold. Reports must say they cover recorded orders, not claim complete Shopify history before a feed/backfill is commissioned.

## Identity and evidence

Store durable source-qualified milestones independently of inventory/production writes. Canonical external identity is site + normalized Shopify shop + immutable Shopify order ID; order number is an alias, never a cross-site key. No automatic shop/site guesses from current worker location or shipping country. Unmapped/ambiguous evidence remains unlinked and visible as unavailable. App-only history may display under its explicit site/order number but cannot silently merge two Shopify identities.

Preserve source occurrence key, happened-at, received-at, stage, evidence kind, and optional batch/fulfillment identity. Unique source occurrence keys prevent duplicates. Same key with different content conflicts instead of overwriting history. Out-of-order arrival must work. Retain multiple fulfillments; only claim full shipment when all required fulfillments are established, otherwise show partial/unknown. Delivered requires carrier evidence. No heavy automatic backfill or production-event trigger; bounded explicit reconciliation can copy app evidence without making shop-floor writes depend on this feature.

## Integration and safety

Retire the unused unauthenticated Shopify whoami diagnostic (it exposes token metadata) and replace its function slot with api/orders/timeline.ts; verify no app caller depends on whoami first. Keep twelve Vercel entrypoints, no hosting upgrade. Preserve the existing order lookup unchanged. Shopify integration is read-only and explicit per site, disabled when mapping/credentials are missing. Source read failures keep previous records and show an error, not success. Bounded pagination must fail visibly on incomplete results. Additive migration 0059 or next available only; never edit 0034-0058 or reserved F3 0048-0051.

Shopify adapter: verify raw-body HMAC and allowlisted shop before accepting signed order/fulfillment events. Separate webhook auth from session and Make auth. Never trust a caller-supplied source to bypass verification. Add bounded owner-triggered reconciliation using a supported API version verified against official docs, with no calls or subscription changes to live Shopify during development. Leave configuration blank by default; one shop shared by multiple sites is unresolved until an explicit order-to-site mapping rule is configured, never duplicate one order into all sites.

Readers: owner; manager within memberships; CS only with explicit Reports permission and membership. Deny kiosk and staff for this whole-order management view rather than expose colleagues' records. Authorize before service-role data reads; no customer emails/addresses or payroll in timeline DTOs. New tables have RLS and no direct browser write access. Service-only ingestion RPCs revoke PUBLIC/anon/authenticated execution. Every externally callable action validates bounded input, site, timestamps and authentication; secrets remain server-side and absent from logs.

Query one order or bounded site/date cohorts with indexes and explicit cardinality failures; never load two years of raw events into the browser. No new dependencies. Supabase-only operational feature, with a clear unavailable message in Dexie; Repository interface unchanged. Failures affect only timeline visibility, never printing/scanning/stock. Monitor missing evidence, source freshness and storage growth; no promise of replay where a source has no retained log.

## Acceptance and release

Test site isolation, role denial before reads, retries/conflicting replay, reordered evidence, missing stages, partial shipment/cancellation, nonnegative metrics, timezones and stale UI responses after site changes. Use existing PGlite for real local SQL tests. Run existing typechecks, tests and build once at the feature gate. Real staging migration/RLS/API/browser checks remain mandatory and blocked by database recovery. Feature remains opt-in until those pass. Rollback is previous Preview plus disabling timeline ingestion; retain additive history. No production release or live Make edits.

References checked: Shopify Fulfillment fields https://shopify.dev/docs/api/admin-graphql/latest/objects/Fulfillment ; Supabase RLS https://supabase.com/docs/guides/database/postgres/row-level-security . No relevant SDK upgrade is required.
