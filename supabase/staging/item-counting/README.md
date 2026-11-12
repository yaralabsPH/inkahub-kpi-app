# item-counting · staging fixtures and measurements

Task 4's staging gate in `docs/plans/item-counting.md`: synthetic AU/UK/US
data, more than 100,000 rows in one authorized read, and measured load times
(one day ≤ 2 s, three months ≤ 10 s).

**Staging only (`ybrzhrgfrnvtcwymjdrq`).** Not migrations. CJ runs them;
agents do not. Every SQL file stops if it finds the production `default`
location, or if it doesn't find the `staging` location and test users.

| Step | File | What it does | Where |
|---|---|---|---|
| 1 | `01-sites.sql` | Adds `au`/`uk`/`us` sites, settings, memberships (owner and kiosk at all three; manager, staff and cs at AU only), worker barcodes and test products | Staging SQL editor |
| 2 | `02-volume.sql` | Adds about 236,000 synthetic production events (two years, three sites; AU Aug–Oct 2026 is busy) plus clock rows. Re-running it adds nothing. | Staging SQL editor |
| 3 | `03-query-evidence.sql` | Lists indexes and table size, and runs `EXPLAIN ANALYZE` on the loader's four query shapes as the owner test user with RLS on. Rolls back. | Staging SQL editor |
| 4 | `tests/staging/measure-item-counting.ts` | Signs in as a test user and times the real loader and counting for one-day and three-month windows at each site. Checks completeness against a server count. | Your terminal |
| — | `99-remove-volume.sql` | Deletes only the synthetic volume rows | Staging SQL editor |

## Step 4 setup

Create `.env.staging.local` in the repo root. Git ignores it.

```
STAGING_SUPABASE_URL=https://ybrzhrgfrnvtcwymjdrq.supabase.co
STAGING_SUPABASE_ANON_KEY=<staging anon / publishable key>
STAGING_EMAIL=owner@inka-staging.test
STAGING_PASSWORD=<that test user's password>
```

Then run:

```
npx vite-node tests/staging/measure-item-counting.ts
```

The script refuses any URL other than the staging project. It never prints
credentials and writes nothing.

Run it as `owner@inka-staging.test` for site-wide reads. Then run it as
`manager@inka-staging.test`: the manager's UK and US results should show
`limited` visibility with zero rows, not an error. Optionally run it as
`staff@inka-staging.test` for self-scope.

Paste the outputs from steps 1–4 back to the coder. They go in the plan's
Implementation log. A case that fails or exceeds its target is recorded as an
Open question. Nothing is truncated or exempted to make it pass.
