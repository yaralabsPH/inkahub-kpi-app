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

## Preview deployment attempt (coder, 2026-11-22, later)

CJ superseded the "dedicated staging project" plan above: reuse the existing
project's Preview environment. Status: **NOT DEPLOYED YET.**

Existing project reused: `inka-arthouse-hub` (`prj_1SQWDWZtxggASu59ZO0dkhAXMAzH`),
team `inka-arthouse-s-projects` (`team_AaR7pSY29gVmEZnUfe0ELlQn`). Git is not
connected; previews are manual. Production deployment
`dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf` was not touched; no env var, domain or
project setting was changed.

Proof that Preview builds use staging (checked before any deploy attempt):

- Preview has its own `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `REPORT_RECIPIENT`, separate from Production's. `RESEND_API_KEY`,
  `FROM_EMAIL` and `CRON_SECRET` are Production-only, and Vercel runs crons only
  on Production deployments. Values were not decrypted.
- The existing preview built with those values,
  `inka-arthouse-mt6d5qx3h-inka-arthouse-s-projects.vercel.app`
  (`dpl_7ecNF8vLEAcjpXCXE3NkxxDjdKU4`, station redesign `7b05828`): its JS
  bundle references `ybrzhrgfrnvtcwymjdrq.supabase.co` once and
  `lkboboagiikvozvbcpvg` zero times.

What was tried:

1. Branch push (`f9cb8a2` to `origin/feature/box-auto-pick`): no build, as
   expected with Git disconnected.
2. `create_deployment` from the public GitHub repo at `f9cb8a2` (types
   `github` and `github-limited`): refused five times over about 15 minutes
   with `429 GitHub API rate limit exceeded`.
3. `create_deployment` with SHA1 references for all 124 deploy files (Vercel
   already holds the unchanged ones from the station-redesign deploy): the
   connection dropped twice (ECONNRESET); nothing was created.
4. **Mistake, harmless:** a two-file reference probe created Preview deployment
   `dpl_5A5TpoXUq9UVZwqiMoPV8ehRcKbQ`
   (`inka-arthouse-5box8ojvu-inka-arthouse-s-projects.vercel.app`). It failed
   to build (ERROR), has no alias and serves nothing. Cancel/delete was not
   available to the agent; it can be deleted from the dashboard.

Ready, waiting on one permission: a temporary hook outside tracked source
(`C:/Users/cjgom/dev/f4deploy-tmp/hook.py`) fills the Vercel tool inputs with
the exact bytes of the 28 files changed since `7b05828`, and with the 124-file
manifest, from the clean `f9cb8a2` checkout. It re-checks every SHA1 and size,
only acts for this team and project, and refuses `target`, `gitSource`,
custom environments and redeploys, so the result can only be Preview. Dry run
passed. Placeholders are invalid on their own, so if the hook does not run,
Vercel rejects the call and nothing is deployed. Registering it needs a write
to the git-ignored `.claude/settings.local.json`, which was refused.

Still not verified: the F4 preview itself, its bundle refs, staging login and
the station and Settings flows in a browser, and the two-session race. No box
rules are activated.
