# Spec: Authenticate daily KPI digest requests

- Slug: `digest-auth`
- Status: approved by CJ
- Author: planner (GPT-6 Astra)

## Problem

`api/reports/daily-digest.ts` does not authenticate callers. Anyone who knows the URL can trigger a report email, set `recipient=` to an arbitrary address, download staff-level KPI data with `dry=1`, or access `envcheck`/`rolecheck` diagnostics. The handler can read through the Supabase service-role credential. This exposes business and staff information and permits unauthorized email sending.

The endpoint currently serves three Vercel cron jobs (AU, UK and US); no frontend caller was found. See [ARCHITECTURE.md](../ARCHITECTURE.md), sections 7–8. This is a small endpoint security change; report calculations and schedules stay unchanged.

## Goals

- Require `Authorization: Bearer <CRON_SECRET>` for every digest operation, including scheduled execution, manual reruns, downloads and diagnostics.
- Return 401 for every request without the correct secret, including when the server secret is not configured. Reject before any database access, external request, report generation or diagnostic output.
- Let CJ rerun reports with the same server secret used by Vercel cron.
- Keep `REPORT_RECIPIENT` as the default destination. Permit explicit recipient overrides only with the correct secret and an exact address match in a server-configured allowlist.
- Preserve all three scheduled reports and document the configuration prerequisite that prevents a deployment from stopping them.

## Non-goals

- App-login authorization for owners, managers, staff, kiosk or CS; a Supabase session or role alone grants no digest access.
- A new UI, manual-run button, per-user credentials, per-location secrets, audit table, rate limiter or delivery deduplication system.
- Changes to KPI calculations, timezones, row pagination, report formatting, zero-activity suppression or cron schedules.
- Security changes to other endpoints, including `shopify/whoami`, or to database functions and RLS.
- Removing or redesigning the existing diagnostic payloads beyond protecting access and ensuring the new secret is never exposed.

## User stories / flows

- As the business owner, I want AU, UK and US daily reports to continue reaching the configured destination without exposing the report endpoint publicly.
- As CJ, I want to rerun a report for a location/date using the secret in an HTTP header, optionally using an allowlisted override, so I can troubleshoot or recover a missed send.
- As CJ, I want authenticated `dry=1`, `envcheck=1` and `rolecheck=1` calls to remain available without making those operations public.
- As a caller without the secret, I receive the same generic 401 response regardless of app login, role, query parameters or claimed cron identity.

### Chosen approach

CJ selected a shared server secret using Vercel's `CRON_SECRET`. Vercel sends the bearer header for scheduled requests; CJ supplies it manually for reruns. This uses the current endpoint and avoids introducing a second identity system for a route with no frontend caller. Alternatives discussed were cron plus signed-in owners, or cron plus owners/managers with location checks; neither is part of this feature. [Vercel documents the bearer-header mechanism and fail-closed check](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs#securing-cron-jobs).

Request flow: authenticate first → require GET → validate any recipient override → execute the existing selected operation. Authentication applies before parameter validation, so an unauthorized call cannot use a different error path to reach diagnostics or report work. Secret possession grants access to the existing supported locations; there is no additional app-role or location-membership check.

### Configuration and recipient rules

The following details are planner defaults for this draft, implementing CJ's selected policy:

| Setting / input | Required behavior |
| --- | --- |
| `CRON_SECRET` | Server-only, nonempty secret. An absent, empty or whitespace-only value disables all access with 401. Compare the supplied bearer credential exactly; do not trim or otherwise normalize the secret. |
| `REPORT_RECIPIENT` | Default destination when `recipient` is absent. It is trusted server configuration and need not also appear in the override allowlist. For an email operation, missing/blank/invalid configuration returns a generic 500 without sending; remove the hardcoded fallback address. Downloads and diagnostics do not require an email destination. |
| `REPORT_RECIPIENT_ALLOWLIST` | New server-only env var: comma-separated individual email addresses. Trim surrounding whitespace, ignore blank entries, and compare full addresses case-insensitively. No domain rules, wildcards, suffix matching or display-name forms. An absent/empty list permits no overrides. Malformed nonblank entries fail closed for overrides with a generic configuration error; they do not prevent default-recipient sends. |
| `recipient` | Optional single email address. Trim and compare case-insensitively; send the normalized matching address. Reject empty, malformed, multi-address or repeated/array values with 400. A well-formed address not in the allowlist receives 403. Never silently fall back to the default after a rejected override. Explicitly supplying the default address still counts as an override and requires allowlist membership. |

If `recipient` is supplied alongside `dry`, diagnostics or a no-activity request, validate it before executing that operation as well. A missing override allowlist must not interrupt ordinary scheduled reports. Neither new env var uses a `VITE_` prefix. The secret is never accepted through the URL, cookies, request body or cron-identifying headers.

## Acceptance criteria

- [ ] A nonempty configured secret and a single `Authorization: Bearer <CRON_SECRET>` header are required. The comparison does not accept token prefixes, suffixes, multiple credentials or malformed/array header values. HTTP header-name casing follows normal HTTP behavior.
- [ ] Missing/wrong/malformed credentials and an unset/empty/whitespace-only server secret all return 401 with a generic response, without revealing expected credentials or configuration. `Bearer undefined` and `Bearer ` never authenticate an unconfigured server.
- [ ] A query-string secret, a spoofed cron header/user agent, a browser session, or a valid Supabase token for any app role cannot substitute for the secret. Authentication happens before method or query validation.
- [ ] Rejected authentication causes zero Supabase client/database work, zero outbound network calls, zero XLSX generation and zero email sends, including with `rolecheck`, `envcheck`, `dry`, `force`, `recipient` or combinations of them.
- [ ] Authorized GET requests retain existing valid `location`, `date`, `force` and no-activity behavior. Other methods receive 405 with `Allow: GET` and perform no report or external work. Unauthorized requests using those methods still receive 401.
- [ ] Authorized `dry=1` returns the existing XLSX download and never sends email. Authorized diagnostics retain their existing purpose. Every diagnostic branch is behind the same guard.
- [ ] Default email sends use `REPORT_RECIPIENT`, without requiring allowlist membership or falling back to a hardcoded address. Missing/invalid default configuration prevents an email send with a generic 500; diagnostic and download paths still work.
- [ ] Authorized overrides follow the configuration table above: allowed address succeeds; disallowed address returns 403; malformed/repeated/multi-address input returns 400; invalid allowlist configuration returns a generic 500 for override requests. All rejection paths run before report/database/network work and send no email.
- [ ] Responses use `Cache-Control: no-store`, including successful reports/downloads/diagnostics and rejected requests. Errors do not disclose the allowlist or submitted/expected secret. New logs and diagnostic fields do not contain the authorization header or any part of `CRON_SECRET`.
- [ ] `vercel.json` retains the existing AU, UK and US paths/schedules, without placing a secret in a URL or tracked file.
- [ ] Automated handler tests cover successful scheduled-style and manual requests, unauthorized combinations, missing configuration, role tokens, method handling, recipient normalization/rejection, downloads and diagnostics. External dependencies are mocked; tests explicitly assert that rejected calls do not reach them. Tests must exercise the handler, not only a standalone comparison helper.
- [ ] Type-check, tests and build pass. The plan explicitly accounts for `api/` being outside the current `tsc -b` coverage and provides appropriate checking for changed server code.
- [ ] The implementation plan's **Release and rollback** section carries the Production `CRON_SECRET` prerequisite and the rollback exposure warning below. CJ verifies the deployed cron path for all three locations after release.

## Data and backend impact

- Tables / migrations needed: none. No data writes or migration application are introduced.
- Repository interface changes (both Dexie and Supabase): none. This route queries Supabase directly; local Dexie workflows are unaffected.
- `api/` endpoints touched: `/api/reports/daily-digest`, implemented by `api/reports/daily-digest.ts`, plus focused server-side tests/helper code as determined by the plan. No other endpoint is in scope.
- RLS / role access: no RLS or role changes. Existing backend credentials remain server-side. Possession of the cron secret, not an app role, authorizes this endpoint.
- Configuration: add `CRON_SECRET` and `REPORT_RECIPIENT_ALLOWLIST` in Vercel environments; retain `REPORT_RECIPIENT` and the existing database/email variables. Document names and safe placeholders only. No dependency addition is expected.

## Staging test plan

1. Configure the Vercel Preview deployment with staging Supabase only, a distinct test `CRON_SECRET`, `REPORT_RECIPIENT` pointing to CJ's test inbox, and an allowlist containing a second safe test address. Confirm the new deployment has those values. Never use production keys, data or recipients for these checks. These are future CJ validation steps, not permission for the planner to send messages now.
2. Invoke the preview endpoint without credentials, with an incorrect secret, with a query-string secret, and with a spoofed cron header. Repeat for normal sends, `force=1`, `dry=1`, `envcheck=1`, `rolecheck=1` and `recipient=`. Expect 401 with no report or configuration data. Verify no email delivery; use the automated dependency spies to prove zero external work.
3. Repeat using valid app tokens for owner, manager, staff, kiosk and CS without the cron secret. Each receives 401. Check that logging in through the browser does not make a direct endpoint URL work.
4. With the correct test header, request AU, UK and US using seeded activity dates. Confirm `dry=1` returns each XLSX without email. Trigger a controlled default send and an allowlisted override send to the safe test inboxes; compare report content to the pre-change behavior. Verify zero-activity suppression and `force=1` still behave as before.
5. Test a disallowed override (403), empty/malformed/repeated/multiple addresses (400), and surrounding whitespace/case variations of an allowed address (accepted). Test combinations with diagnostics and `dry`; rejected overrides must never silently send to the default.
6. In a disposable preview configuration, unset/empty the allowlist: default sending remains available; overrides return 403. Test a malformed nonblank allowlist entry: overrides fail with the specified generic configuration error. Restore the valid configuration afterward.
7. With the correct header, run both diagnostics and verify they expose no new secret/header data. Check `Cache-Control: no-store` on JSON and XLSX responses. Test non-GET with and without the secret for 405 and 401 respectively.
8. In a disposable preview configuration, remove/blank `CRON_SECRET` and redeploy: every variant returns 401, even with the previous token or literal `Bearer undefined`. Restore it and verify access resumes. Separately remove `REPORT_RECIPIENT`: default email attempts fail without sending, while authenticated downloads/diagnostics still work.
9. Preview HTTP tests simulate the cron header; they do not prove the production scheduler has the right secret. After release, CJ checks scheduled delivery/function outcomes for all three production locations as described below.
10. Run the complete [RELEASING.md smoke test](../RELEASING.md#2-smoke-test-staging-preview-about-10-minutes). Most at risk is scheduled report delivery/configuration; Dashboard/Reports and owner/staff/kiosk/CS login remain useful regression checks. Production clock events, inventory, Shopify lookup, shipments, cases and returns must still pass the release checklist.

## Risks and open questions

- **Required plan release note, selected by CJ:** `CRON_SECRET` must be set in Vercel **Production BEFORE this deploys**, or the daily reports will stop. The implementation plan must repeat this in **Release and rollback**. CJ must ensure the deployed function and scheduled requests use the same value, configure `REPORT_RECIPIENT` and the intended override allowlist, and retain safe, separate Preview settings. Choose a strong random header-safe secret and never put it in a URL, browser bundle, committed file or chat.
- **Release verification:** keep current cron schedules, avoid release near their run times, record the prior deployment, and confirm authorization and subsequent scheduled outcomes for AU/UK/US. Test with the correct secret in Preview first; CJ owns production configuration, deployment and delivery checks. Vercel's official [cron management documentation](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs) is the reference for scheduler, environment and rollback behavior.
- **Rollback:** no database rollback is needed. Restoring the current pre-fix deployment also restores the unauthenticated endpoint and arbitrary recipient override. Setting `CRON_SECRET` alone does not protect code that never checks it, and disabling the schedule alone does not block public endpoint access. The plan must state this explicitly: prefer a fix forward that retains authentication, or have CJ block external access to this endpoint before restoring vulnerable code. A rollback to an already protected deployment must reverify its credential/configuration compatibility. Do not remove the guard or add a public bypass to recover delivery.
- **Shared credential:** anyone who obtains the secret can access all supported locations, downloads and diagnostics and can trigger repeated sends to configured destinations. The allowlist limits overrides; it does not prevent replay. Credential rotation and distribution remain CJ's responsibility; per-user authorization and delivery deduplication are outside this feature.
- **Existing diagnostic content:** diagnostics still contain sensitive operational information once authenticated. Keep the secret with trusted operators. Payload redesign and other endpoint vulnerabilities remain separate work.
- **Planner defaults to review:** `REPORT_RECIPIENT_ALLOWLIST` naming/format, exact case-insensitive single-address matching, reject rather than ignore invalid overrides, fail closed without a configured default for email, GET-only behavior, and no-store responses. These are concrete draft decisions, not additional decisions attributed to CJ.
- No blocking product questions remain. The spec stays **draft** until CJ approves the written document; implementation and the plan are separate steps.
