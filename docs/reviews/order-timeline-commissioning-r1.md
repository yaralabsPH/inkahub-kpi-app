# Source refresh review and staging acceptance

Reviewed application: `cccb0b557d4b8e8a17b524e637c07ab674f34258`, branch `feature/order-timeline-commissioning`, draft PR21 stacked on PR20. Actual Claude wrote the implementation; Codex reviewed and commissioned staging.

## Outcome

Owner-only **Refresh sources** calls existing reconciliation and reloads the same order. Ordinary readers retain stored-data Refresh. Source conflicts, partial failures and missing Shopify configuration are shown as incomplete. Per-identity request locks survive A-B-A navigation; abandoned intents are checked again after awaiting the auth token. Review found and Claude fixed three issues in these areas. Final independent review: no remaining material findings.

## Verification

- Focused UI tests: 40 passing. Required final gate: 139 files, 3,319 tests; build and type checks pass. GitHub Actions 45172058349 completed successfully on the application commit.
- Preview deployment `dpl_hkwZc8w3jWDqqeCoQ6J7ibonh9D4` is Ready: https://inka-arthouse-c7nv30kth-inka-arthouse-s-projects.vercel.app.
- Served bundle points only to Free staging `rsfdqkjasiozmbdtgquv`; no service-role key. No-session timeline API returns JSON 401 through normal deployment-specific preview access. No aliases, shared environment records or production deployment changed.
- Hosted acceptance: 30/30 checks passed on owned AU synthetic order `99000001`. Owner POST succeeds; unauthenticated POST is 401; manager, CS, staff and kiosk POSTs are 403. Two matching classic app source rows yield partial framing and confirmed dispatch at exact fixture times. The six prior Shopify/Make facts are unchanged. Repeated reconciliation returns zero new / two duplicate app facts and keeps eight total facts.
- Network faults interrupted earlier attempts. The successful acceptance used the existing-fixture repeat path; do not claim a completed first-insertion assertion. A temporary external transport helper selected a DNS-verified reachable staging A record while preserving TLS verification, and retried only reads/sign-ins. It never retried reconciliation or source writes. Local sign-out also logged a network failure; this is not evidence of global session revocation.
- Browser verification on the new Preview: owner clicked Refresh sources and saw the incomplete warning, zero new / two already recorded, partial framing, recorded dispatch, and missing shipment/delivery. Screenshot and private operational evidence remain outside git.

## Remaining scope and release boundary

This validates source-refresh UI and classic app-event adaptation, not whole-order completion or physical scanning. Real Shopify ingestion remains unconfigured pending CJ's definition of order location: customer delivery country, assigned warehouse, or printing form. Existing rollout documents favor form/chain; do not silently infer shipping country. Whole-order framing and shipment/delivery proof require reviewed source coverage and real timestamps. Do not substitute current fulfillment status or updatedAt for historical delivery time.

No new migration, dependency, inventory operation, Shopify mutation or Make call occurred in this continuation. Paid/live Supabase was not accessed. All staging Make copies remain at their previously verified inactive state; this continuation did not re-query them. Rollback is the previous Preview; no production rollback is required. Do not merge to main or claim full journey commissioning complete.

STATUS: COMPLETE
