# F10/F11 staging commissioning review — 2026-11-23

Accepted for the isolated synthetic AU staging workflow at `e216051`.
Production deployment, production database and live Make workflows were not
changed. This is not acceptance of real Shopify ingestion or every printing variant.

## Application and database

Root reviewed Claude's eight-file import correction: explicit `.js` specifiers
allow Node ESM to load the server-reachable domain modules without changing
business logic. Root independently ran the new unbundled runtime check, 14/14.
Claude's affected suites passed 76 files/2216 tests, all three type checks and
build. GitHub CI run `45147725051` passed for `e216051`.

The READY Preview is `dpl_2GSPeGRkHtEjKLayUvjgB9Y8q1Q3` at
https://inka-arthouse-ieqqyzvxf-inka-arthouse-s-projects.vercel.app.
It returns actual app JSON for invalid Make credentials and missing sessions;
the first Preview's module-load 500 is resolved. The served browser bundle
contains only the new staging Supabase reference and anon key, no service key.
Production remains `dpl_4r1s2fBXEdhNdUzooNN4BNHaWyZf` with its original aliases.

User explicitly selected **Inka Arthouse 2 (Free)**. Fresh project
`rsfdqkjasiozmbdtgquv` has the reviewed baseline through 0060, all public tables
with RLS, five synthetic role accounts and one test order. Approximately
18.4 MB after acceptance. No Supabase upgrade. F1 processors and capture remain
off; no large historical reporting materialization was repeated.

Final hosted acceptance passed **48/48**: owner/manager/permitted CS read access,
staff/kiosk denial, AU-only membership enforcement, direct table/RPC denial,
configured batch read, six confirmed stages including the seeded ordered fact,
and all five adjacent durations nonnegative. An earlier acceptance attempt had
a network reset; the complete read-only rerun passed. Test sign-out was scoped
to its own session so it no longer invalidates the browser's fixture session.

## Make and replay

One positive P1 request at `2026-11-23T09:50:46.982Z`, fake order `99000001`,
batch `261123-205053-26c318a2e958`. All six isolated Parts executed once and
finished SUCCESS. Each of the five terminal reporters has a matching Make
output containing the receiver's `accepted` result. Deployment-specific share
GET plus Make's shared cookie store worked; no project-wide bypass was created.

| Recorded stage | UTC source time |
|---|---|
| Ordered (explicit synthetic fixture) | 09:20:00.000 |
| Submitted to print | 09:50:54.633 |
| Files found | 09:51:17.293 |
| Planned | 09:51:32.834 |
| Images ready | 09:52:02.107 |
| Packing slips ready | 09:52:58.107 |

Part 6 ended Ready with one requested/included order, no excluded/pending orders
or issues, and the 1,871-byte fixture PDF in `/STAGING-F11-AU`. Artwork and all
write destinations remain synthetic/staging. No printer, Slack, email or live
Shopify action was used. This tests the single-SKU fixture, not all production
variants or actual printing hardware.

All five original retained bodies were replayed once through the real Preview;
all returned `duplicate`. Database evidence stayed at six rows and one resolved
member. The browser displayed the five automation steps, source times and
durations, with later unrecorded stages still missing/unknown. No late/fast labels.

Earlier trial 3 deliberately failed the P2 checkpoint clock: Resume preserved
the downstream handoff, P6 still reached Ready, and P2 emitted neither a false
time nor an envelope. The preceding unavailable-reporter trial also finished
downstream. These prove terminal reporting failures do not block the pipeline.

Claude prepared/reviewed the payloads and applied the positive configurations,
then reached its usage limit before activation. Root continued through the
existing authenticated Make MCP connection using the same reviewed exact-payload
helper. The root runner's first retention read requested an unsupported limit
of 1000; it still completed cleanup, and a read with the supported limit 100
retrieved all 68 staging records. No second business request was sent.

Final state: all six clones inactive, normal timing CLOSED, on-demand,
functionally matching the pinned cleanup payloads, six empty queues. Utility
inactive/empty. All six live AU blueprint hashes match the original snapshots,
and each remains active. No UK/US mutations or production DB access occurred.

## Remaining boundaries

- Verify the precise shared-store order-location field/rule before configuring
  general Shopify routing. No customer/order webhook subscription was added.
- Whole-order shipment/delivery and app framing/dispatch commissioning are not
  proven by this printing fixture; missing events stay unknown.
- Staging Make copies are intentionally off after testing. A future run needs
  current deployment access and deliberate fixture preparation; temporary
  Preview credentials were removed from the restored clone blueprints.
- Fresh staging has a small dataset, not legacy data/grant parity or a published
  production summary. Existing later rollout checks still apply.

Evidence files are in the private local `morning-20261123` operations folder:
`fresh-vercel-runtime-fixed-result.txt`,
`fresh-staging-acceptance-2026-11-23T095704345Z.json`,
`f11-positive-root-run.json`, `f11-positive-final-verification.json`,
`f11-duplicate-replay-261123-205053-26c318a2e958.json`,
`order-timeline-preview.jpg`, and the trial-3 fault record.
Secrets and raw service records are excluded from git.

STATUS: COMPLETE
