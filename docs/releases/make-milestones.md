# F11 Automation progress — release and commissioning guide (staging only)

Branch `feature/make-milestones`, stacked on `feature/order-timeline` at
`06bb313`. Nothing here is applied, pushed, deployed or installed into any Make
scenario by the coder. Hosted acceptance is **not** claimed.

## Current commissioning state (2026-11-23, as reported by root)

| Item | State |
|---|---|
| Staging database | Unavailable (disk exhaustion). 0059 and 0060 are **not applied** anywhere. |
| Six AU staging clones (all inactive/gated) | P1 = 8746725, P2 = 8746726, P3 = 8746728, P4 = 8746730 (no reporter; unchanged), P5 = 8746731, P6 = 8746732 |
| Utility scenario | 8746734: separate, off, queue empty; not a milestone reporter. |
| Staging sheets | Four created and verified (both connections). |
| Dropbox staging folders | All nine verified (both connections). |
| Task 3 (clone run) | Not done; synthetic fixture preparation only in progress. |
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

## Request (one per Part; placement rules below are mandatory)

```
POST https://<staging-preview>/api/orders/timeline
Content-Type: application/json
x-inka-make-scope: au-staging
x-inka-make-key: <secret>          (no Authorization header, no Shopify headers)
```

Envelope (schemaVersion 1, ≤ 256 KiB, 1–500 members, explicit-zone ISO time, unknown fields refused):

"Data available after" is the point where the envelope's data exists. It is **not**
where the reporter goes: the reporter must still be placed per "Placement"
below, as a terminal side branch or after every required write and handoff.

| Part (clone) | stage | members | occurrenceId (stable for retries) | Data available after |
|---|---|---|---|---|
| 1 (8746725) | `submitted` | `{memberKey, orderNumber}`: the accepted list (defines batch membership version) | `p1:<batchId>:v<version>` | the batch id and accepted order list are final |
| 2 (8746726) | `files_found` | `{memberKey, shopifyOrderId}`: successful subset with the explicit Part 2 name→id mapping | `p2:<batchId>:v<version>:<executionId>` | the files-found success route, after the mapping is known |
| 3 (8746728) | `planned` | `{memberKey}` planned subset | `p3:<batchId>:v<version>:<executionId>` | planning success |
| 4 (8746730) | — | **unchanged; no report** (its `planned_at` overwrite stays as is) | — | — |
| 5 (8746731) | `images_ready` | `{memberKey}` subset | `p5:<batchId>:v<version>:<executionId>` | images-ready success |
| 6 (8746732) | `packing_slips_ready` | `{memberKey}` subset | `p6:<batchId>:v<version>:<executionId>` | packing-slips success |

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

## Placement and Ignore error handler (in each STAGING clone only)

Why placement matters: when a module's error is handled by **Ignore** (or
**Skip**), Make drops that bundle and does not run the modules after it on
the same route. This applies even when those later modules don't use the
reporter's output (https://help.make.com/skip-error-handler). A reporter
placed on the main chain BEFORE a required write or cross-part handoff could
therefore stop the pipeline when the endpoint fails.

1. Place the reporter in ONE of these two positions only:
   - **Terminal side branch (preferred):** add a Router after the Part's
     success point, keep the existing main route unchanged as its own branch,
     and put the reporter alone at the END of a separate branch, with nothing
     after it.
   - **After everything:** put it on the main route only after ALL of that
     Part's required writes (sheets, data stores, Dropbox, job registry) and
     ALL cross-part handoffs (webhook/scenario calls that start the next
     Part), as the last module of that route.
   - Never place it before a necessary main-chain write or handoff, even if
     nothing uses its output.
2. The reporter is **HTTP → Make a request**, with method POST, the URL and
   headers above, and body type Raw / JSON containing the envelope. Set
   "Evaluate all states as errors" to Yes, so non-2xx goes to the handler,
   and set a timeout of 10 seconds.
3. Right-click that module → **Add error handler** → **Ignore**.
4. Nothing may depend on the reporter's output, and no module may follow it.
5. Check that the router branch order or filters don't make the main route
   wait on, or be filtered by, the reporter branch.
6. Never add these modules to the three live systems.

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
- If a member turns ambiguous or mapping-conflicted AFTER its steps were
  attached, each attached step is withdrawn by an exact retraction (shown in
  the evidence list as withdrawn). The effective timeline is then the same as
  if the conflict had been known first, and the stored history is unchanged.
- An unrouted order may be routed once to the scope's site (root ruling); an
  order already routed elsewhere is never changed.

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
   - the endpoint deliberately unavailable for EACH reporting Part (for
     example a wrong staging URL or key, or ingestion off). An error being
     "ignored" is not enough. Prove downstream processing actually completed:
     - that Part's required staging writes exist;
     - the next Part was triggered and ran to its own success;
     - after Part 6, the batch's staging outputs (sheets, Dropbox folders,
       packing slips) are complete, the same as in a run with the endpoint up.
     The milestone stays missing until the original envelope is replayed.
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
