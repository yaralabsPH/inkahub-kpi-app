# F5–F7 combined Preview acceptance

Completed 2026-11-23 00:51 Asia/Shanghai with actual Claude Code implementing and deploying, and Codex independently reviewing and checking the hosted workflows.

Preview: https://inka-arthouse-3c01u4pq5-inka-arthouse-s-projects.vercel.app/

Deployment `dpl_4EvSRJUfJ2xzLSp6tCUZncUS1LaD` is READY, built from `78c78fa3fa1a1a8da5ce5ac7bc66fb01e927fe57`. This includes F5 Departments, F6 Shared scanners and F7 Dispatch. Subsequent handover changes are documentation only. No main merge, production deployment, domain, alias or environment-setting changes occurred. Production deployment before/after remained `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf`; remote main remained `8519ac9a9af66167903107d5ad8fb7a65e0278a9`.

## Hosted acceptance

- Departments: owner Team page loads departments, assignments/history, change log and tracking controls against staging. Tracking remains OFF pending the real roster. Full create/rename/assign/move/archive/restore, permissions and conflict flows were checked in the earlier F5 browser/SQL acceptance.
- Shared scanners: synthetic kiosk, Australia, three-scanner receiver; native keyboard bursts using `<S1>…</S1>` plus Enter activated a badge and saved a real Shopify order lookup as one verification and one completion. Mode switch cleared identities.
- Dispatch measured path: missing stock initially refused the save. The blocked job survived a full reload. With temporary staging stock/box rules installed, Retry retained the originally captured worker and saved the dispatch without requiring a new badge. Stored attribution used the framing scan; exactly one component and one box were deducted.
- Duplicate dispatch: another scan showed “already dispatched — nothing more saved”; event count, stock and ledger stayed unchanged.
- Manual path: after resetting only our disposable order fixture, missing framing evidence opened the compact picker. Selecting the synthetic staff member saved a clearly marked MANUAL dispatch, exactly one component and box, and no fabricated framing events.
- Reports: order lookup displayed Manual and the person who selected the framer. The actual downloaded CSV contained `framed_by` and `framer_evidence`, including the expected staff name and SKU-specific manual marker. Browser download-event notification timed out, but the completed local CSV was inspected directly.
- The complete compiled JS was fetched through Claude's Vercel connector: HTTP 200, staging project reference present, production project reference absent, and all three feature markers present. SHA256 `d81f81ca392ab5be8040947f17ab28d55c4c5ccd601a061b791b77391cc81338`. This supersedes the initial deployment report's pending bundle check.

## Cleanup and limits

Exited the receiver before removing all temporary order events, receipts, attribution, receiver, stock, box rules and settings. Final actual-database full-row hashes of existing products, ledger and all 240123 production events matched the baseline exactly. No scanner/dispatch receipts, attributions, receivers, departments or race sites remained. F5 tracking and F1 reporting capture remained OFF. The temporary Claude upload hook was removed, preserving the previous local settings.

Evidence and screenshots are in the external operator folder `C:/Users/cjgom/dev/overnight-20261122/`: `dispatch-measured.jpg`, `dispatch-manual.jpg`, `dispatch-report.jpg`, `dispatch-report.csv`, `departments-preview.jpg`, `combined-ui-reset-order-*.json`, `combined-ui-cleanup-*.json`, `f7-clean-verification.json`, and `preview-deploy/compiled-verification.json`. No credentials are included in repository or deployment artifacts.

Software acceptance is complete for isolated staging. Physical cordless scanner prefix/suffix, range and simultaneous-device commissioning still require the actual hardware. Real department assignments and approved stock/box rules remain business setup; temporary test configuration was not retained. Production rollout is outside this task.
