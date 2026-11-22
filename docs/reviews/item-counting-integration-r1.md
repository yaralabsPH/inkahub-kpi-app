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
