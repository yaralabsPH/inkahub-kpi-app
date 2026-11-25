# Review: UI redesign — round 3 (final allowed round)

- Slug: `ui-redesign` · Branch: `feature/ui-redesign` · Reviewed commit: `a1a9f846d9c8f1f653223fad8062fa5a7b9345a6` (detached HEAD)
- Base: `68cba07`; full scope: `68cba07..a1a9f84`. Round-2 fix inspected with `git show a1a9f84`; incremental comparison: `12b05b3..a1a9f84`.
- Reviewer: planner (GPT-6 Astra) · Date: 2026-11-25
- Verdict: **approved**

R2-M1 and both round-2 Should-fix items are resolved. No new code blocker was found. This is final code-review approval for the inspected candidate, not production-release approval or a claim that all acceptance checks passed. Tasks 15 and 19 remain open for CJ's disposition and release evidence. No fourth automated review round is requested.

## Checked against

- [x] Spec acceptance criteria — source reviewed against `docs/specs/ui-redesign.md`; outstanding human acceptance evidence is listed below.
- [ ] Plan tasks (all done, nothing extra slipped in) — reviewed; Tasks 15 and 19 correctly remain unchecked (`docs/plans/ui-redesign.md:200`, `:235`). The fix adds no new feature scope.
- [x] AGENTS.md guardrails (both backends, migrations, RLS, secrets, whitelist) — protected-path comparison is empty; no dependency, backend or schema change.
- [x] `docs/HARDENING.md`, every section — assessed below; checked means reviewed, not that pending staging checks passed.
- [x] Roadmap decisions for this feature (`docs/ROADMAP.md`) — additional post-bulk presentation work; S1/F1–F12 decisions remain unchanged.
- [ ] Tests cover the new logic; type-check, tests and build pass — all three type-check commands passed; full Vitest and Vite build were blocked by sandbox access errors. Limited in-memory checks passed, with limits stated below.

Read AGENTS.md, architecture, roadmap, hardening, spec, plan, review template, release guidance and rounds 1–2 including Coder responses. Rechecked the full changed-path inventory, the incremental fix, shared primitive/shell boundaries, current overlay consumers and prior finding dispositions. An independent read-only overlay review supplemented this review. No browser, remote CI, database or deployed service was accessed. Only this review file was authored; no app edits, commits, pushes or state-changing git commands were made. Pre-existing untracked `supabase/.temp/` was left alone. The architecture is a historical map; current source governs permissions and reporting behavior.

## Must-fix

None identified in the reviewed candidate. CJ's release conditions below remain mandatory and are not being converted into additional coder fix rounds.

## Should-fix

None outstanding from round 2; both items are closed below.

## Nitpicks

None.

## Round-2 disposition

| Item | Final disposition | Evidence |
| --- | --- | --- |
| R2-M1 — background content mounted while an overlay is open | **Resolved in code.** | `src/components/ui/UiPresentation.tsx:46` now retains the ancestor path and acquires current siblings, then observes child additions on every path container (`:72–81`). A later `DatasetRefreshBanner` under main is acquired without making the active panel's ancestor inert. The actual banner remains at `src/components/layout/Layout.tsx:88`; its read-only Retry behavior is unchanged. |
| Should-fix 1 — implementation-log reconciliation | **Resolved.** | `docs/plans/ui-redesign.md:340` explicitly retracts the nonexistent SKUs Order Builder mount and supplies task commit references. A fresh source search finds the sole `<OrderBuilderModal>` mount at `src/pages/Shipments.tsx:557`; read-only git log matches the listed task SHAs, including Task 16's follow-up. The older r1 statement is retained as historical text and explicitly corrected in the canonical log. Task 19 entries remain evidence of work in progress, not completion. |
| Should-fix 2 — productivity legend colours | **Resolved.** | `src/pages/Reports.tsx:1805–1806` uses `bg-hub-accent-text` for Orders and a dashed `#64748b` border for Items. These match the accent/currentColor Orders line and dashed `#64748b` Items line at `:1819–1820`. No series data, axis, reducer, filter or export changed. |

The round-1 source fixes accepted in round 2 remain in place: shipment builder/archive coverage, backend-specific confirmation predicates, requested-quantity wording, read-error states, parent-owned SKU forecast, focus/chart contrast, reduced-motion navigation, permission-aware Warehouse link, visible rail tooltip and truthful backend badge. The final increment changes only two application files (`UiPresentation.tsx` and the two Reports legend markers), plus plan/review documentation. It does not alter those other fixes. Round-1 M6 is now closed in source; M9's remaining Task 15/19 evidence stays with CJ.

## Overlay stacking, ownership and cleanup

- **Live isolation:** acquisition excludes the active container/ancestor path and de-duplicates each overlay's owned elements (`UiPresentation.tsx:50–60`). The observer watches direct child additions on those ancestor containers, not every descendant or attribute. Descendants of an already-inert sibling inherit isolation; a newly added sibling such as the refresh banner receives its own inert attribute. Attribute writes do not feed back into this child-list-only observer.
- **A newer modal stays usable:** the older observer skips added nodes that are, or contain, `[role="dialog"][aria-modal="true"]` (`:43–44`, `:76`). Current ShellModal, SideSheet, drawer and palette wrappers satisfy that test. Crucially, the initial scan at `:68–69` does **not** skip existing modals: a newly opened upper overlay still makes the lower overlay inert. Thus the older observer does not undo the upper overlay's accessibility by making its new wrapper inert. The active overlay's own scrim remains outside its sibling isolation.
- **Actual stacking locations:** Shipments' confirmation is rendered after its form/builder (`src/pages/Shipments.tsx:521–563`); Order Builder's confirmation follows its modal (`src/components/OrderBuilderModal.tsx:1048–1053`). The CS confirmation remains beside the custom editor panel inside its outer wrapper (`src/pages/CsCases.tsx:915–916`, `:1268`), so the confirmation can isolate that editor without isolating its own ancestor. The outer custom CS editor itself still lacks shared overlay semantics, as documented in round 2; this patch does not certify that editor's accessibility.
- **Reference counts:** an already-owned sibling gains one reference per overlay; repeat deliveries/reinsertions do not add another reference for the same owner. Closing either stacked overlay preserves references still held by the other. External inert attributes present before acquisition are not claimed or removed. Removed nodes remain in the owner's list until cleanup, where its references are released; no persistent owned-reference leak was found in the exercised cases.
- **Teardown:** cleanup cancels scheduled focus, removes that overlay's key/focus listeners, disconnects its observer, then releases its inert ownership (`:183–188`). It removes its stack token, decrements the body/main scroll-lock count and restores saved overflow only when the last overlay closes (`:189–195`). Focus restoration happens afterward and checks that the original element is still connected (`:197–198`). Topmost-only Escape/Tab/focus containment remains unchanged. Browser checks are still required for focusability, disabled/disconnected triggers, resize, navigation and simultaneous unmounts.

The independent reviewer executed the actual extracted `isolate`/`release` functions in memory across **12 cases**: sibling, root-level and nested wrapper shapes × both close orders × observer delivery before/after upper acquisition. Late siblings, upper panel/scrim usability, lower isolation, external inert preservation and final zero owned references passed. This was a minimal element/observer model, not React, a browser, scroll simulation or a screen reader. The Coder's Dexie browser observations at plan `:340` are separately attributed historical evidence, not a browser run performed by this reviewer.

The modal exemption assumes the current mount structure. Future overlays mounted inside a previously isolated background subtree need fresh lifecycle checks; no current reachable caller requiring that structure was found. This is a maintenance constraint, not a new blocker.

## Scope and protected paths

Fresh `git diff --name-only 68cba07 a1a9f84 -- <protected paths>` is empty for:

- `src/lib/repository/`, `src/lib/auth/`, `src/lib/domain/`, `src/lib/hooks/`, `src/lib/state/`, `src/lib/forecasting/`, `src/lib/csv/`;
- `src/components/production/`, `src/pages/Production.tsx`, `src/App.tsx`;
- `api/`, `supabase/`, `package.json`, `package-lock.json`, `vercel.json`, `.github/`, `.env.example`.

The full inventory contains no new station/scanner, migration, credential or integration-configuration file. Both repository implementations/interface, permissions, route guards, schema/RLS, business helpers and dependency files remain untouched. Existing whitelisted `src/` and `docs/` paths cover the additions.

The shared-primitive comparison retains the original legacy Button/Card/Input/Select/Field/StatusPill branches. `Modal.tsx:16–17` selects the unchanged legacy behavior outside the presentation provider; the new observer runs only through opt-in shell overlay consumers. Layout enables the provider and shell scope; `/production` remains outside Layout. CSS remains scoped and Tailwind extensions additive. This supports source parity for the protected station, not an assertion that its device/browser smoke test has been performed.

No new write Retry, Undo, grouped purchase mutation, report route, palette action, paper save mode, invitation or comment workflow was introduced. The shipment helper's narrowly scoped presentation-only backend distinction accepted in r2 is unchanged. Confirmation remains a description of a requested operation from loaded state, not a lock, freshness guarantee or proof of exactly-once persistence.

## Hardening assessment — every checklist item

| Item | Final assessment and remaining evidence |
| --- | --- |
| 1.1 Down/slow services | Dataset errors and existing read Retry remain visible; live background isolation now covers later banners. No new integration dependency. CJ still tests slow/offline reads and draft retention. |
| 1.2 Retry/idempotency | Retry invokes the existing read refetch only. Confirmation cancellation precedes the existing write and its resolver is cleared before invocation. No write retry or new idempotency claim; fixture cardinality/pending checks remain required. |
| 1.3 Concurrent devices | Existing backend semantics retained; confirmation uses a snapshot and requested-amount wording. Two-session parity remains staging work. |
| 1.4 Bad input | Existing parsing, schemas, selection IDs and validation retained. Missing SKU/zero/short stock fixtures remain required; barcode/cancelled/wrong-site handling remains protected and needs station smoke coverage. |
| 1.5 Failure and recovery | Initial error and cached-data failure are distinct. Actual error → Retry → data, and dirty-form background failure, remain CJ's checks; source inspection alone cannot prove retained drafts. |
| 2.1 Attribution | No worker, department, scanner identity or attribution logic changed. Verify role/station/report outputs against baseline. |
| 2.2 Shared counts | Domain/report/forecast calculations unchanged; peek still consumes its parent's forecast. Legend fix is decorative. Compare totals and exports in staging. |
| 2.3 History | No historical rewrite or schema/settings semantics change; report/settings sections remain mounted. Historical fixture parity remains required. |
| 2.4 UTC/site time | Timestamp/date handling unchanged. AU/UK/US production-day and location-reload checks remain required. |
| 2.5 Manual/inferred values | Existing method/manual/inferred/coverage/stale/unpublished labels retained; requested stock effects are not relabelled as measured final balances. |
| 3.1 Endpoint auth/input | N/a for changes: no new or changed endpoint. Existing authentication/validation boundaries retained. |
| 3.2 Tables/RLS/roles | N/a for new tables/policies: none. Navigation still consumes effective access; all-role/override/direct-URL evidence remains required. |
| 3.3 Secrets | No new secret exposure/configuration change in the reviewed diff; environment badge remains display-only. No credentials were read or logged for this review. |
| 3.4 Cost/spam/exposure | No new sends, external calls or owner-data surfaces. Existing gates retained; shared dataset observer is unchanged by this fix. Account-switch/access checks remain pending. |
| 4.1 Migration compatibility | N/a: no migration or contract change. App-only rollback uses the same schema and stored payloads. |
| 4.2 Off switch/shop floor | No feature flag, as specified. Station remains outside the shell; CJ's fallback is the known-good post-bulk deployment. |
| 4.3 Release sequence | Separate release after bulk stability; final candidate CI/staging evidence and recorded rollback target first. No SQL or integration changes for this redesign. CJ alone merges/deploys. |
| 4.4 Per-role staging | Still open: owner/manager/staff/kiosk/CS, defaults/custom/empty overrides, internal gates, direct URLs and site switches on the final Preview. |
| 5.1 Long scans | No query/range/index/aggregation change. New overlay observer is child-list-only on ancestor containers, disconnected on close; large-data request/render comparison remains pending. |
| 5.2 Per-item APIs | None added. Existing caching, lookup paths and parent-owned forecast remain unchanged. Browser network comparison still required. |
| 5.3 Two years/three sites | No scale guarantee from type-checks. Use long-range fixtures and all three sites; retained baseline caps are not fixed by this UI work. |
| 6.1 Detect faults | Existing error states, scanner/report health and browser/Vercel logs retained. CJ monitors errors and staff availability after release. |
| 6.2 Manual fallback | Standalone station remains available; app Instant Rollback to the recorded post-bulk target. Reconcile uncertain writes from ledger/history before retrying. |
| 6.3 Maintenance | No new storage, token or integration lifecycle. Keep overlay mount structures/cleanup checks and backend-specific confirmation predicates aligned with later changes. |
| 7.1 Pure logic/edges | Fresh limited execution of 43 existing appearance/picker/shipment/navigation cases passed; independent overlay model passed 12 cases. Neither replaces full Vitest or manual accessibility checks. |
| 7.2 Inventory/credit/money | No arithmetic/ledger/backend changes. Existing suites preserved; before/after payload, cardinality and ledger fixtures remain required. Task 15 restock acceptance remains withheld pending CJ's disposition. |

## Verification performed in this review

Windows `.cmd` launchers were used without changing execution policy, requesting elevation or bypassing the sandbox.

| Check | Fresh result |
| --- | --- |
| `npx.cmd tsc -b` | **PASS**, exit 0. |
| `npm.cmd run typecheck:api` | **PASS**, exit 0. |
| `npm.cmd run typecheck:digest` | **PASS**, exit 0. |
| `npm.cmd run test -- --run` | **BLOCKED**, exit 1 before discovery: esbuild cannot read `../../../../..` (Access is denied) or resolve this worktree's `vite.config.ts`. No fresh full-suite count. |
| `npm.cmd run build` | **BLOCKED**, exit 1 at Vite configuration loading after TypeScript, with the same parent-directory access error naming generated `vite.config.js`. No successful bundle verified here. |
| `git diff --check 68cba07 a1a9f84` | **PASS**, exit 0. |
| Protected-path comparison | **PASS**, empty against base for all listed paths. |
| Existing presentation-helper cases, in memory | **PASS**, 43 cases: appearance 8, picker 6, shipment 15, navigation 14. Actual TypeScript modules and existing test bodies executed using a small Node assertion harness; actual schemas/permission functions loaded. Not a Vitest run, browser check or backend integration test. No files written by the harness. |
| Overlay lifecycle, independent in-memory check | **PASS**, 12 cases described above; not browser/screen-reader/React certification. |

The six Windows CRLF migration-hash failures are identified as pre-existing by the user and prior Coder evidence. This sandbox run stopped before reaching them, so it does not freshly reproduce or clear them. The plan's 3450 passing tests plus six known failures and successful build are historical Coder results only. Do not edit old migrations or weaken hash tests. Normal CI must be green on the final PR; remote CI was not inspected here.

## CJ's remaining release conditions

1. **Bind Preview evidence to the candidate.** Verify that Preview **`inka-arthouse-csb3prahi`** serves `a1a9f84` (or explicitly record the final replacement SHA/deployment). This Preview name comes from the review request; its SHA was not independently checked. Confirm frontend and server targets are **inka-staging-2**, with safe test integration values/recipients and display-only `VITE_APP_ENV=preview`. Prior Preview evidence is historical, not proof of this candidate. Never use production for these tests.
2. **Complete the role matrix and station smoke pass on that Preview.** Owner, manager, staff, kiosk and CS; default/custom/empty `allowed_nav`; non-owner Dashboard/Stock Value denial including direct URLs; owner retained Welcome/Settings; internal report/accounting/team gates; sign-out/re-login and AU→UK→US reload isolation. Staff's current default includes Reports. Exercise kiosk clock/scan/verify/complete/dispatch, station binding, legacy dialogs, lookup and inventory/packaging retry smoke checks.
3. **Complete mobile, keyboard and screen-reader acceptance on that Preview.** Desktop and 375/767/768px; light/dark/system and OS change; reduced motion, contrast, long labels, zoom and overflow. Exercise drawer → palette, builder/form → confirm, CS editor → confirm, side peek, Escape/scrim cancel, Tab containment, programmatic focus escape, focus restoration, scroll locking, both stacked close orders, navigation/unmount and resize. A banner appearing/remounting while an overlay is open must stay inaccessible until the overlay closes; the top modal must remain usable and final inert/scroll state must be restored.
4. **Record the read-error Retry check.** Initial read error → existing read Retry → recovered data; background refresh error while an editor is dirty, including a newly mounted banner during a modal. Verify read-only requests, no replayed writes and retained draft. This remains unverified in a browser despite the source fix and element-model checks.
5. **Finish baseline/candidate stock and reporting parity evidence.** Disposable Dexie and staging fixtures: shipment builder, list/form/archive/drag/delete, both auto-apply settings and retained-marker sequences; paper re-save/changed mappings; case edited lines/delete; movements/reversal; sales blur/import; shopping-list one Ordered shipment per line. Cancel first (zero writes), then check original payload/order/cardinality, pending/double activation, two sessions, missing/zero/short stock. Compare report values/labels/exports and two-year/three-site request/render behavior. Confirm the five spec defaults, especially “Create draft shipments” versus actual Ordered records.
6. **Dispose explicitly of Task 15's return-restock defect.** Record a separately authorised inventory correction with ledger tests, or CJ-approved documented deferral/operational restriction and amended acceptance scope. Keep the affected restock criterion withheld until that decision. The proposed restriction is not to tick Restock; CJ must own its operational communication. No staff message was sent here, and the historical “0 live returns” observation is not current evidence. This UI approval neither repairs the signs nor approves a claimed “+N restocked” flow.
7. **Complete Task 19 and obtain green PR CI before release.** Attach final SHA/Preview, role/accessibility/read-recovery/parity evidence and a successful normal test/build run. This review satisfies the code-review gate only. Release the redesign separately **only after the bulk release is stable**. If the accepted bulk base changes, compare it again and rerun affected checks. Record the exact known-good **post-bulk, pre-redesign deployment as the rollback target**, preserving bulk/security fixes.
8. **CJ performs release and rollback.** Merge/deploy/tag at a quiet time under `docs/RELEASING.md`; this feature needs **no SQL or integration changes**. Monitor browser/Vercel errors and shop-floor availability for 30 minutes. If needed, use Vercel Instant Rollback to the recorded post-bulk target, then reconcile git on a branch. No database restore, migration reversal or data deletion is part of this rollback. Do not send a digest email as a cosmetic smoke test.

## Coder response

No additional code correction requested by round 3. CJ's release evidence and Task 15 disposition remain outstanding; approval must not be used to tick Task 19 prematurely.

STATUS: COMPLETE
