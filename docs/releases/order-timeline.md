# F10 Order timeline — release notes (staging only)

Current staging release: application `b2e3afcc`, branch `feature/order-timeline-commissioning`, draft PR21 on PR20. [Open Preview](https://inka-arthouse-bzm9p9cwg-inka-arthouse-s-projects.vercel.app/reports).

Owner source refresh and country routing are commissioned. Scanner receipts prove full framing; complete bounded Shopify item coverage proves whole shipment and, when every contributing fulfillment has a delivery timestamp, delivery. Durations only. See [commissioning acceptance](../reviews/order-timeline-commissioning-r2.md).

Only Free staging `rsfdqkjasiozmbdtgquv` was changed. 0061 and 0062 are applied after its consolidated 0001–0060 baseline. Do not run a blind database push. Production and live Make systems are unchanged. Automatic Shopify subscriptions and historical backfill are not part of this release.

## What ships

- `supabase/migrations/0059_order_timeline.sql` (additive; 0034–0058 and the
  reserved 0048–0051 untouched):
  - `public.order_timeline_orders`: shop + Shopify order id. `site` is set
    once by routing (NULL + reason while unrouted). A later different site
    increments `route_conflicts` and never reassigns the order.
  - `public.order_timeline_evidence`: immutable occurrences (update/delete
    refused by trigger), unique per (source, occurrence_key). No customer
    columns. A retraction row (`retracts_key`) withdraws one exact earlier
    occurrence of the same source from its own time; for example, a scan
    cancelled after it was copied. History is never edited.
  - Service-only RPCs: `ingest_order_timeline`, `read_order_timeline`,
    `read_order_flow`, `reconcile_order_timeline_app`. RLS is on, and anon and
    authenticated have no table or function access. Over-limit reads are
    errors, never truncation.
  - No trigger on `production_events`, no backfill, no F1 generation
    dependency.
- `api/orders/timeline.ts` replaces the retired unauthenticated
  `api/shopify/whoami.ts` (no app caller), so there are still 12 functions:
  - `GET ?action=order` / `?action=flow`: owner/manager with membership; CS
    only with explicit Reports permission + membership; staff/kiosk 403
    before any read.
  - `POST {action:"reconcile",site,orderNumber}`: owner only. Copies that
    order's recorded app framing/dispatch for that site, then resolves the immutable order ID and makes a second, generation-fenced
    read-only Shopify GraphQL query (Admin API `2026-10`) and records the
    order. No mutations, fulfillment actions or subscriptions.
  - `POST` with `X-Shopify-Hmac-Sha256`: order webhooks (`orders/create`,
    `orders/updated`, `orders/cancelled`, `orders/fulfilled`,
    `orders/partially_fulfilled`). Checks run in this order: size ≤ 1 MiB,
    secret, raw-body HMAC, allowlisted shop, ingestion enabled; JSON parsing
    and database work come only after all of them. A persistence failure
    returns 503 (Shopify retries).
- Reports: "Order timeline" lookup card and "Order flow durations" for
  owner/manager/CS. Durations only: median/P90, sample/unknown/anomaly counts,
  and a coverage label ("recorded orders, not complete Shopify history").
- Additive 0061 validates the scanner receipt and its original events, records full framing at scan time, and withdraws proof when an event is cancelled or its source disappears. Classic/manual completion remains partial. Completeness is scanner-attested, not a new Shopify quantity check.
- Additive 0062 stores a service-only generation/revision/hash and active proof keys. Refresh takes a ticket before reading Shopify. Stale results cannot overwrite newer proof. Changed/absent proof withdraws the previous keys at first observation and uses fresh revision keys for any new proof. Webhooks can invalidate, never promote whole proof.
- Shipment proof requires an explicitly unedited, uncancelled order, complete lists, successful fulfillments and exact coverage. Bounds: 50 order lines, fewer than 20 fulfillments, at most 20 lines per fulfillment. Ambiguity stays unknown. Shipment time is the latest contributing fulfillment creation; delivery is the latest actual Shopify-reported delivery time only when every contributor has one. No use of current fulfilled state or updatedAt as historical delivery time. The UI labels delivery provenance accordingly.

## Configuration (server env, Preview/staging only until approved)

| Name | Purpose |
|---|---|
| `ORDER_TIMELINE_INGEST` | `on` enables webhook ingestion and Shopify reconciliation. Unset = disabled (rollback switch). |
| `ORDER_TIMELINE_ROUTING` | Routing contract JSON (below). Missing/invalid = fail closed. |
| `SHOPIFY_WEBHOOK_SECRET` | The app's webhook signing secret (Shopify client secret). |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | Existing; reconciliation reads only, and only when the shop is in the routing allowlist. |

Routing contract (one shared store; the shop never implies a site):

```json
{"version":1,"shops":{"<shop>.myshopify.com":{"kind":"shipping_country","map":{"AU":"au","GB":"uk","US":"us"}}}}
```

The commissioned Preview uses `shipping_country` for the one shared shop `inka-arthouse.myshopify.com`. CJ selected nearest production facility by order delivery country. A reviewed 242-country map uses country reference points and actual Airport West (AU), Derby (UK) and San Diego (US) facility coordinates. RETURNS PILE is excluded. This is a country-level geographic approximation, not customer-address distance or transit time. Missing/unmapped countries remain unrouted; no catch-all. The current snapshot omits AC, AX, BL, BQ, CW, MF, SS, SX, TA and UM. Live printing routing was not changed.

## Accepted staging checks

- Local gate: 3,373 tests / 139 files, type checks and build pass. Review corrections cover deleted scan sources and missing current routing.
- Owned fixtures: `10999991` shows all ten steps; `10999992` shows partial framing after a per-line cancellation. Exact scanner/reconcile replays add no evidence. Inventory ledger remains empty, prior order `99000001` keeps its eight facts.
- Complete shipment/delivery fixture uses the actual service code and hosted database with synthetic Shopify input. Five automation reports for this fixture were posted directly to the scoped endpoint, not executed by Make. Earlier actual staging Make-chain validation remains on `99000001`.
- A real read-only refresh of shared-store order `10250610` succeeds through the deployed API, routes to US and proves full shipment at its Shopify fulfillment creation time. Delivery remains missing because Shopify has no deliveredAt. No real Shopify order was mutated.
- No session returns401; non-owner reconciliation returns403. Browser confirms complete and cancelled-scan states. The separate production summary has no published F1 snapshot in this fresh staging database.
- Automatic webhook subscriptions and deployed raw-body HMAC acceptance were not commissioned; use explicit owner Refresh sources. There is no historical backfill or lateness classification.

## Rollback

Unset `ORDER_TIMELINE_INGEST` (ingestion and reconciliation stop; reads keep
working). Redeploy the previous Preview to remove the cards and endpoint. The
additive tables and history are retained. Printing, scanning and stock never
depend on this feature.

## Monitoring

Watch for `[order-timeline]` log events (`webhook_bad_signature`,
`timeline_conflict`, `timeline_ingest_failed`, `timeline_too_large`). The flow
card shows unrouted orders and the latest receipt per source. Storage grows
by a few rows per order.
