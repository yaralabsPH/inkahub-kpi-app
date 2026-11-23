# F10 Order timeline — release notes (staging only)

Branch `feature/order-timeline`. Nothing here is applied, pushed, deployed or
registered by the coder. Production and the three live Make systems are not
touched. Staging and live acceptance are **pending**.

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
    order's recorded app framing/dispatch for that site, then makes ONE
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
- What the Shopify data can and cannot prove:
  - Each fulfillment is recorded at the time it was created in Shopify. That
    is not whole-order shipment, so order-to-complete-shipment stays unknown
    until a source that times whole-order shipment is commissioned.
  - Delivery is per fulfillment. Whole-order delivered needs explicit proof
    (none today).
  - Shopify's current "fulfilled" state is never used to backdate a time.

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

`kind` is `shipping_country` (ISO alpha-2), `order_tag` (exact tag), or
`note_attribute` (with `name`). Zero or several matching sites means
unrouted, with a reason. **The real predicate must be root's verified AU/UK/US
routing field from the current printing system.** The map above is an
example, not a ruling. If the verified field fits none of the three kinds, a
small additive extractor is needed first.

## Staging steps (root, after database recovery/headroom)

1. Apply 0059 on staging only. Rollback-transaction checks: authenticated and
   anon cannot select either table or execute the four RPCs; service role can
   run them; update/delete of evidence fails.
2. Tiny replay fixtures (synthetic shop/order ids, no bulk load): ingest an
   order, replay it (duplicate), alter it (conflict, original kept), send a
   fulfillment before its order (unrouted, then routed), and route it to a
   second site (conflict, site unchanged). Use the same order number at two
   sites and confirm they never merge.
3. **Routing stays unset** until the user explains which location decides the
   site (shipping country, Shopify fulfillment location or submitting-form
   site) and root verifies it. Then set up the Preview env with that routing
   JSON and a staging webhook secret. Oversized tag (>250) or attribute
   (>100) lists leave an order unrouted.
   Send signed synthetic payloads. Expect: wrong signature 401, other shop
   403, oversized 413, valid 200. **Confirm the raw body is readable on
   Vercel**: a 503 `CONFIG` "Raw body unavailable" means the runtime parsed
   the body first and the adapter needs changing. It never accepts unsigned
   data.
4. Per role on Preview: owner (lookup, flow, reconcile), manager (lookup/flow;
   reconcile 403), CS with/without Reports, staff/kiosk (no cards; API 403).
   Switch sites mid-lookup: the old order never shows under the new site.
5. Confirm the order-number alias: Shopify name minus one leading `#` equals
   the app's scanned order number.
6. Reconciliation commissioning: owner reconciles a few known staging orders.
   Shopify webhook subscription is a separate, human-approved step, and it
   is not done by this branch.

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
