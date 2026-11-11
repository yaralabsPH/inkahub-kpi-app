# Releasing safely

Inka Arthouse Hub is live. Staff use it all day for production, stock and
customer service, so a bad release stops real work. This runbook keeps
changes away from production until they are proven, and keeps a fast way back.

## The four environments

| Where | Code | Database | Purpose |
|---|---|---|---|
| Local (`npm run dev`) | your branch | Dexie (browser) or staging Supabase | build and poke at it |
| CI (GitHub Actions) | every PR | none | automatic type-check, tests, build, migration check |
| Preview (Vercel, one per branch) | your branch | **staging** Supabase | real-world test by you (and the client if needed) |
| Production (Vercel, from `main`) | `main` | production Supabase | the live business |

The single most important rule: **preview deployments must never point at
the production database.** Vercel uses separate environment variables for
Preview and Production. Preview gets the staging Supabase project and safe
test values (see "One-time setup").

## Release steps

### 1. Before merging

- [ ] CI is green on the pull request.
- [ ] Reviewer verdict in `docs/reviews/` is "approved".
- [ ] You tested the Vercel preview URL against staging, using the spec's
      acceptance criteria and the smoke test below.
- [ ] If the change has a migration: it was applied to **staging** first and the
      preview worked with it. The migration is backward-compatible (see below).

### 2. Smoke test (staging preview, about 10 minutes)

Run through the flows the business can't live without, even if the feature
didn't touch them:

- [ ] Log in as owner, as staff, as kiosk, as cs. Each sees the right pages.
- [ ] Production: kiosk clock in / clock out, record a production event, verify.
- [ ] Stock: an order deducts inventory exactly once (no double deduction on retry).
- [ ] Shopify order lookup returns an order.
- [ ] Shipments, CS cases and CS returns open and save.
- [ ] Dashboard and Reports load without errors (check the browser console).
- [ ] Plus every acceptance criterion in the feature's spec.

### 3. Deploy to production

1. Note the current production deployment in Vercel (Deployments tab). This is
   your rollback target.
2. If there's a migration: back up production (Supabase dashboard backup or
   `pg_dump`), then apply the migration to production.
3. Merge the pull request into `main`. Vercel deploys production automatically.
4. Tag the release: `git tag v<yyyy.mm.dd> && git push --tags`.
5. Pick a quiet time. Avoid shift starts and the daily digest times in
   `vercel.json`.

### 4. Watch (first 30 minutes)

- Repeat the smoke test on production (read-only checks where possible).
- Watch Vercel function logs for errors in `api/`.
- Be reachable. Tell the client a release went out so problems reach you fast.

## Rolling back

**App code (seconds):** In Vercel → Deployments, open the previous production
deployment and use Instant Rollback (or "Promote to Production"). The old
version is live again immediately, with no rebuild.

Then fix forward in git: revert the merge on a branch
(`git revert -m 1 <merge-sha>`), open a pull request, merge. This keeps `main`
matching what's live, so the next deploy doesn't bring the bug back.

**Database (slow and risky):** Vercel's rollback does not touch Supabase.
That's why migrations must follow the rule below, so rolling back the app
never needs a database rollback. Restoring a backup is a last resort, because
it also throws away real orders and events recorded since the backup.

## The migration rule: expand, then contract

Old code must keep working on the new database. Then an app rollback is
always safe.

- Allowed in one release: add a table, add a nullable column (or one with a
  default), add an index, add a function, add a policy.
- Not allowed in the same release as the code change: drop or rename a column
  or table, add NOT NULL to an existing column, change a column's type, change
  what an existing RPC returns.
- To rename or remove something: release 1 adds the new thing and the code
  uses it; release 2, after release 1 is proven in production, removes the old
  thing.

## One-time setup (CJ)

1. **Staging database.** Create a second Supabase project, "inka-staging".
   Copy production's schema into it (`supabase db dump --schema-only` from
   production, then load into staging). The recovered migrations in this
   repo may not exactly match production (0027 is missing), so the dump is
   the reliable source. Add a few fake products, users for each role and
   orders. Never copy real customer data unless you need it and remove it after.
2. **Vercel environment variables.** In Project → Settings → Environment
   Variables, give the **Preview** environment:
   - `VITE_BACKEND=supabase`, and staging's `VITE_SUPABASE_URL`,
     `VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY`
   - `REPORT_RECIPIENT` = your own email, so test digests never reach the client
   - Shopify and Dropbox: read-only tokens are acceptable for testing order
     lookup and artwork; leave unset if you can't confirm they're read-only.
   Production keeps its current values.
3. **Protect `main` on GitHub.** Settings → Branches → add a rule (or ruleset)
   for `main`: require a pull request before merging, and require the "CI /
   check" status to pass. This makes it impossible to push untested code
   straight to production, including by an AI agent.

## Daily KPI digest endpoint (`/api/reports/daily-digest`)

The digest is sent by three Vercel crons (`vercel.json`: AU 13:55, UK 22:55,
US 04:55 UTC). Every request — scheduled, manual rerun, download or
diagnostic — must carry `Authorization: Bearer <CRON_SECRET>`. A login to the
app, any role, a query-string secret or a cron-looking header does not work.

### Settings (server-only, per Vercel environment)

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Shared secret. Unset/blank = every request gets 401 and **reports stop**. |
| `REPORT_RECIPIENT` | Default email destination (one address). Missing/invalid = email sends fail with 500; downloads and diagnostics still work. |
| `REPORT_RECIPIENT_ALLOWLIST` | Comma-separated addresses a `recipient=` override may use. Empty = no overrides. |
| `RESEND_API_KEY`, `FROM_EMAIL`, Supabase keys | Unchanged. |

Preview gets its **own** test `CRON_SECRET`, staging Supabase, and safe test
inboxes. Never reuse production values in Preview.

### Manual rerun, download and diagnostics

GET only. `npm run dev` does not serve `api/`; use the Preview URL (or
`vercel dev`). Keep the secret in a local environment variable, never in the
URL or in browser code:

```sh
# DIGEST_SECRET holds the value of CRON_SECRET for that environment.
curl -sS -H "Authorization: Bearer $DIGEST_SECRET" "https://<deployment>/api/reports/daily-digest?location=au&date=2026-11-10&dry=1" -o AU.xlsx
```

Query options: `location=au|uk|us`, `date=YYYY-MM-DD`, `dry=1` (download, no
email), `force=1` (send even with no activity), `recipient=<address>`
(must be on the allowlist), `envcheck=1` / `rolecheck=1` (diagnostics).

| Status | Meaning |
|---|---|
| 200 | Sent, downloaded, diagnostic returned, or skipped (no activity) |
| 400 | Bad `recipient` (empty, malformed, list, repeated) or unknown location |
| 401 | Missing/wrong secret, or the server has no `CRON_SECRET` |
| 403 | `recipient` is a valid address that is not on the allowlist |
| 405 | Authenticated, but not GET |
| 500 | Configuration problem (default recipient, allowlist, Supabase, Resend key) or a server error |
| 502 | Resend rejected the email |

A rejected override never falls back to the default address.

### Release prerequisite and rollback warning

- **Set `CRON_SECRET` in Vercel Production BEFORE this code deploys, or the
  daily reports will stop.** Merging deploys, so set it before merging. Also
  set `REPORT_RECIPIENT` explicitly (there is no built-in fallback address)
  and the intended `REPORT_RECIPIENT_ALLOWLIST`.
- **Rollback exposure:** rolling back to a deployment from before
  `digest-auth` makes the endpoint public again (anyone can trigger sends to
  any address and download staff KPI data). Setting `CRON_SECRET` does not
  protect code that never checks it, and pausing the crons does not block
  the URL. Prefer fixing forward; if you must roll back, block external
  access to this endpoint first. Never remove the guard to restore delivery.
- After release, confirm the next real scheduled run for each of AU, UK and
  US in the Vercel function logs and the inbox. A Preview test with a typed
  header does not prove the production scheduler has the right secret.

Full staging checklist: [digest-auth spec, Staging test plan](specs/digest-auth.md#staging-test-plan).
CI also runs `npm run typecheck:digest`, because `npx tsc -b` does not cover `api/`.
