# F11 Automation progress — release and commissioning guide (staging only)

Branch `feature/make-milestones`, stacked on `feature/order-timeline` at
`06bb313`. Nothing here is applied, pushed, deployed or installed into any Make
scenario by the coder. Hosted acceptance is **not** claimed.

## Current commissioning state (2026-11-23, as reported by root)

| Item | State |
|---|---|
| Staging database | Unavailable (disk exhaustion). 0059 and 0060 are **not applied** anywhere. |
| Six AU staging clones | 8746725, 8746726, 8746728, 8746730, 8746731, 8746732. Inactive/gated. Which clone is which Part has not been recorded here, and root maps them. |
| Utility scenario | 8746734 (separate; not a milestone reporter). |
| Staging sheets | Four created. |
| Dropbox staging setup | Pending. |
| Milestone HTTP modules in clones | **Not added.** No integration has run. |
| `MAKE_MILESTONE_SCOPES` | Not set in any environment. |
| Live Make systems (all three) and production | Unchanged and read-only. |
| General shared-store order-location rule (`ORDER_TIMELINE_ROUTING`) | Still unset, pending the user's explanation. |

## What ships

- `supabase/migrations/0060_make_milestones.sql` (additive):
  - Immutable occurrences, Part 1 membership (stable member keys + display
    aliases), each envelope's successful subset, and status.
  - Service-only `ingest_make_milestone` (one transaction per envelope) and
    `read_make_batch`.
  - Resolved members write confirmed `make_*` evidence through F10's
    `ingest_order_timeline`.
- `api/orders/timeline.ts`: still 12 functions. It adds a third, exclusive auth
  path for Make reports, plus `GET ?action=make_batch&site=&batchId=` so
  owners, managers and permitted CS can see unresolved and blocked members.
- Reports order timeline: the five steps (Submitted to print, Files found,
  Planned, Images ready, Packing slips ready) show as recorded or missing,
  with source time, batch and run id. Durations appear only between adjacent
  recorded steps. There is no percent complete, no printed step, and no
  late/fast labels.

## Server configuration

| Name | Value |
|---|---|
| `ORDER_TIMELINE_INGEST` | `on` (shared rollback switch; off/unset = 503 `DISABLED`, nothing written) |
| `MAKE_MILESTONE_SCOPES` | `{"au-staging":{"site":"au","shop":"<synthetic-staging-shop>.myshopify.com","secret":"<random ≥32 chars>"}}` |

- The scope fixes site and shop; the envelope can never name them.
- Use a NEW dedicated random secret, never the cancellation-registry token.
- Store the secret only in Vercel env and the clone's HTTP module header.
- One scope per pipeline.
- Staging uses an explicitly synthetic shop and AU scope only.

## Request (one per Part, after that Part's success route)

```
POST https://<staging-preview>/api/orders/timeline
Content-Type: application/json
x-inka-make-scope: au-staging
x-inka-make-key: <secret>          (no Authorization header, no Shopify headers)
```

Envelope (schemaVersion 1, ≤ 256 KiB, 1–500 members, explicit-zone ISO time, unknown fields refused):

| Part | stage | members | occurrenceId (stable for retries) | Place after |
|---|---|---|---|---|
| 1 | `submitted` | `{memberKey, orderNumber}`: the accepted list (defines batch membership version) | `p1:<batchId>:v<version>` | the batch id and accepted order list are final |
| 2 | `files_found` | `{memberKey, shopifyOrderId}`: successful subset with the explicit Part 2 name→id mapping | `p2:<batchId>:v<version>:<executionId>` | the files-found success route, after the mapping is known |
| 3 | `planned` | `{memberKey}` planned subset | `p3:<batchId>:v<version>:<executionId>` | planning success |
| 4 | — | **unchanged; no report** (its `planned_at` overwrite stays as is) | — | — |
| 5 | `images_ready` | `{memberKey}` subset | `p5:<batchId>:v<version>:<executionId>` | images-ready success |
| 6 | `packing_slips_ready` | `{memberKey}` subset | `p6:<batchId>:v<version>:<executionId>` | packing-slips success |

Redacted examples:

```json
{"schemaVersion":1,"stage":"submitted","occurrenceId":"p1:STG-AU-0001:v1","happenedAt":"2026-11-24T09:00:00+11:00",
 "batchId":"STG-AU-0001","membershipVersion":1,
 "members":[{"memberKey":"STG-90001","orderNumber":"#STG-90001"},{"memberKey":"STG-90002","orderNumber":"#STG-90002"}]}
```
```json
{"schemaVersion":1,"stage":"files_found","occurrenceId":"p2:STG-AU-0001:v1:<executionId>","happenedAt":"2026-11-24T09:12:00+11:00",
 "batchId":"STG-AU-0001","membershipVersion":1,"members":[{"memberKey":"STG-90001","shopifyOrderId":"<synthetic numeric id>"}]}
```
```json
{"schemaVersion":1,"stage":"planned","occurrenceId":"p3:STG-AU-0001:v1:<executionId>","happenedAt":"2026-11-24T09:30:00+11:00",
 "batchId":"STG-AU-0001","membershipVersion":1,"members":[{"memberKey":"STG-90001"}]}
```

Rules:

- `memberKey` is stable across all Parts for the same batch line.
- Later Parts name only members of the same batch/version and report only
  their successful subset. Initial membership is never proof of later
  success.
- A changed Part 1 accepted list for an existing batch is a new
  `membershipVersion` with a new occurrence id. Re-sending a version with
  different members is a conflict.
- `happenedAt` is the actual source time, not the send time.

Responses:

| Status | Meaning |
|---|---|
| 200 `accepted` / `duplicate` | Durably recorded (or already recorded). Includes member counts: attached / pending / blocked / notMember / resolved / unresolved / conflicted. |
| 409 `CONFLICT` | Same occurrence id with different content, or a membership version already defined. Nothing written. |
| 400 | Invalid envelope. |
| 401 | Bad scope or key. |
| 413 | Too large. |
| 503 `DISABLED` / `CONFIG` / `UNAVAILABLE` | Not recorded; retry the **same** envelope later. |

## Exact Ignore error-handler setup (in each STAGING clone only)

1. After the Part's success step, add **HTTP → Make a request**, with method
   POST, the URL and headers above, and body type Raw / JSON containing the
   envelope. Set "Evaluate all states as errors" to Yes, so non-2xx goes to
   the handler, and set a timeout of 10 seconds.
2. Right-click that module → **Add error handler** → **Ignore**.
3. Do not put any module after the reporter on the main route that depends on
   its output. The printing-preparation route must continue whether the
   report succeeds or not.
4. Never add these modules to the three live systems.

## Replay and retention

- A retry or replay must send the **original envelope unchanged** (same
  occurrence id and content). It returns `duplicate` and is harmless; a
  changed body under the same id is a conflict.
- The Ignore handler discards a failed report, so Make keeps no failed
  envelope to replay. A milestone lost that way stays **missing**, never
  inferred. It can only be recovered by explicitly rebuilding the same
  envelope from the clone's own records (batch registry/sheet), using the
  same occurrence id. If those records are gone, the step remains missing.
- Unresolved members (no Part 2 mapping yet) stay durable and pending. They
  attach automatically, in one transaction, when the mapping or membership
  arrives.
- Blocked members never attach: ambiguous mapping, mapping conflict, an order
  already routed to another site, or an alias differing from the recorded
  order. They are visible through `action=make_batch`.

## Staging acceptance (root, after DB recovery and code review; cloned scenarios only)

1. Apply 0059 then 0060 to staging. Rollback-transaction checks: browser
   roles cannot read the tables or execute the RPCs.
2. Set Preview env: `ORDER_TIMELINE_INGEST=on` and an AU synthetic
   `MAKE_MILESTONE_SCOPES`.
3. Using synthetic orders with tiny batches (STG- prefixed ids only), check:
   - the success path through all five reports;
   - a later Part arriving before Part 1/2 (stays pending, then attaches);
   - an identical retry (`duplicate`);
   - an altered retry (409);
   - a wrong key (401);
   - the endpoint deliberately unavailable, where the clone continues via
     Ignore and the step stays missing until the original envelope is
     replayed.
4. Check the Reports order timeline for an AU synthetic order (the five steps,
   batch/run context, adjacent durations) and `make_batch` for unresolved
   members.
5. Confirm the source scenario hashes and config are unchanged and that there
   are no live side effects. Leave the clones manual/disabled.

## Rollback

Unset `ORDER_TIMELINE_INGEST` or remove the scope from `MAKE_MILESTONE_SCOPES`
(reports return 503/401 and nothing is written), and/or disable the clones'
reporter modules. History is retained; printing never depends on this
feature.
