# F4 staging preparation — 2026-11-22

CJ explicitly authorized an isolated staging preview, with no changes to the app used by the team.

## Completed

- Reviewed source: `3a47b7de8c11fc837acacebf0985d0f7d3a6cd3c`, branch `feature/box-auto-pick` (station UI plus packaging auto-pick).
- Applied `0047_packaging_auto_pick` only to Supabase `inka-staging`, ref `ybrzhrgfrnvtcwymjdrq`.
- Ran `supabase/staging/box-auto-pick/01-verify.sql` against that staging database. Output: `F4 verify: ALL CHECKS PASSED (rolling back, nothing kept)`. Both kiosk and staff fixtures were available; this staging schema allows negative stock and marks the pick short.
- Verified staging logins and authenticated packaging reads for owner, manager, staff, kiosk and CS.
- Built an export at `C:/Users/cjgom/dev/inkahub-staging-preview-20261122-f4`. Type-check/build passed. Built JavaScript contains the staging project ref and does not contain production ref `lkboboagiikvozvbcpvg`.
- Source tests: 635 passed initially; the only failure asserted the production cron schedule after the export's staging config removed it. Restored the source `vercel.json`, kept the cron-free deployment override in `vercel.staging.json`, and reran all 318 digest tests successfully. App code was not changed.
- Security advisor: packaging RPCs intentionally use SECURITY DEFINER with authentication/role/site checks and authenticated-only grants, covered by the verification script. Other advisory findings concern existing objects and account settings, outside this deployment.

## Deployment status

NOT DEPLOYED. Vercel CLI login had expired. Two fresh device-login attempts were recognized by the signed-in Vercel browser, but the Allow Access button remained disabled, including after reload and direct code entry. CJ was asked to finish the normal login in Chrome.

After authentication:

1. Enumerate Vercel projects. Use/create a dedicated staging project; do not use the existing `inka-arthouse-hub` production project.
2. Deploy the exported reviewed source explicitly to environment `preview`, using `--local-config vercel.staging.json`.
3. Supply only `VITE_BACKEND=supabase`, `VITE_STATION_UI=new`, and the staging URL/public anon key from the local staging env file. Do not upload that env file or other credentials.
4. Leave production email, Shopify, Dropbox, service-role keys, cron jobs and live domains unconfigured. External integrations will be unavailable unless safe staging credentials are separately configured.
5. Verify the deployment is READY, its bundle still references only staging, and staging login/UI works. Record the preview URL here.

No production database, deployment, domain, environment setting or main branch was changed. No feature was merged. No synthetic packaging rules were left activated. Two-session race testing and browser flow testing remain pending; the completed SQL checks use a single session and rollback.
