# Review: Team page redesign — round 1

- Slug: `team-page-redesign` · Branch: `feature/team-page-redesign`
- Reviewed commit: `9f231ab1c6a27c953b61110c4d5c4ff3e2819914`; base `origin/main`: `57b89d2bec371c2aca66c2098fa2e57c7e3d73a7`.
- Reviewer: Codex, planner/reviewer, with CJ's task-specific permission to fix code.
- PR: [yaralabsPH/inkahub-kpi-app#8](https://github.com/yaralabsPH/inkahub-kpi-app/pull/8).
- Verdict: **changes required** — fixes are applied locally, but the normal command checks, updated staging verification, and CJ's removal-security decision below remain outstanding.

## Checked against

- [x] Spec acceptance criteria: no spec exists; used CJ's request and the PR description as the brief. No spec was created.
- [x] Plan tasks: no plan exists; review/fixes only, no unrelated feature work or dependencies.
- [x] AGENTS.md guardrails: repository contract/adapters unchanged; no migrations, SQL, deployment, production access, credentials, commits or other Git state changes. New files live within whitelisted `tests/` and `docs/`. Existing untracked `tests/staging/` was left alone and excluded from local test execution.
- [x] `docs/HARDENING.md`: every item addressed below.
- [x] Roadmap: read in full; this directly requested redesign has no roadmap section. F5 departments and other approved features are not implemented or reinterpreted here.
- [ ] Required checks: app type-check passes; 399 tests and the production build pass via the existing Vite configuration loaded through its API. Normal npm command execution is blocked by this Windows sandbox's config-bundling error; see exact results below. CI for these uncommitted fixes is not available.

Read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/HARDENING.md`, the review template and `docs/RELEASING.md`; inspected the full branch diff and relevant original component, permission, auth and migration code. `gh pr view 8` was attempted but GitHub network access was blocked in the shell. The connected GitHub tool supplied the PR description and matching head/base SHAs instead.

Line references below refer to the **post-fix working tree**, unless explicitly described as original HEAD lines. Findings marked fixed record the original defect and its correction.

## Must-fix

1. **Fixed — incomplete rollback/error handling.** `supabase/functions/_shared/add-member-core.ts:120`, `supabase/functions/add-member/index.ts:78`. A thrown profile/location request skipped cleanup entirely, and the adapter ignored the `{ error }` returned by `deleteUser`. Failed cleanup therefore left a login or partial profile without telling the owner. The core now catches returned and thrown failures, attempts deletion exactly for the newly created login, and distinguishes confirmed deletion from unconfirmed cleanup. The adapter checks the deletion result. Failure logs contain only stage and new user ID. Tests exercise both insert stages, thrown failures, returned Auth deletion errors, duplicates and concurrent duplicate requests.

2. **Fixed — raw upstream errors could violate the no-password/no-detail-disclosure contract.** `supabase/functions/_shared/add-member-core.ts:128` (original HEAD lines 108, 114, 119), `supabase/functions/add-member/index.ts:82`. Auth/PostgREST error messages were interpolated directly into responses. The endpoint now returns controlled recovery messages and never returns or logs an upstream error object/message. Regression fixtures deliberately place a password and internal detail in those errors. Table calls still use the caller's JWT and RLS; token verification now also uses the caller client, leaving service-role usage strictly in Auth create/delete.

3. **Fixed — conditional hook order.** `src/components/TeamMembersCard.tsx:121` (original HEAD lines 145 and 211). The non-owner return preceded `useEffect`, so a mounted role/profile transition could change hook order. A separate owner gate now mounts/unmounts the stateful card, keyed by owner ID. Non-owners do not initialize the team client. This defect was inherited from the previous card but is within the requested review scope.

4. **Open for CJ — removal is not complete access revocation in the checked-in schema.** `src/components/TeamMembersCard.tsx:313`, `supabase/migrations/0001_init.sql:80`, `supabase/migrations/0001_init.sql:96`. The unchanged removal handler deletes only `profiles`, while `user_locations` references `auth.users`, not `profiles`. Consequently the confirmation's promise to delete location grants is unsupported by these migrations. `can_access_location` checks those surviving grants without requiring a profile, so hiding the app through AuthGate does not revoke all direct data access. Active barcodes also remain. This is **inherited**, not introduced by the redesign. Durable revocation and historical barcode handling need an agreed scope/design and potentially an append-only migration; no such change was improvised under this task's hard limits. See Open questions for CJ.

## Should-fix

1. **Fixed — desktop list could overlap the settings panel; small-screen controls could overflow.** `src/components/TeamMembersCard.tsx:602`, `src/components/TeamMembersCard.tsx:913`, `src/components/TeamMembersCard.tsx:1157`. The six-column member list needs about 834 px before the additional 420 px side panel, even though the split starts at `lg`. Contained horizontal scrolling and `min-w-0` now keep it within its column. Mobile name tracks can shrink, long chip labels wrap, the password generator/footer wrap, and nested panel scrolling is limited to desktop. Both existing light and dark variants are retained. This is source-reviewed; rendered viewport checks remain in staging.

2. **Fixed — page toggles contradicted actual permissions.** `src/components/TeamMembersCard.tsx:845`, `src/components/TeamMembersCard.tsx:940`, `src/components/TeamMembersCard.tsx:954`. Dashboard was labelled always available and forcibly added on every edit; Welcome and owner Settings looked editable even though the shared permission function restores them. The UI now follows `effectiveNavAccess`: Welcome is mandatory, non-owner Dashboard is unavailable, owner Settings is mandatory, and owner Dashboard is editable. Clear stores an empty override; Reset stores `null`; Select all excludes Dashboard for non-owners. No database or authorization policy changed. Render tests cover the enforced states.

3. **Fixed — overlapping saves could overwrite page access.** `src/components/TeamMembersCard.tsx:702`, `src/components/TeamMembersCard.tsx:921`, `src/components/TeamMembersCard.tsx:940`, `src/components/TeamMembersCard.tsx:1140`. Opacity alone allowed another toggle to build a whole-array update from stale member data while the first write was pending. Mutating controls and member switching now disable during a save. The add form also disables its fields while submitting and guards repeat submission. This serializes this screen's normal interactions, not edits from independent devices.

4. **Fixed — incomplete accessible names/tab behavior.** `src/components/TeamMembersCard.tsx:565`, `src/components/TeamMembersCard.tsx:778`, `src/components/TeamMembersCard.tsx:874`, `src/components/TeamMembersCard.tsx:1161`. Added names for search, password and role; labelled tablist/panel relationships; one tab stop with ArrowLeft/ArrowRight/Home/End navigation; native disabled semantics and visible focus on chips; and alert/status announcements. Render tests verify semantics and busy-state restrictions. Actual keyboard and screen-reader interaction still needs the staging checks below.

5. **Fixed — password limit counted UTF-16 units rather than bytes.** `supabase/functions/_shared/add-member-core.ts:60`, `src/components/TeamMembersCard.tsx:465`. A 37-character non-ASCII password could exceed the intended 72-byte bcrypt boundary while passing validation. Both boundaries now check UTF-8 byte length; tests cover 72 and 74 bytes and preserve the supplied password unchanged. The name input also reflects the existing server's 80-character maximum.

6. **Fixed — deployment/recovery instructions were missing from the runbook.** `docs/RELEASING.md:31`, `docs/RELEASING.md:116`. Added staging redeployment, production deployment before merge, server-secret/RLS requirements, partial-account recovery, log monitoring and separate Edge Function rollback. The new client now gives an uncertain-outcome recovery message when no function response can be read, rather than implying that blindly retrying is safe.

7. **Fixed — Edge SDK import floated across all v2 releases.** `supabase/functions/add-member/index.ts:12`. Pinned to `2.105.4`, the already installed SDK version used for the local Deno check. No package/dependency was added. The pinned adapter must be retested on staging.

## Nice-to-have

1. `src/components/TeamMembersCard.tsx:152` — team reads retain the previous unpaged-table behavior. The screen reads no event history, but more than the hosted row cap of profiles, grants or active barcodes can truncate it. Plan pagination with stable ordering if the team grows to that size.
2. `supabase/functions/add-member/index.ts:30` — consider an owner-scoped creation throttle if bulk onboarding or abuse becomes a concern. There is no public signup/email-invite path here: only verified owners reach Auth creation, and this function sends no invitations. A distributed limit is a separate design, not an in-memory counter added in this review.

## Behavior preserved and security conclusions

- Name, role, location, page-access, barcode issue/regeneration/print and hourly-rate mutations still use the existing tables and payloads. Self-role changes are disabled and now also guarded in the handler; self-removal remains blocked. Removal and barcode regeneration confirmations remain. No inventory, credit, payroll calculation or history-writing logic changed.
- `src/components/TeamMembersCard.tsx:699` already keys `MemberPanel` by user ID. Switching members remounts the uncontrolled name/rate inputs; the suspected cross-member stale `defaultValue` defect is **not present**. Failed saves can still leave an unsaved draft visible, with an error; reselecting the member reloads its saved value.
- The endpoint verifies the token with Auth, reads the caller's current database role, requires owner, then validates input before creating a login. Missing/invalid tokens, all non-owner roles and missing profiles are covered. It does not authorize from user-editable metadata. Service credentials stay server-side. Normal responses contain only user ID/email or a controlled error; passwords only go to Auth creation.
- `Access-Control-Allow-Origin: *` is acceptable for this bearer-token endpoint: CORS is not the authorization boundary, no credentialed cookie access is enabled, and another origin still needs a valid owner token. OPTIONS performs no writes; other methods return 405. JSON responses are `no-store`. Keep gateway JWT verification enabled as an additional check. This assessment follows the actual header/token model; it is not a claim that wildcard CORS is universally safe. See [Supabase CORS guidance](https://supabase.com/docs/guides/functions/cors) and [function authentication](https://supabase.com/docs/guides/functions/auth).
- Auth/profile/location creation remains a compensating sequence, **not a transaction**. Email uniqueness is the natural duplicate guard. If Auth commits but its response is lost, the core has no ID to delete; if the runtime is terminated or cleanup fails, CJ must reconcile the account. The new messages/runbook make this explicit. No existing account is deleted on a duplicate response. The checked-in Auth foreign keys support cascaded cleanup when deletion succeeds; staging must confirm deployed-schema parity. [Supabase deleteUser](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser) documents the returned error that the original adapter ignored.

## Hardening checklist — every item

### 1. Failure modes

| Item | Assessment |
| --- | --- |
| Down/slow dependencies | Supabase/Auth failures surface as errors; pending controls show saving/adding. Thrown post-login writes now trigger cleanup. Shopify/Dropbox/Slack/Make are not involved. Browser loss/runtime termination remains an uncertain outcome requiring reconciliation. |
| Retry/idempotency | Normalized email is the Auth natural key; grant inserts are deduplicated. Duplicate login returns 409 without deleting/changing it. Lost responses and failed cleanup require checking the existing account before retry. No automatic POST retry added. |
| Two people/devices | Duplicate-email creation is rejected; regression tests model that dependency contract. Same-screen writes are disabled while pending. Existing profile/access edits remain last-write-wins across devices; barcode rotation is separately noted below. |
| Bad input | Server checks email, password length/bytes, trimmed nonempty name up to 80 characters, allowlisted roles, nonempty allowlisted locations; duplicate locations are normalized. Malformed JSON fails validation. Scans/SKUs/orders are n/a for member creation. |
| Visible failure/recovery | Alert messages, no false success after write failure, explicit unconfirmed-cleanup wording and fixed-stage logs. CJ reconciles an uncertain Auth outcome. Reload/reselect after failed existing-member edits. |

### 2. Data correctness

| Item | Assessment |
| --- | --- |
| Attribution | New login ID is used consistently for profile/grants. Existing worker IDs and production events are untouched. Per-user panel key prevents another member's draft appearing after selection. Barcode revocation/history remains an inherited concern below. |
| Shared count rule | n/a: no order/item/set calculations changed. |
| Historical correctness | No production records rewritten. Existing barcode/name snapshot and rate interpretation are preserved, not certified as historically versioned. Rate/barcode limitations are raised for CJ. |
| UTC/site time | Existing barcode/rate timestamps remain ISO UTC. No new display dates, reporting windows or timezone conversion. |
| Manual/inferred distinction | n/a: no measured/inferred metrics added. Rates and page grants remain explicit owner edits. |

### 3. Security

| Item | Assessment |
| --- | --- |
| Authenticate/validate endpoint | Verified JWT plus current owner role before provisioning; input allowlists and bounds. Unit and adapter tests; deployed RLS needs staging confirmation. |
| New tables/RLS | No new tables/policies. Profile/location reads and writes use caller credentials under existing RLS; no service-role table grants added. Existing removal revocation gap is a must-fix decision above. |
| Secrets/logs/messages | No new browser secret. Password never copied to a result/log. No raw upstream error logging. No Make/Slack messages. Function reads only server-injected environment settings. |
| Cost/spam/exposure | Owner-only account creation, no invite email sending. Arbitrary unauthenticated requests cannot provision accounts. No distributed rate limiter; optional follow-up above. Wildcard CORS does not substitute for auth. |

### 4. Release and rollback

| Item | Assessment |
| --- | --- |
| Expand-only/old compatibility | No SQL/schema changes. Old UI remains compatible. |
| Off switch | Administrative feature, not a shop-floor processing dependency. No new feature flag. CJ can disable this function or roll back the frontend; normal production remains independent. |
| Release order | Redeploy changed function/core to staging, run checks, deploy reviewed function to production before merge, then merge after CI/review approval. Separate function rollback and secret requirements are in `docs/RELEASING.md:116`. |
| Per-role staging | Detailed checklist below; prior v2 owner happy-path evidence is acknowledged but does not cover these fixes. |

### 5. Performance

| Item | Assessment |
| --- | --- |
| Months of events | n/a: no events query; caller role lookup uses user ID and team lists retain their old reads. |
| Per-item external APIs | Four parallel table reads; no external call per list item. Add-member has a bounded sequence of Auth/table requests. |
| Two years/three sites | Event age does not affect this page. Grants/barcodes can span sites; existing unpaged row-cap risk and location-specific rate assumptions remain documented. |

### 6. Operations

| Item | Assessment |
| --- | --- |
| Detect failures | UI alerts plus `add-member failed` stage/user-ID logs in Supabase. `rollback` needs prompt operator attention. No automated alert was added or claimed. |
| Manual fallback | Existing staff keep working. CJ can provision/reconcile Auth/profile/grants through the dashboard; the old UI's UID flow is available after frontend rollback. Do not delete established accounts to clear a duplicate error. |
| Maintenance | Monitor failures/partial accounts and test password-policy compatibility, including generated passwords and password recovery. SDK is pinned; future upgrades require revalidation. No new subscriptions, buckets or long-lived tokens introduced. |

### 7. Tests

| Item | Assessment |
| --- | --- |
| Pure logic/edge cases | Core tests cover authorization, validation, duplicates, normalization, rollback, upstream exceptions, non-disclosure and UTF-8 boundaries. Adapter tests execute the handler with mocked clients; no real database calls. Render tests cover permission states, busy controls, self protection and tab relationships. |
| Inventory/credit/money | Inventory and attribution logic unchanged. Existing rate-write math is unchanged; rate input is disabled during pending writes. No claim of live barcode/rate/RLS validation. |

## Staging test plan

CJ/coder executes these after redeploying the **updated** function and shared core to `ybrzhrgfrnvtcwymjdrq`; agents made no staging or production calls in this review.

1. **Owner:** add disposable members for staff, manager, kiosk and cs, and a test owner if appropriate. Check exact role/location grants, normalized email, generated/manual password login, duplicate email, invalid locations and invalid passwords. Verify no password in responses or logs. Test password recovery before relying on the UI's promise that it works.
2. **Manager/staff/kiosk/cs/no-profile/anonymous:** confirm the admin card is hidden and direct add-member requests fail (403 or 401 as appropriate), with no created login/profile/grants. Re-test a stale/demoted owner session against the current database role.
3. **Failures:** using disposable fixtures and a controlled local/staging test double, exercise profile/location rejection, thrown network failures, returned/throwing delete errors and a lost success response. Confirm cleanup or an explicit manual-recovery warning, appropriate logs, and safe same-email retry behavior. Do not deliberately break shared staging policies to inject failures.
4. **Existing members:** rename, change another member's role, toggle locations, change pages, Select all/Clear/Reset, edit/clear hourly rate and issue/print/regenerate a barcode. Cancel both confirm dialogs. Confirm self-role/self-removal protection; switch between two members with different names/rates and verify correct values. Slow a request and verify a second conflicting edit cannot be made while saving.
5. **React/accessibility:** loading/profile/owner/non-owner transitions produce no hook-order error. Tab/Shift+Tab, Space on chips, and ArrowLeft/ArrowRight/Home/End on tabs work; names/states and errors are announced. Verify controls after a failed save.
6. **Layout:** light and dark at 360, 390, 768, 1024, 1280 and 1440 px with the app sidebar, long names, every location and all tabs. No page-wide overflow or list/panel overlap; any wide-list scroll stays inside the list. Check add form, footer and long permission labels; phone layouts should use page scrolling.
7. Run the general smoke checks in `docs/RELEASING.md`. Record normal-command results and green PR CI after the coder commits these files. Complete the removal-security decision before approving the review.

## Open questions for CJ

1. **Release decision required: member removal.** Is the deployed grant FK different from the checked-in schema? Have the coder confirm on staging. If it matches the repository, approve a scoped, rollback-safe revocation design covering location grants, active badges and historical records, or explicitly decide how to gate/defer removal in this release. This review does not silently accept the UI's access-revocation promise or change schema/history semantics.
2. **Inherited barcode/rate behavior for a separate scope:** `src/components/TeamMembersCard.tsx:342` revokes before inserting replacement barcodes; a failed insertion or two concurrent owners can leave no working badge or competing badges. Location changes do not synchronize existing badges. `src/components/TeamMembersCard.tsx:183` picks one rate while `supabase/migrations/0012_production.sql:62` keys rates by `(location,user_id)`, and `src/components/TeamMembersCard.tsx:416` writes the first granted location. Should these be handled in the forthcoming attribution/department work or a separate hardening task? No transactional/barcode/rate redesign was attempted here.
3. **Non-atomic add-member recovery:** the fixes detect ordinary cleanup failure, but runtime termination and an Auth commit with a lost response cannot be made atomic by this handler. Confirm the documented CJ reconciliation procedure is sufficient for owner-only onboarding; durable orchestration would need another design. No production project or secrets were inspected.

## Coder response

CJ authorized the reviewer to apply the fixes in this round. The coder should review the working diff, commit it, run the normal commands outside this restricted config-loader environment, and record CI/staging results. No commit/push/merge/deploy was performed by the reviewer.

## Fixes applied

- Fixed hook ordering by separating the owner gate; retained keyed member panels and added a self-role handler guard.
- Fixed cleanup for returned and thrown failures, checked Auth deletion errors, sanitized API responses, and added fixed-stage logs/recovery guidance.
- Moved token verification to the caller client and pinned the already-used Edge SDK version. **Both `supabase/functions/add-member/index.ts` and `supabase/functions/_shared/add-member-core.ts` changed: staging redeployment is required. No deployment was performed.**
- Fixed UTF-8 password validation and aligned the name input's existing server bound.
- Fixed pending-save controls, permission-chip semantics, accessible names/tabs/alerts and responsive overflow/scrolling.
- Updated `docs/RELEASING.md` with production-before-merge requirements, manual reconciliation and independent function rollback.
- Extended core tests and added handler/render regressions. Ten new core assertions failed against the original code before the fix and passed afterward. Tests use fake identities/clients, not a database.

### Check results

| Check | Result |
| --- | --- |
| `npx.cmd tsc -b` | Passed. `.cmd` is used because PowerShell execution policy blocks the npm/npx `.ps1` wrappers. |
| `npm.cmd run test -- --run` | Attempted for the focused regression file initially; Vite config bundling failed before tests. Full command with `--exclude 'tests/staging/**'` also failed before collection with `Cannot read directory "../..": Access is denied` / cannot resolve local Vite config. Not a test failure, but **not a pass for the requested command**. |
| Vitest API, same compiled Vite config, `envFile: false`, staging excluded | Passed: **399 tests in 5 files**. No staging test files executed. |
| `npm.cmd run build` | Type-check stage passed; Vite config bundling hit the same Windows sandbox restriction. **Not a pass for the requested command.** |
| Vite API production build, same compiled Vite config, `configFile: false`, `envFile: false`, `VITE_BACKEND=dexie` | Passed. Existing warnings: stale Browserslist data, mixed static/dynamic XLSX import, large JS chunk (~1.73 MB). |
| Extra strict TypeScript check of shared core + core tests | Passed. |
| `deno check --node-modules-dir=manual --cached-only --no-config --no-lock supabase/functions/add-member/index.ts` | Passed with installed dependencies. Initial default-cache attempt could not resolve the package through restricted network access; manual node_modules mode avoids that. |
| `git diff --check` | Passed; only Git's LF/CRLF conversion notices. |
| Browser/RLS/staging/production/CI | Not run against any real database. Browser host unavailable; no rendered interaction/viewport validation claimed. Render tests are server-rendered markup tests, not browser tests. Updated staging and normal-command/CI evidence remain required. |

Equivalent API commands used (existing `vite.config.js` is generated by `tsc -b`; no tracked config changes):

```powershell
$env:VITE_BACKEND='dexie'
node --input-type=module -e "import { startVitest } from 'vitest/node'; import { configDefaults } from 'vitest/config'; import config from './vite.config.js'; const ctx = await startVitest('test', [], { run: true, config: false, exclude: [...configDefaults.exclude, 'tests/staging/**'] }, { ...config, envFile: false }); await ctx.close();"
node --input-type=module -e "import { build } from 'vite'; import config from './vite.config.js'; await build({ ...config, configFile: false, envFile: false });"
```

**Final verdict: changes required.** Local fixes and alternate-path checks are complete. Approval awaits CJ's removal-security decision, successful normal command/CI runs and staging verification of the changed function/UI. Production function deployment is CJ's prerequisite before merging, not an action performed in this review.

### Coder follow-up: member removal (Open question 1 / Must-fix 4)

CJ decided: fix removal now. Done without a migration:

- New `remove-member` Edge Function (`supabase/functions/remove-member/index.ts`,
  core in `supabase/functions/_shared/remove-member-core.ts`). Owner-only;
  cannot remove yourself; target must be a UUID.
- Order: ban Auth login -> revoke active `staff_barcodes` -> delete
  `user_locations` -> delete `profiles`. Fails toward less access; each step
  idempotent, so retry is safe. Service role used only for the Auth ban; table
  writes run as the calling owner under existing RLS (verified on staging:
  `user_locations_modify` and `profiles_delete` are `is_owner()`,
  `staff_barcodes_write` is manager+ with location access).
- Auth user is kept, not deleted: staging FKs show `production_events ->
  auth.users ON DELETE RESTRICT` and `staff_barcodes ... ON DELETE CASCADE`,
  so deletion would either fail or erase barcode history.
- Team page "Remove member" now calls the function; confirm text describes
  what actually happens.
- Tests: `tests/api/remove-member.test.ts` (order, auth, self-removal,
  validation, part-way failure messages without detail, idempotent retry).
- Checks (normal commands): `npx tsc -b` pass, `npm run test -- --run`
  409 passed, `npm run build` pass.
- Deployed to staging `ybrzhrgfrnvtcwymjdrq` as `remove-member` v1 (and
  `add-member` v3 with Astra's fixes). Unauthenticated call returns 401.
  Owner end-to-end removal on staging still to be run by CJ.
- Known limit: barcodes at a location the owner has no grant for cannot be
  revoked under RLS. In practice barcodes are issued by an owner for the
  member's locations, so this should not occur; noted in RELEASING.md.

Open questions 2 (barcode/rate redesign) and 3 (non-atomic add recovery) are
unchanged and still need CJ's call.
