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
