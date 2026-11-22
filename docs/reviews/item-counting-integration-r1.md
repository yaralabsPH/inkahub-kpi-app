# F1 integration review 1

Base f78da60; F1 source3fd8b49; merge41774fa plus subsequent Claude task2/3 work pending at review time. Independent reviewer inspected actual merge seams, not the entire previously-reviewed F1 system. No database or deployed browser claims.

Important fixes required:
1. Production.tsx passes only counter.normal into default StationOrderScreen. Unlike classic screen, no count status/coverage/retry/rework arrives. After a successful load followed by failed evidence refresh, old numeric KPI appears current; CS/rework disappears. Pass and render F1 status/coverage/retry and distinct rework, using existing primitives. Test failed refresh retains clearly stale figures rather than pretending current, and rework stays separate.
2. Reports.tsx published raw export now awaits F7 attribution after pub.collectAll has completed and unregistered its collector. Site/range/user/generation change in that await can still download old-view CSV. Check captured request identity/generation immediately before blob/download, covering attribution await, and refuse with existing VIEW_CHANGED behavior. Test delayed attribution + view change prevents download.
3. Confirm subdaily refresh crons removed per approved staging Hobby exception; task2 expected to handle this.

Scanner multiplier seam preserves previous routing, quantity and stock semantics. F4 filters and both API typecheck scripts retained. No need speculative redesign. Fixes are explicitly within approved integration scope.
STATUS: FAILED – station reporting state and published export consistency require correction.

## Controlled staging progress (Codex, 2026-11-23)

Installed-state inspector matched all effective reporting function bodies, grants, indexes and collation. Missing0044/0045 receipts are a pre-existing historical receipt issue; the actual installed implementations match. Its receipt parser rejects installed0047 and old clean-site rehearsal refuses retained abandoned batches. Do not delete those batches or rewrite installed migrations to make an old clean-site harness pass.

An actual owned application rebuild is underway on isolated staging ybrzhrgfrnvtcwymjdrq, using original F1 projector3fd8b49. Capture is now ON at owned epoch28; AU processor enabled, legacy read mode retained. This supersedes the earlier OFF/epoch27 note. Batch2b300cb8-5d43-4ec0-a94b-c33daf5c7dc1 froze155441 source images, cutoff2026-11-22T23:24:49.595311Z. Standard worker progress was saved and the owned process stopped because per-owner RPC planning would take days.

Actual Claude prepared an external one-time bulk operator. Read-only dry run matched all55626 owners and146 saved descriptors with zero mismatches; generated114490 descriptors, max owner input31 events, no heavy-owner rejection. It uses unchanged shared projector + existing bounded plan/seal/claim/stage/publish RPCs, full coverage/manifests and original data hashes. It does not prove scheduled-worker scalability or old R0-R7 qualification. Root is running it with cutoff01:55UTC. No production changes. Hosted evidence remains pending; do not report it as passed.

## Coder response (Claude, 2026-11-23)

1. Fixed. `StationOrderScreen` takes optional `todayState`, `todayRework`, `countStatus` and `onRetryCount`. A `stale`/`error` counter is dimmed and marked "Not current (refresh failed)" with Retry in the top bar (idle and working views). CS/rework shows on its own line, never folded into normal work. The idle sidebar renders F1's compact `ProductionCountStatus` (cutoff, coverage issues, retry). Production passes `counterEvidence.status`, `counter.rework`, `refreshCounter` and the status line. Tests: 4 new in `StationOrderScreen.test.tsx`, failed before the change; source seam in `item-counting-integration.test.ts`.
2. Fixed. `collectAll` takes `beforeFinish`, run after the last page inside the collector scope, then re-checks abort/identity/generation and rejects `VIEW_CHANGED`. Reports' published export does its F7 attribution read there; only synchronous work follows before the download. Test: `published-reporting.test.ts` "integration r1 #2" (identity change and reset during the delayed read reject; unchanged view resolves), failed before the change.
3. Confirmed in `c77cb96` (daily digests only; refresh definitions dormant in the release doc).

Checks: `npx tsc -b`, `typecheck:digest`, `typecheck:api` clean; focused files 131/131 + 11/11. Full suite deferred to the F8 combined gate as instructed.
