# Country routing and whole-order proof: review and staging acceptance

Reviewed application: `b2e3afccf0575e0ebfc08a30bc82f10facde271b`, branch `feature/order-timeline-commissioning`, draft PR21. Actual Claude Code implemented app/SQL/tests and performed the exact-source Preview deployment; Codex planned, reviewed, applied Free-staging SQL and verified hosted behavior.

## Review outcome

No remaining material findings in the commissioned scope. Independent reviews checked all 242 country assignments and provenance, scanner proof, and generation-fenced shipment/delivery proof. Claude fixed two P2 issues: a deleted scan source leaving full framing active, and a previously routed identity retaining whole proof when current routing becomes unknown. Offline PGlite reproduced both failures and verified their corrections. The required full suite also caught an old migration-tail assertion; its exact sequence was extended for0061/0062 without weakening historical hash checks.

## Verification

- Final local run: `npm run test -- --run --maxWorkers=2 --minWorkers=2`:139 files,3373 tests pass. `npx tsc -b`, `npm run typecheck:api`, and build pass. The initial default-parallel run had the migration-tail failure and three reporting-worker5-second timeouts. After the assertion fix, bounded concurrency passed the entire suite with unchanged timeouts and app code.
- Exact application Preview: `dpl_BGwnuREdT1nQcBQsuU7XHcQ3VLdK`, Ready at https://inka-arthouse-bzm9p9cwg-inka-arthouse-s-projects.vercel.app/reports. The201-file manifest has SHA256 `31dd558bb8d7b2fc4563745a3def8a5d1da47633fae41772d001a345dd9f1c32`. Browser bundle uses only new Free staging and contains no service-role key.
- Applied only0061/0062 to `rsfdqkjasiozmbdtgquv`. New proof state has RLS, no browser table privileges, no browser RPC execution, service-only invoker functions with fixed search path. Advisor adds only the expected informational no-policy notice for a service-only table; prior warnings remain unchanged.
- Hosted scanner51/51 and cancellation20/20 checks: real kiosk `scanner_commit_framing`, owner cancellation through normal RLS, source copying, exact scan/cancel timestamps, full-to-partial transition, duplicate replay, role denial, no inventory deductions. Existing order99000001 retains eight facts.
- Hosted whole journey30/30 checks: actual reconcile/read service code + real hosted RPCs, synthetic Shopify snapshot. Full framing13:09:53UTC, dispatch13:10:23, shipment13:10:53, delivery13:11:53 on23November. Exact adjacent gaps30s,30s,60s; one parcel, unchanged replay. This is synthetic coverage, not physical scanner hardware or a real delivered carrier order.
- Five synthetic automation reports for10999991 were accepted through the new Preview endpoint, yielding all ten stages. They are direct HTTP fixtures, not new Make executions. Earlier actual Make-chain acceptance remains documented on99000001.
- Preview HTTP14/14 checks: unauthenticated401, manager/CS/staff/kiosk reconciliation403, full fixture read, cancelled-scan partial framing, and a real read-only owner refresh of10250610. Shopify source confirms US destination routes to US, whole shipment at2026-11-20T15:39:48Z, no delivery timestamp. No Shopify writes.
- Browser: owner lookup shows every step and duration for10999991;10999992 shows partial whole-order framing. Delivery is labelled Shopify-reported. Screenshot and private access/results remain outside git.
- Two hosted attempts stopped on transient reads/RPC transport errors. State was inspected before retry: no duplicate fixture writes, generation1 and revision1 intact after the interrupted repeat. Completed runs then passed. The external test transport pins a DNS-verified reachable staging address while retaining TLS; read/sign-in retries only, never blind write retries.

## Routing and release boundary

CJ chose delivery country -> nearest facility. Map covers242 country reference points to Airport West, Derby and San Diego, excluding RETURNS PILE. It approximates country-level distance, not individual addresses or shipping time. Missing/unmapped codes remain unrouted; current omitted codes AC,AX,BL,BQ,CW,MF,SS,SX,TA,UM. Configuration is Preview-only; all other environment record IDs/timestamps are unchanged.

Production remains `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf`. Paid production DB and old staging were not accessed. No billing, main merge, production deployment, live Make edits, printing or messages. Six isolated printing clones8746725/26/28/30/31/32 and inspector8751146 are inactive; all seven hook queues zero at final verification.

Use explicit owner Refresh sources; automatic Shopify subscriptions/raw-body HMAC acceptance and historical backfill are not commissioned. Edited/ambiguous/over-limit orders remain partial or fail visibly. Corrected parcel dates can preserve an old immutable base fact and show a conflict while aggregate proof advances. Same numeric order ID across multiple shops is not supported by current occurrence keys; this release is one shared shop. Fresh-staging production summary has no published F1 report; the independent timeline and flow-duration cards work. No lateness labels were added.

Rollback: retain additive history and revert to the prior Preview; disable staging ingestion to stop new reconciliation if needed. Never roll back production for this staging-only release.

STATUS: COMPLETE
