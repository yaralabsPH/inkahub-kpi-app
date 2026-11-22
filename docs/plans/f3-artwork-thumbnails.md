# Plan: Artwork thumbnails on order items

- Slug: `f3-artwork-thumbnails` · Spec: `docs/specs/f3-artwork-thumbnails.md`
- Branch: `feature/f3-artwork-thumbnails`
- Status: draft — pending CJ approval of the spec and this plan
- Author: planner · Date: 2026-11-22

## Approach

Build one durable thumbnail pipeline around the existing `artwork_images` cache, with additive state, source-index, queue and integration tables. Share `artworkCodeFromSku` and `dropboxFilenamesForSku` from `src/lib/domain/skuRouting.ts`; put new canonical identity, exact alias matching, ordered manifests, revision digests, image policy and job/retry rules in `src/lib/domain/`. Server adapters perform provider calls, transactional persistence and bounded Sharp conversion. The browser batches requests at the order-view boundary and renders from shared status; rows never fetch originals or call providers.

The proposed converter is Sharp in a bounded Vercel Node worker. Tasks 1–3 establish API type-checking, build the bounded converter and prove it on a staging Preview **before Tasks 4–22**. Local Part 6 performance is not feasibility evidence for Vercel. A failed or unmeasured gate stops dependent work and returns a dedicated automated-converter proposal to CJ. Nothing in this draft authorises starting implementation before CJ reviews the spec and plan together.

Recommended defaults are a complete ordered set composite, a private final bucket, optional verified Part 6 launch seeds, and immediate dispatch backed by a one-minute recovery tick. The Open questions section maps each unapproved choice to affected tasks. Permanent object paths and revision identity are separate from expiring signed URLs. Replacement invalidates visible readiness immediately when the new desired generation becomes known; a fenced publication transaction is the only way to make a revision ready.

`Repository.ts`, `DexieRepo.ts` and `SupabaseRepo.ts` remain unchanged: artwork and production already use direct authenticated APIs outside that interface. Dexie gets labelled local placeholders and exits before accessing auth, Supabase or the network. There is no unsupported local queue or parallel repository contract. Integrate both F2's `OrderLineDisplay` and the station redesign's `src/components/production/station/StationOrderScreen.tsx`; do not fork or recreate the latter before its branch is integrated.

### Global constraints and task conventions

- Follow `AGENTS.md`, `docs/HARDENING.md` and `docs/RELEASING.md`. Only CJ merges, deploys or applies SQL, including staging SQL and Preview deployment. One writer at a time. The coder implements on the feature branch only after approval and records unexpected design changes under Open questions.
- Each numbered task is one commit, `task N: <summary>`, including its checkbox and one Implementation log line. Tests for new behavior are written and observed failing before implementation, then run green. Run focused tests, `npx tsc -b`, `npm run test -- --run` and, once added, `npm run typecheck:artwork` for each task; run `npm run build` at the converter gate and on the final combined candidate. On Windows use the equivalent `npm.cmd`/`npx.cmd` commands. Do not claim staged checks or CI passed until their actual results exist.
- Proposed migrations are 0047–0050 below, all new files. Re-check current `main`, `feature/item-counting` and the combined release manifest before creating them and again before merge. This checkout ends at 0033; the inspected local item-counting ref occupies 0034–0046. If another branch takes a number, allocate the next unused numbers ≥0047 for these **unapplied F3 files**, update references and repeat staging validation. Never renumber/edit an already-applied migration or fill missing 0027. If F3 was already applied in staging, CJ reconciles its migration history explicitly; do not silently rename it.
- Existing columns/types/RPC signatures and legacy aliases remain intact. `dropbox_path` stays NOT NULL. No canonical `artwork_images` row until a real verified source path exists. Unresolved work belongs in the new state tables.
- All provider credentials and privileged clients stay under `api/` using `process.env`; domain modules have no I/O or environment access. Frontend imports never reach Sharp, server adapters or secrets. Use relative server-compatible imports for shared domain modules, not an unconfigured Vite alias in Vercel.
- Preview/test Supabase is `ybrzhrgfrnvtcwymjdrq`; production `lkboboagiikvozvbcpvg` is forbidden for development/tests. Assert the project and worker origin before running fixtures. Use synthetic orders/products and isolated provider accounts/folders. No customer bodies, tokens, signed URLs or original images in git/logs.
- No changes to Make Part 6, `/Packing Slip Previews/`, its index, packing slips, original artwork, inventory, credit, item counting or historical production facts. All reference access is read-only.
- New dependencies: **`sharp`** for real decoding, EXIF/colour normalization, resizing, validation and composition (Task 2); **`@vercel/functions`** for supported `waitUntil` dispatch lifetime after durable acceptance (Task 12). Pin compatible versions and lockfile. Existing Node crypto/streams/child-process, TypeScript, Zod, Supabase client, React, TanStack Query and Vitest cover the rest. No Dropbox/Shopify SDK, queue package, hash package or new test framework is planned. Any further dependency needs a reason and a plan amendment first.

### Review focus

- Source changes during a long scan/download must not resurrect older art or publish partial sets: Tasks 10–12, 22.
- A crash after upload or expired lease must consume the right failure budget and preserve newer status: Tasks 5, 7, 12, 22.
- Legacy definer RPCs and permissive Storage policies must not bypass protected publication: Tasks 6–9, 22.
- Shared kiosk accounts, auth changes and expired URLs must recover without a request storm or cross-session private cache: Tasks 15, 19, 22.
- The largest supported formats and sets must fit real Preview resources and the 120-second delivery target: Tasks 2–3, 12, 22.

## Tasks

### [ ] Task 1: Add the dedicated F3 API type-check gate

- Files: new `tsconfig.artwork-api.json`; modify `.gitignore`, `package.json`, `.github/workflows/ci.yml`; API tests under `tests/api/artwork/` as they arrive.
- Do:
  1. Add `typecheck:artwork` running `tsc --project tsconfig.artwork-api.json --noEmit`, with strict Node-compatible checking. Include `api/artwork/**/*.ts`, `api/_lib/artwork/**/*`, the new `api/dropbox/artwork-webhook.ts`, `api/shopify/artwork-webhook.ts`, modified install-start and legacy artwork route, `tests/api/artwork/**/*`, and their imported domain modules. Enable `allowJs`/`checkJs` for the converter child `.mjs`; do not hide it behind unchecked declarations. Include the existing routes initially so the command checks real files before new ones exist.
  2. Whitelist the new root config in `.gitignore`. Add the command to CI beside the existing digest type-check; retain digest checks and append-only migration enforcement. Keep the Vite project scoped to `src`.
  3. Demonstrate a temporary deliberate type error in an included API fixture fails this command, then remove it. Ensure Vitest discovers the F3 API tests in the existing test run; no live services in CI.
- Done when: the command checks the intended server graph and passes, its negative check fails as expected, and existing type-check/tests remain green. No dependencies are required by this task.

### [ ] Task 2: Implement the bounded converter and local resource tests

- Files: new `src/lib/domain/artworkImagePolicy.ts`, `src/lib/domain/__tests__/artworkImagePolicy.test.ts`, `api/_lib/artwork/converter.ts`, `api/_lib/artwork/converter-child.mjs`, `api/_lib/artwork/contentHash.ts`, `tests/api/artwork/converter.test.ts`, `tests/artwork/fixtures/README.md`; modify `package.json`, `package-lock.json`.
- Interfaces: pure `validateArtworkImage(metadata): ImagePolicyResult` and `setCellLayout(count): Cell[]`; server `convertComponent(inputPath, limits): Promise<ReducedImage>` and `composeSet(orderedComponents): Promise<ReducedImage>`. `ReducedImage` includes JPEG bytes, dimensions, byte count and output SHA-256. Use the same policy for seeds and generated output.
- Do:
  1. Test supported JPEG/PNG/WebP/single-page TIFF and extensionless decoded content. Accept at most 150,000,000 source bytes and 300,000,000 pixels; reject animation, multipage, invalid dimensions, unsupported format and corrupt input. Inspect channels/bit depth and test difficult high-bit-depth cases. Never use unlimited metadata decoding or the reference's 500 MP JPEG exception.
  2. Pin `sharp`. Run conversion in a killable child with native concurrency one and disabled/tightly capped cache. Enforce 45 seconds per conversion, 90 seconds per invocation, a 30-second download deadline and <200 MB scratch per active original. Kill and reap a timed-out child; cleanup in `finally`. Streaming byte/hash enforcement must survive misleading content-length, interrupted streams and cancellation without buffering the whole original.
  3. Implement Dropbox content hash using SHA-256 of concatenated 4 MiB block hashes; test empty, exact-block and multi-block boundaries. Keep this streaming I/O adapter server-side; manifest digest rules are Task 4.
  4. Apply EXIF rotation, sRGB, white flattening, `fit:inside`, no enlargement, maximum 400 × 400 and 75,000 bytes, quality 78 → 65 → 50 then fail. Compose only reduced components in equal cells, row-major, no cropping, maximum 400 × 400. Bound component count to supported parser outputs; reject zero/invalid sets without changing SKU routing. Include six- and nine-component test composites.
  5. Use small committed synthetic fixtures; document generation/download of large isolated test fixtures without committing originals. Test child timeout, scratch cleanup, JPEG size failure and invalid existing-output checksum. Do not add the optional Dropbox thumbnail fast path in this release: originals plus verified seeds are sufficient if the gate passes.
- Done when: focused native tests and API type-check pass, child termination is observed, output geometry/bytes are decoded and checked, and renderer behavior matches the spec. Local performance is recorded but does **not** pass Task 3.

### [ ] Task 3: Pass the staging Preview converter feasibility gate — STOP if it fails

- Files: new temporary `api/artwork/benchmark.ts`, `tests/artwork/preview-benchmark.mjs`, `tests/api/artwork/benchmark.test.ts`; modify `vercel.json`, this plan's Implementation log and Open questions.
- Do:
  1. Build a staging-only benchmark endpoint that rejects production, requires `ARTWORK_WORKER_SECRET`, allows only fixed isolated fixture IDs and accepts no arbitrary URL/path. Keep originals out of HTTP request bodies; fetch only allowlisted test Dropbox sources to bounded disk. Include the child/native binaries in the deployed bundle and configure a 120-second function duration. CJ confirms an actual 4 GB allocation and the project's Fluid/runtime behavior; configuration text alone is not proof.
  2. CJ deploys this test build to Preview with staging-only credentials. Record deployment ID, Node ABI, Sharp/libvips versions, bundle size/native resolution, configured memory/duration, parent-plus-child peak RSS, peak scratch, download/convert/upload durations and cold/warm timings.
  3. Benchmark the largest permitted JPEG, PNG, single-page TIFF, extensionless and high-bit-depth fixtures; include high-entropy/incompressible and corrupt inputs, just-over-limit rejection, EXIF/transparency, six-piece and larger supported sets. Prove combined RSS <3 GB, scratch <200 MB, no platform termination, functioning subprocess kill, and valid output. Simulate distinct invocations for reduced components, temporary-disk loss, upload and a five-second client observation interval. Measure the complete source-available → output-observed route within 120 seconds under normal service; this early harness does not substitute for the real queue/trigger/browser timing in Task 22.
  4. Record every fixture/result and headroom in the log. Leave the gate unchecked if CJ has not deployed/measured it. **Stop before Task 4 if any required case fails or cannot be measured.** Record a dedicated bounded automated conversion service proposal, costs and changed tasks for CJ; do not reduce accepted formats/limits, use product photos or introduce manual ongoing generation.
- Done when: CJ's actual Preview evidence satisfies every gate, the plan records a pass and the build passes. This is a feasibility decision, not production deployment or final acceptance. Remove the benchmark endpoint before final release in Task 22.

### [ ] Task 4: Define canonical artwork identities, aliases and revision digests

- Files: new `src/lib/domain/artworkIdentity.ts`, `artworkManifest.ts`, `artworkAliases.ts` and corresponding `src/lib/domain/__tests__/artwork*.test.ts`; consume unchanged `skuRouting.ts`.
- Interfaces: `describeArtwork(sku): ArtworkDescriptor` discriminates artwork / non-artwork / unknown; artwork includes canonical code and ordered expected components. `resolveManifest(descriptor, currentFiles, approvedAliases): ManifestResolution` returns complete / missing / ambiguous. `manifestPayload(manifest, rendererVersion): string` and `revisionDigest(manifest, rendererVersion, sha256): string` use an injected synchronous SHA-256 function over specified UTF-8 bytes; no Node import in client-shared domain logic.
- Do:
  1. Derive keys/count/order from existing helpers, including `KAN0566`, `S3WIL0049`, free print `ESP`; quantity/frame/size never enters the key. Recognise gift/frame/accessory separately from blank/malformed/legacy-unknown. Reject zero-component sets within F3 without changing `parseSku`/KPI behavior.
  2. Represent each source with ordinal, exact file ID, normalised path, original name, rev, content hash, size, deletion flag and observation epoch. Require every ordinal 01…N once. Explicitly test S2/S3/GW and higher supported set counts.
  3. Enumerate exact candidate grammar for supported extensions/extensionless, `_FIXED`, repeated extensions and verified separators; approved semantic aliases are explicit data with provenance. Candidate grammar does not resolve two distinct live contents. No substring/fuzzy matching or fallback to any search result. Same-hash duplicates require a deterministic recorded authoritative path; different artwork for one canonical key is a conflict. AUXIMH/AUXMFL must not become a free-print alias. Leave unverified legacy aliases disabled until audited.
  4. Serialize a versioned ordered array of `(ordinal,file_id,rev,content_hash)` plus renderer version, with fixed encoding and field order, before SHA-256. Test stable digest despite input arrival order; changes to any component, rev or renderer change it. Hash/rev strings are identities, never sortable freshness clocks. Test hand-derived golden digest with Node crypto injected only by tests/server.
- Done when: table-driven tests pin normal/near-miss aliases, all non-artwork cases, duplicate/missing/conflicting components and component-02-only replacement; existing routing/count tests remain unchanged and pass.

### [ ] Task 5: Define pure job transitions, retries and scheduling rules

- Files: new `src/lib/domain/artworkJobs.ts`, `artworkBudgets.ts`, corresponding domain tests.
- Interfaces: `transitionArtworkJob(state, event, now): TransitionResult`, `retryAt(failedExecutions, now, jitter, retryAfter): number`, `canPublish(job, desired, lease, controls, now): boolean`; time and jitter are explicit inputs. Export state/budget types for API and SQL-conformance fixtures.
- Do:
  1. Implement `queued`, `waiting_source`, `running`, `retry_wait`, `succeeded`, `failed`, `superseded`. Six failed executions maximum per revision/resolution generation; delays 30s, 2m, 10m, 1h, 6h with bounded jitter, honour longer Retry-After/shared cooldown. Validation/ambiguity/unsupported content can fail immediately; missing source consumes bounded failed resolutions, then becomes visibly failed.
  2. Separate claims from failures: N successful component steps + composition + publication; cap resolved claims at N+8 including failures. Successful checkpoint continuation is not a failed execution. Expired/uncheckpointed claims charge one failure exactly once. No image lease/attempt during intentional pre-execution cooldown.
  3. New verified source evidence creates a new monotonic generation; ordinary render/reconcile never resets terminal failure. Audited retry resets selected failed work idempotently. Pause retains progress without failure; expiry/fencing/generation mismatches forbid state or pointer changes.
  4. Define fair priority: interactive/replacement first, reserve one of every ten eligible dispatch slots for waiting backfill, subject to the same quotas. One global large conversion, at most two small/composition tasks; one original or ten small components per invocation. Shared rate/daily budgets use UTC windows, with routine 10 GB/1,000 conversions and separate launch allowance 50 GB/5,000 conversions per day.
- Done when: deterministic tests cover each transition, six-failure exhaustion, double expiry, stale fail/success, N+8 bound, Retry-After, source-arrival recovery, pause and backfill non-starvation. SQL in Task 7 must match these fixtures rather than invent another retry policy.

### [ ] Task 6: Add the expand-only schema with explicit access restrictions

- Files: new `supabase/migrations/0047_artwork_thumbnail_state.sql`, `tests/artwork/schema-contract.sql`.
- Do:
  1. Re-check reserved numbers. Add nullable `storage_path`, `thumbnail_revision`, `thumbnail_generated_at` to `artwork_images`. Preserve all old columns, keys and RPC signatures.
  2. Add `artwork_thumbnail_state` (canonical PK, desired/published generations, desired revision, dirty token, status/reason/times); `artwork_source_files` (file identity/current observation); `artwork_components` (unique code/ordinal binding); `artwork_thumbnail_jobs` (unique code/revision-token/kind, due time, counters, lease/fence, component checkpoints); `artwork_integration_inbox` (unique provider/account/event); `artwork_sync_state` (cursor, epoch, lease, dirty sequence, health/checkpoints); `artwork_backfill_runs` (unique launch key and progress); `artwork_thumbnail_controls` (singleton booleans default false and budgets); `artwork_thumbnail_audit`; `artwork_thumbnail_publications` (immutable pointer history); `artwork_rate_windows` (shared quotas/cooldowns). Use `timestamptz`, bounded JSON/check constraints and no customer payloads.
  3. Index jobs by due status/time/priority and code/revision, files by ID/path, reverse component lookup, inbox identity, failure pagination and sync cursor identity. Resolution jobs use a non-null generation token before a manifest exists. Do not fabricate a Dropbox path.
  4. Enable RLS on every new exposed table and explicitly revoke PUBLIC/anon/authenticated table/sequence privileges inherited from 0003; grant required service-role access. Keep these tables server-only, with safe status through API, not a broad direct view. Apply equivalent restrictions to each later new RPC. Verify all objects against default grants.
- Done when: schema-contract assertions cover constraints/indexes/RLS/grants; CJ applies only to staging and records results; the old app still reads/writes legacy URL fields and unresolved artwork exists without an `artwork_images` row. CI requires only append-only SQL inspection, not a live database.

### [ ] Task 7: Add atomic queue, cursor and publication RPCs

- Files: new `supabase/migrations/0048_artwork_thumbnail_transactions.sql`, `api/_lib/artwork/store.ts`, `tests/artwork/transactions.sql`, `tests/api/artwork/store.test.ts`.
- Interfaces: service adapter methods `enqueue`, `claim`, `checkpoint`, `fail`, `publish`, `commitSourcePage`, `acceptInbox`, `retrySelected`, `setControls`, `reserveBudget`. All carry explicit expected generation/lease/fence where applicable; returns are typed discriminated success/stale/paused outcomes.
- Do:
  1. Use row locks/`SKIP LOCKED`, 120-second leases, incrementing fencing tokens and atomic quota reservations. Enforce Task 5 bounds in database predicates; concurrent workers cannot double-claim, double-charge expiry or exceed global conversion slots. Serialize per-code resolution and per-account cursor ownership.
  2. Transactionally accept inbox/dirty work before acknowledgement; commit one processed source page, invalidations/jobs and next cursor together. Preserve dirty notifications received during a drain. Keep full-scan epochs provisional until intervening deltas are reconciled; stale scan generations cannot delete/replace newer observations.
  3. Publication compares desired generation/revision, dirty token, current lease/fence and generation-enabled control in one transaction. Atomically write nullable pointer, immutable history and succeeded/ready state. Existing source path required; set component 01 path is compatibility-only. Failure writes use identical stale-work fences. Pause/publication serialize on the controls row so pause cannot race a new publication.
  4. Add audited/idempotent retry, launch start/resume and owner control transactions, plus service-only bounded cleanup enumeration for completed/superseded intermediates older than seven days. Pending/failed intermediates and final/rollback objects are excluded.
  5. Pin function search paths, prefer invoker functions; explicitly revoke EXECUTE from PUBLIC/anon/authenticated and grant intended service role for every new RPC. Validate parameters even on privileged calls.
- Done when: CJ-run staging tests with two actual connections prove overlapping claims, expiry, pause, duplicate intake/retry, cursor rollback and A/B publication races; unit fixtures agree with Task 5 and a crash after upload leaves an orphan, never ready state.

### [ ] Task 8: Protect legacy publications and define Storage policies

- Files: new `supabase/migrations/0049_artwork_thumbnail_legacy_guard.sql`, `0050_artwork_thumbnail_storage.sql`, `tests/artwork/access-matrix.sql`, `tests/api/artwork/legacy-compatibility.test.ts`.
- Do:
  1. Guard new pointer fields against all non-service writes, including first inserts. For F3-managed/published rows also deny non-service key changes and deletes, including through 0024's definer RPC. Use verified request JWT role, not `current_user`, caller payload or user-editable metadata. Keep old RPC signatures and legitimate legacy URL/path refreshes. Protected state/manifests never trust legacy paths as publication authority.
  2. Define bucket-scoped policies for private `artwork-thumbnails`: SELECT only for valid owner/manager/staff/kiosk/cs profiles; no anon SELECT or authenticated INSERT/UPDATE/DELETE. Private `artwork-thumbnail-work` admits no anon/authenticated read/write. CJ creates buckets with private visibility; final objects are JPEG ≤75,000 bytes. Work storage permits those JPEG intermediates and the optional seed JSON ≤1 MB, with type/size validation in the server adapter. Migrations add policies, not destructive changes to unrelated buckets.
  3. Inventory existing permissive Storage policies in staging; OR-combined policies must not reopen either bucket. If an unrelated broad policy grants F3 access, stop and propose a narrowly scoped compatible correction; do not silently claim the new policy overrides it.
  4. Test direct table/RPC/Storage access as each role, anon and missing-profile JWT; exercise old upsert/delete, key changes and attempts to set F3 columns. Legacy route test forces stale path 404/409 and refused best-effort delete, then verifies search still returns an image. Do not extend the old RPC to accept new fields.
- Done when: protected pointers cannot be changed/deleted by any browser role, final reads follow the matrix, work objects remain private, and old app URL refresh/stale-path fallback works on expanded staging schema. Guard scope and rollback behavior are recorded.

### [ ] Task 9: Implement shared server guards, configuration and safe diagnostics

- Files: new `api/_lib/artwork/config.ts`, `auth.ts`, `http.ts`, `limits.ts`, `diagnostics.ts`, `src/lib/domain/artworkAccess.ts` and unit tests; `tests/api/artwork/auth.test.ts`; modify `.env.example`.
- Do:
  1. Validate explicit server Supabase configuration, fixed internal origin, bucket names, account/shop/root allowlists and all spec environment variables. Fail closed on missing/mismatched configuration; no production defaults. Add names/descriptions only to `.env.example`, including all Dropbox refresh/account variables, optional seed folder, Shopify catalogue version, worker secret/origin and both buckets. Preserve digest variables.
  2. Verify bearer JWT with Supabase, load trusted profile/navigation/site membership, then create/use privileged clients. Share pure access predicates consistent with `effectiveNavAccess`; do not import its React AuthProvider into server code. Global safe artwork reads require a valid profile; enqueue requires relevant `order_submission`, `cs_cases` or `cs_returns` access and the requested assigned site (owner follows existing owner access semantics). Settings administration requires owner/manager plus Settings navigation; only owner controls global switches/start of launch run.
  3. Method allowlists, bounded raw bodies before parsing, Zod schemas, constant-time secret/signature comparison and safe HTTP error codes. Separate webhook HMAC, cron bearer and worker bearer authentication; a browser JWT cannot run workers. Never derive worker destination from Host or sign a client path.
  4. Enforce durable limits via Task 7: status 120/account/minute, resolve 12/account/minute, discovery 30 new codes/user/hour and 300 global/hour, admin 10/minute and ≤50 retry codes. Return Retry-After, with no expensive work before admission. Safe logs include IDs/code/reason/attempt/time/bytes, never credentials, signed URLs, customer bodies or raw provider responses.
- Done when: tests cover five roles/nav overrides/sites, missing/expired JWT/profile, spoofed roles/hosts/paths, wrong methods/secrets, body limits, concurrent quota use and sanitized failures. Default staff/CS navigation is unchanged.

### [ ] Task 10: Build the Dropbox refresh client and durable source index

- Files: new `api/_lib/artwork/dropbox.ts`, `sourceSync.ts`, `tests/api/artwork/dropbox.test.ts`, `sourceSync.test.ts`.
- Do:
  1. Use read-only offline refresh credentials; cache short-lived access token with expiry buffer server-side, retry refresh once on 401 then surface configuration failure. Never depend on manual static-token replacement for new work.
  2. Recursively inventory only the configured source root using `list_folder`/`list_folder/continue`. One bounded page per invocation (request 100 where supported, handle actual provider pages without discarding entries), saved cursor/subpage checkpoint and lease. Store exact metadata/deletes; handle moves, cursor reset and resumable full epochs. Reverse component mappings invalidate all affected canonical codes.
  3. Use Task 7 page transactions and dirty sequence so a concurrent webhook is never cleared accidentally. Full scan completion reconciles intervening deltas before missing files are declared deleted/current; prior generations cannot overwrite newer observations.
  4. Cap shared Dropbox traffic at 60 requests/minute plus provider backoff. Pin revision downloads or compare pre/post metadata, validate returned file/account/root/path/hash and stream to Task 2 caps. Reject traversal, arbitrary redirects and returned-path mismatch. No writes or preview generation in Dropbox.
- Done when: tests cover multipage/bootstrap/reset, notification during drain, crash before cursor commit, delete/move/re-add, replacement during download, refresh failure/429/backoff and no calls outside configured roots.

### [ ] Task 11: Resolve current sources into durable manifests

- Files: new `api/_lib/artwork/resolver.ts`, `tests/api/artwork/resolver.test.ts`; use Tasks 4–7 and 10.
- Do:
  1. Resolve catalogue/on-demand descriptors against indexed current metadata, serialize per-code discovery and use source-dirty generations. Verify exact bindings against Dropbox before constructing a complete manifest. Persist missing/ambiguous results as bounded resolution jobs without a legacy row or fake path.
  2. Add canonical mappings/rows for verified old set/free-print aliases without renaming/deleting old rows or copying component-01 URLs as complete sets. Legacy cache/index entries are candidate hints only. Record selected same-content path and alias provenance; conflicting content requires review.
  3. Mark old readiness invalid on dirty evidence and hide prior art until current resolution/publication. Unchanged resolved bytes/revision reuse valid output; changed manifest creates idempotent new generation jobs. Title/price-only events do not convert again. A later file arrival wakes waiting/failed missing-source work automatically; repeated renders do not reset it.
- Done when: tests cover product-before-source without `artwork_images`, old-key reconciliation, no fuzzy match, all set components, component-02 replacement, stale snapshot and unchanged terminal failure. Current desired state never comes from event ordering or a legacy URL.

### [ ] Task 12: Connect bounded generation, durable checkpoints and immediate dispatch

- Files: new `api/_lib/artwork/worker.ts`, `storage.ts`, `dispatch.ts`, `api/artwork/worker.ts`, `tests/api/artwork/worker.test.ts`; modify `package.json`, `package-lock.json`, `vercel.json`.
- Do:
  1. Pin `@vercel/functions` for `waitUntil` to perform a bounded authenticated kick after a successful durable commit. Use fixed `ARTWORK_INTERNAL_ORIGIN` plus worker secret, not Host; failed kick leaves recoverable queue state. Continuations use the same admission/lease limits, never an unawaited promise or unbounded recursion.
  2. Worker claims through Task 7 and orchestrates Task 11/2. Persist each reduced component into the private work bucket under manifest/ordinal/content/output digest; checkpoint path, dimensions/bytes/checksum before releasing. Validate reuse after process/tmp loss. At most one original or ten small components, 90 seconds per invocation, global slots and budgets from Task 5. Do not launch multiple large children inside Fluid concurrency on one instance.
  3. Compose only complete current checkpoints, upload immutable `v1/<canonical>/<manifest_digest>/<output_sha256>.jpg` with overwrite disabled, verify any pre-existing object's metadata/checksum. Revalidate current source metadata and publish via fenced transaction. New dirty generation, expiry or pause leaves no stale ready/failed update. Preserve old final objects and publication history.
  4. Record queue timing, quota reservation/actual usage and safe failures. Continue successfully checkpointed work without retry charges; bounded crashed work consumes exactly one failure. Cleanup only eligible private intermediates in bounded pages after seven days; no final-object automatic deletion.
- Done when: API/native tests simulate mid-set restart with tmp wiped, six/nine components, crash after upload, duplicate upload, pause mid-render, lease expiry and A held while B publishes. Actual Preview worker still meets Task 3 resources and image errors cause no stock/production writes.

### [ ] Task 13: Add Shopify catalogue paging and signed product intake

- Files: new `api/_lib/artwork/shopify.ts`, `api/shopify/artwork-webhook.ts`, `tests/api/artwork/shopify.test.ts`, `shopify-webhook.test.ts`; modify `api/shopify/install-start.ts`.
- Do:
  1. Add `read_products` while retaining existing install scopes. Pin a supported `ARTWORK_SHOPIFY_API_VERSION` for catalogue and webhook registration together, verifying current official docs at implementation; do not inherit `2024-04` or change order lookup behavior incidentally. Fetch only SKU/ID/update fields, not photos/customer data.
  2. POST raw-body HMAC-SHA256 with `SHOPIFY_CLIENT_SECRET`, allowed shop and `products/create`/`products/update`, bounded input (proposed 1 MB webhook cap, verified against test deliveries), and durable dedupe by shop/event identity. Configure and test Vercel raw-body handling so JSON parsing cannot change the signed bytes; reject a request whose original bytes are unavailable. Persist minimal product/event IDs before 2xx; database failure returns retriable non-2xx. Kick after acceptance. Do not reuse OAuth query-HMAC verification.
  3. Worker reads current product variants with independent saved pagination, including >100 variants. Variant creation/update/removal arrives through product updates, not an invented variants topic. Each step reads at most one page, proposed 100 records; use ≤20 GraphQL requests/minute and provider cost/throttle limits.
- Done when: tests independently prove product create, variant add/update, >100 variants, duplicate/out-of-order delivery, title-only no conversion, missing source and failed durable acceptance. CJ's staging reauthorisation/subscriptions are recorded; existing order lookup regression tests remain green.

### [ ] Task 14: Add signed Dropbox notifications and challenge verification

- Files: new `api/dropbox/artwork-webhook.ts`, `tests/api/artwork/dropbox-webhook.test.ts`.
- Do:
  1. GET accepts only a bounded challenge (≤1 KB), echoes plain text with `nosniff`. POST bounds raw body (proposed 64 KB), uses verified Vercel raw-body handling, verifies `X-Dropbox-Signature` using app secret before parsing and permits only configured account notifications.
  2. Atomically increment the account dirty marker before 2xx, then kick Task 10 via Task 12. Notifications identify accounts, never authoritative paths. Repeated events coalesce safely and notifications arriving while a cursor drains schedule a subsequent pass.
  3. Reject wrong methods/signature/account and return retriable failure if durable intake fails. Generation pause preserves accepted intake and dirty state.
- Done when: raw-byte tampering/challenge/size tests pass, independent new/replaced/deleted-file notifications reach generation in staging, and no notification can be lost between acknowledgement and cursor commit.

### [ ] Task 15: Expose separate batched resolve and read-only status endpoints

- Files: new `src/lib/domain/artworkContract.ts`, `api/artwork/resolve.ts`, `status.ts`, `api/_lib/artwork/status.ts`, `tests/api/artwork/status.test.ts`, `resolve.test.ts`.
- Interfaces: POST resolve `{ skus, location, screen }` ≤100 SKUs/16 KB; POST status `{ codes }` ≤100 unique codes/16 KB. Shared response includes display control/version, canonical code, state/reason, desired/published revision, nullable final URL and URL expiry; no source paths, private checkpoint paths or raw provider errors.
- Do:
  1. Resolve validates profile/nav/site and returns per-SKU non-artwork/unknown/status immediately; enqueue genuine misses idempotently with bounded discovery. Failed persistence returns truthful unavailable, not queued. Non-artwork never enqueues; callers cannot set revisions, generation, paths or bucket.
  2. Status performs only safe metadata reads and batched signing from protected current published state. No queue/provider/conversion side effects. Private signed URLs last 60 minutes; do not sign outdated desired revisions, arbitrary client paths or work objects. Apply response no-store for private status/URLs and durable read limits.
  3. Include controls in status even when display is off so clients can resume without deployment. Safe shared art reads are global for valid profiles, not order/customer disclosure; enqueue retains site/screen restrictions.
- Done when: tests assert zero provider calls for ready/pending polls, separate quotas, missing-profile rejection, wrong-site enqueue denial, malicious path rejection, expired URL refresh and multi-code dedupe. Three tablets sharing one kiosk account stay within normal polling allowance.

### [ ] Task 16: Add protected recovery ticks and recurring reconciliation

- Files: new `api/artwork/reconcile.ts`, `api/_lib/artwork/reconcile.ts`, `tests/api/artwork/reconcile.test.ts`; modify `vercel.json`.
- Do:
  1. GET requires bearer `CRON_SECRET`; fail closed if unset. Add a one-minute F3 tick; persisted due times select 15-minute incremental catalogue work and daily full catalogue/source audit without starting full scans every minute. Keep all three digest cron entries unchanged.
  2. Read one bounded page per invocation, save cursors and continue immediately when admissible. Overlap incremental watermarks and dedupe; full audits find missed deletions/older changes. Reclaim expired jobs and drain dirty cursors with overlap-safe leases. Do not endlessly restart unchanged terminal failures.
  3. Expose budget/cooldown/degraded health and last complete audit separately from partial-page success. Paused generation retains intake and checkpoints. Repair missed webhook/setup gaps through current reads, not event replay assumptions.
  4. CJ verifies plan/cadence and uses a protected staging-only runner/manual tick for Preview; a production cron declaration does not prove Preview runs. No daily-only replacement of the recovery target.
- Done when: tests cover overlapping ticks, >one-page catalogue/variants/sources, crash/resume, missed Shopify/Dropbox event repaired by schedule, expiry recovery and unauthorized cron-like requests. CJ records actual scheduler/cadence evidence.

### [ ] Task 17: Add verified optional seeds and the resumable launch backfill

- Files: new `src/lib/domain/artworkSeed.ts`, its domain tests, `api/_lib/artwork/seed.ts`, `backfill.ts`, `tests/api/artwork/backfill.test.ts`, `seed.test.ts`; modify `.env.example` and `api/_lib/artwork/config.ts` for the optional seed-index object setting.
- Do:
  1. Validate v1 seed index shape and `data_sha256` over exact serialized entries; explicit legacy key mapping only. For each component require current exact source metadata/hash to select an index candidate, then decode/validate ≤400 × 400/75,000-byte JPEG. Distinguish Dropbox source hash filename from output SHA-256. Multi-hash without current proof, stale/corrupt/missing index data falls back to originals or a named source conflict. Never install seeded readiness without the same manifest/publication checks.
  2. Make the local-only index available without assuming a Windows path exists in Vercel: CJ may copy the read-only snapshot once into the service-only work bucket at `seed/packing-preview-index-v1.json`. Add optional server `ARTWORK_SEED_INDEX_OBJECT` restricted to that seed prefix; absent means no seeding. Bound index input to 1 MB/20,000 entries and validate before use. Preview uses a synthetic index and isolated preview folder. Read source preview JPEGs through configured `DROPBOX_PREVIEW_FOLDER`; never write the original index/folder or run Part 6 scripts. Do not commit the historical index/originals. Store provenance/validation time; source-creation time is not inferred. Seed-disabled/unavailable still uses the complete automatic original path. Intermediate cleanup excludes the seed prefix.
  3. One stable owner-created launch run unions all paginated Shopify products/variants, discovered source mappings and verified legacy-cache candidates. Unknown legacy keys remain named unresolved exceptions, never guessed canonical mappings. Save catalogue/variant/source page cursors and per-component progress; dedupe by code, use same generation pipeline and Task 5 fair priority.
  4. Persist discovered/queued/ready/pending/failed/unsupported totals with distinct identities and exception lists. Pause/resume/repeated start is idempotent, not a new full rescan. Completion means traversal finished and every discovered entry accounted for, not that all entries are ready; CJ must review unresolved coverage before display.
- Done when: tests cover valid/stale/multi-hash/corrupt seeds, source change during seed copy, seed-off automatic generation, >API row-limit catalogues and mid-product/mid-set resume without recounting or redoing completed work.

### [ ] Task 18: Add audited administration and runtime controls

- Files: new `api/artwork/admin.ts`, `api/_lib/artwork/admin.ts`, `tests/api/artwork/admin.test.ts`.
- Do:
  1. Use explicit GET health/failures pagination and POST action schemas for retry, backfill start/pause/resume, controls and budgets; server derives actor identity. Managers with Settings may inspect/retry ≤50 selected failures, including safe credential-repair diagnosis; owners control global display/generation, launch run and budget adjustments. Treat launch pause/resume as owner-only with start.
  2. Audit action ID, actor, reason, timestamp and result; duplicate idempotency key returns prior result. Retry affects selected failed jobs only, not duplicate generations. Rate-limit 10/admin/minute. Health exposes pending/failed counts, oldest pending age, safe component/revision/attempt/first-last-failure/next-retry, receipt/cursor/reconciliation times, backfill coverage and budget pauses. No token diagnostics from `whoami.ts`.
  3. Controls default off, are persisted globally and are read by worker transactions and client status. Generation pause denies claims/publications but retains verified intake. Display off does not trigger legacy original downloads. Measure >120s source-available work as degraded, not successful latency.
- Done when: tests exercise repeat/partial retry, pagination, owner-only switch/launch enforcement, manager Settings override, forbidden staff/kiosk/CS access, sanitized health, and pause versus publication atomicity in staging.

### [ ] Task 19: Add the shared client batch/cache controller

- Files: new `src/lib/hooks/useArtworkThumbnails.ts`, `src/lib/artwork/thumbnailClient.ts`, `src/lib/domain/artworkClientState.ts`, their tests; use existing QueryClient/auth lifecycle.
- Do:
  1. Collect unique descriptors once per displayed order/view; chunk ≤100, share promises/status across rows and variants. Cache by backend/project/session identity/canonical code/published revision. Resolve once per input change/admitted retry, then read status; rows never call resolve. Pending/failed values are not permanent sessionStorage sentinels.
  2. Poll visible pending work at five seconds, back off to 15 seconds after two minutes, stop hidden/background polling. Ready metadata and runtime controls revalidate every 60 seconds or on focus; foreground display switch takes effect within 60 seconds, hidden tabs revalidate before showing art. Respect Retry-After and shared-account limits.
  3. Refresh signed URLs in batches five minutes before 60-minute expiry. Image error allows one status/URL refresh per revision, then visible unavailable; it never causes unbounded regeneration. Invalidate cached ready art on dirty/new desired revision. Distinguish fetch/offline errors from terminal generation failure.
  4. Clear private entries/in-flight effects on sign-out, account/project/backend change. Dexie exits with local labels before `getSupabase`, auth or API access; even module initialization must not construct Supabase. Use dependency-injected transport/clock and pure state tests plus existing React server-render tests; real lifecycle is verified on Preview.
- Done when: tests cover dedupe/chunking, pending-to-ready without reload, expiry, one-error refresh, stale/new revision, account changes, hidden/focus behavior and Dexie zero-network/auth calls; three simulated shared-account tablets avoid request storms.

### [ ] Task 20: Mount thumbnail presentation in both order layouts

- Files: modify `src/components/ProductImage.tsx`, `src/components/production/OrderLineDisplay.tsx`, `src/pages/Production.tsx`, `src/components/production/station/StationOrderScreen.tsx`, `src/components/production/station/station.css`; extend each layout's tests and new `src/components/__tests__/ProductImage.test.tsx`.
- Prerequisite: station-screen-redesign is integrated/rebased into the reviewed combined candidate by the authorised coder/CJ workflow. Its verified file is under `production/station/`. If unavailable, stop this task and record the dependency; do not ship only one layout as completed F3.
- Do:
  1. Make `ProductImage` a presentation consumer of Task 19 status and error callback. Retire `dropbox_img:<full SKU>`/`__missing__` usage. Pass artwork state through existing props/view model from one order-level controller into both slots; no row effects that fetch providers.
  2. Use actual image `object-contain`, accessible art/code and “Set of N”, existing frame-colour border/contrasting outer ring for black/white, neutral unframed/canvas outline. Keep large F2 colour block, title/size/quantity/badges/actions and station border. Remove any `aria-hidden` ancestor from meaningful artwork/status in the station slot.
  3. Render “Preparing artwork”, “Waiting for artwork file”, “Updating artwork”; failed warning icon + “Artwork unavailable — tell a manager” + code; network failure “Artwork status unavailable”. Explicit non-artwork labels: “Gift card — no artwork”, “Frame only — no artwork”, “Accessory — no artwork”. Unknown: “Artwork unavailable — SKU not recognised”. Dexie art: “Artwork previews require connected mode”. Display-off reserves a neutral labelled placeholder. Status text can sit beside the 64px slot for readability.
  4. Keep all scan/verify/undo/complete/dispatch/clock handlers and cancellation/site preflight unchanged. No image state disables controls or changes quantity/count attribution. No staff Check status button assumed in this draft.
- Done when: render tests cover all states/tones/sets and unchanged controls; CJ's Preview tablet check covers both screen switches, light/dark, long titles, six-piece art at 1 m, offline/reconnect and image-off operation.

### [ ] Task 21: Add the Settings operations panel

- Files: new `src/components/ArtworkThumbnailsPanel.tsx`, its tests; modify `src/pages/Settings.tsx`.
- Do:
  1. Mount only for owner/manager with Settings access in connected mode. Present Task 18 counts/health and stable paginated failure list, safe reason/code/component/attempts/revision/retry time, selected retries and backfill progress. Provide owner-only display/generation switches, launch start/pause/resume and budget controls; show pending/error/success without claiming an unaccepted action succeeded.
  2. Show timestamps with explicit selected-site zones: Australia/Sydney, Europe/London, America/Chicago. Separate observed source/seed-validation/publication times and measured latency from estimates. Warn visibly about overdue source-ready work, cooldown/budget pauses and stale cursor/reconciliation health.
  3. Explain the operational fallback using existing title/SKU/size/colour/quantity and normal verification. No raw Storage URLs/provider diagnostics, customer information, new navigation privileges or Slack/email integration.
- Done when: rendered role/state tests and Preview interaction verify owner/manager differences, Settings removal, idempotent retry/backfill actions, time zones and safe failures. Staff/kiosk/CS cannot access the panel/API directly.

### [ ] Task 22: Verify the combined staging candidate and prepare CJ's release evidence

- Files: `tests/artwork/staging-checklist.md`, remaining focused F3 test files, this plan's Implementation log/Open questions; remove temporary `api/artwork/benchmark.ts` and its public route-specific test, retain the protected runner/results as test evidence; update `tsconfig.artwork-api.json`/`vercel.json` only as required by removal. Coder records results here; planner review goes separately through the normal review handoff.
- Do:
  1. Re-check migration numbering/dependency order against item-counting and the exact combined release, station integration and all spec acceptance criteria. CJ applies staging SQL/buckets and deploys the combined Preview. No claim of release readiness based only on isolated F3 tests.
  2. Run the Staging test plan below with actual roles, concurrency, provider fixtures and resource measurements. Repeat Task 3 measurements on final worker packaging/configuration and real trigger → accepted → sources-available → ready → client-displayed timestamps; normal-service target ≤120 seconds including polling. Report outages/backlog/budget pauses as exceptions/degraded, never omit them from evidence.
  3. Test old rollback build against expanded staging schema, with valid legacy Dropbox credentials, legacy stale-path behavior and current digest protection. Verify no thumbnail action writes inventory, events, credit or KPI counts.
  4. Run `npx tsc -b`, `npm run typecheck:artwork`, `npm run typecheck:digest`, `npm run test -- --run`, `npm run build`. Inspect server bundle/native child inclusion and browser assets for Sharp/server credential imports. Ensure temporary benchmark route is absent from the release bundle. Record actual outputs, CI URL and reviewed commit, without invented baseline test totals.
  5. Hand the exact candidate/evidence and unresolved operational choices to CJ and the planner reviewer. Do not merge, deploy, apply SQL or mark any unrun staging step complete.
- Done when: all acceptance tests have recorded results, CI is green on the combined PR, the review verdict permits release, and CJ has the ordered runbook below. Task completion is implementation handoff, not production release approval.

## Staging test plan

CJ first confirms browser/server project `ybrzhrgfrnvtcwymjdrq`, Preview worker origin, separate test credentials and synthetic data. CJ creates private final/work buckets, applies the batch expansions and deploys Preview; agents do not perform those steps. Run fixture HTTP tests only after the staging identity assertion. CI uses mocks and pure tests; SQL/Storage tests use staging only.

| Actor | Positive checks | Direct-denial checks (not just hidden UI) |
| --- | --- | --- |
| Owner | Read/status, authorised resolve, Settings, retries, one launch run, switches/budgets, audit/idempotency | Browser JWT cannot call worker/cron, new service RPCs or write queue/pointers/Storage; cannot sign arbitrary/work paths. |
| Manager | Assigned-site resolve, global safe art read, Settings health/retry | Global switches/start/pause/resume/budget changes denied; Settings API denied when nav removed; other-site resolve denied; all direct F3 writes denied. |
| Staff | Default Welcome-only preserved; safe art read; resolve only after explicit order-screen/site grant | Default enqueue/admin denied; after screen grant, admin/worker/direct table/RPC/Storage writes still denied. |
| Kiosk | Assigned-site order art; framed/A0/unframed/dispatch flows; three tablets sharing account | Other-site resolve, Settings/failure list/retry, direct mutations/worker calls denied. |
| CS | Safe art in existing authorised CS/order flow; assigned-site enqueue with relevant existing nav | No automatic Production grant; admin/health/retry/other-site resolve, arbitrary signing and direct writes denied. |
| Anon / missing profile / expired JWT | No private access | Deny status, resolve, admin and final/work Storage reads/writes. Raw SQL/REST grants, old/new RPC and Storage tests include these identities. |

For **each** authenticated role, test direct protected-column insert/update, key rename and delete, including old definer RPC calls; inspect no-change results as well as errors. Final-image SELECT follows valid-profile policy; work-bucket SELECT is denied to every browser role. Test inherited/default privileges and existing permissive policies. Forged client role/site/path/revision, wrong methods, oversized bodies, HMAC tampering, wrong shop/account and cron-looking headers fail before expensive work.

Run these scenario groups in Task 22, with focused automated coverage already owned by earlier tasks:

1. **Trigger independence:** disable other triggers in isolated staging tests and separately prove product create, variant create/update, >100 variants, Dropbox arrival/replacement, on-demand miss and scheduled repair. Product-before-source must persist without `artwork_images`; later arrival recovers. Test missed event during setup, cursor reset, multipage drain, interrupted page and notification-during-drain.
2. **Races:** two kiosks, overlapping cron/worker calls, A held → B published → A released, expired fence, crash after upload/before commit, component-02-only replacement, source replacement during download/full scan. No partial set or stale success/failure; one current pointer. Pause mid-job blocks claims/publication while verified intake survives.
3. **Failure/recovery:** provider 401/429/5xx/timeout, bad hash, corrupt/oversized/high-bit-depth input, missing/ambiguous source, invalid seed, upload/database outage, six-failure exhaustion and audited retry. Ordinary poll/reload/reconcile never resets terminal failures. No network/URL failure blocks shop-floor actions; reconnect/session/URL expiry recovers without storage clearing.
4. **Performance/coverage:** real cold/warm Preview native benchmarks, large and six/nine-component cases across invocations, temporary disk removal, actual 120-second display timing. Paginate beyond normal API row caps, two years of job metadata/three sites; inspect due-job/index plans, not months of events. Pause/resume launch backfill mid-page/component; reconcile all discovered coverage and exception lists. Verify on-demand priority plus eventual backfill progress and visible budget-paused health.
5. **UI/controls:** both station layouts/themes, mixed SKU order/non-artwork/unknown/free-print, frame contrast, long titles, set readability, state accessibility; display off on an open foreground tablet ≤60s, hidden-tab revalidation, generation pause/resume, no Dexie API/auth calls. Check private caches across sign-out/account/project changes.
6. **Compatibility/smoke:** old app against expanded schema plus `docs/RELEASING.md`: roles' pages, clock in/out, event/verify, exactly-once stock retry, Shopify lookup, shipment/CS case/return saves, Dashboard/Reports/console. F3 adds no event/ledger/count writes. Retain digest auth and all AU/UK/US schedules; use safe test recipient configuration for any separately authorised digest test.

## Hardening in the plan

| Checklist area | Implementation and evidence |
| --- | --- |
| Network/provider/database outage and user recovery | Tasks 5, 10–19: durable intake, bounded retry, truthful status, independent production controls; Tasks 20–22 verify visible failure/offline recovery. Slack/Make outage is n/a because F3 never calls them. |
| Idempotency/two devices/workers | Tasks 5–8, 12–18: natural/unique keys, cursor transactions, lease/fencing, immutable objects, audited action IDs; real concurrent staging tests in 7/22. |
| Bad/missing SKU, malformed scan, cancelled or wrong-site order | Tasks 4, 9, 15, 20: no guessed artwork, explicit labels, validated site/nav; scan parsing/cancellation remains existing Production responsibility and is smoke-tested. |
| Counts/attribution/history | Tasks 4/20/22 reuse SKU identity but never introduce a count rule or mutate production/stock. Set layout is only presentation. Stored historical credit is unchanged. |
| UTC/site time and measured versus inferred data | Tasks 6, 17, 18, 21: UTC timestamps, explicit site zones, separate seed validation/source observation/publication times and measured latency; no invented source creation time. |
| Auth, RLS, grants, Storage, definer RPCs, secrets | Tasks 6–10, 13–18, 22: endpoint-specific auth, explicit revokes, verified-role legacy guard, direct five-role denials, bounded allowlisted I/O and redacted logs. |
| Cost/abuse | Tasks 5, 7, 9, 10, 12, 13, 15–18: durable account/global limits, provider cooldowns, concurrency and daily budgets, bounded admin/discovery, owner controls. |
| Expand-only and emergency off | Tasks 6–8/18–22 and runbook below. Existing schema/RPC readers retained; runtime display/generation flags default off and pause publication transactionally. |
| Performance and scale | Tasks 3/6/7/10/12/15–19/22: real resource gate, indexed stable pagination, per-view batches/cache, bounded schedules; no event-history scans or provider calls per row. |
| Operations/fallback | Tasks 18/21: queue age, failed list, receipts/cursor/audit/budgets/backfill and >120s degradation. Existing SKU/title/colour/size and verification remain fallback. Monitor subscriptions, supported Shopify version, refresh credentials, native dependency, spend/egress and object growth. No new messaging service. |
| Tests | Tasks 1–22: pure domain edge cases, API auth/race mocks, native checks, staging DB/Storage/concurrency, browser walkthrough and combined CI. Inventory/money logic changes n/a; preserve existing tests and exactly-once smoke to prove isolation. |

## Release and rollback

This is **one bulk batch release run by CJ**, including the other approved features in the release candidate. Task commits are not separate deployments. Agents never merge, deploy or apply SQL. Early feasibility and later combined staging Previews are CJ-run tests, not production release slices.

### Migrations and compatibility

- `0047_artwork_thumbnail_state.sql`: nullable cache additions and separate tables/indexes; unresolved work does not break old `dropbox_path NOT NULL`.
- `0048_artwork_thumbnail_transactions.sql`: new service-only RPCs and transactional state; no old signature/return change.
- `0049_artwork_thumbnail_legacy_guard.sql`: new protection around F3 fields/key/deletion while allowing old legacy URL refresh; test refused stale deletion still falls through to search.
- `0050_artwork_thumbnail_storage.sql`: scoped policies for new buckets only; private defaults. Final numbering is re-checked against item-counting and the complete batch before merge as above.
- Rolling back the app leaves the database usable **provided the recorded old-build compatibility tests pass**. Old cache columns/aliases and route remain, new fields are nullable, queues are separate, and a working legacy Dropbox credential is mandatory. Do not promise compatibility for arbitrary historical deployments, especially those predating digest authentication.

### CJ's order of operations

1. Review the draft spec and plan together; settle Open questions/defaults and record approval separately before implementation. Complete Task 3 on staging Preview early. Before release, close all resource/security/source-identity gates, reconcile final migration numbers/order against item-counting, and obtain green combined PR CI plus reviewer verdict. CJ applies all migrations/bucket setup in staging and runs the combined Preview/old-build checks first.
2. Pick a quiet production window away from shift starts and digest times. Record exact current production deployment/commit as rollback target, verify its digest guard and operational legacy Dropbox credential, snapshot existing provider subscriptions/config, back up production schema/data and confirm Storage recovery. Do not use app backup export as a full database backup.
3. **Before merging**, CJ configures Production server variables separately from Preview: explicit Supabase keys/URLs; Dropbox app key/secret/refresh token/account/root, optional read-only seed folder and `ARTWORK_SEED_INDEX_OBJECT`, and legacy credential; Shopify client/secret/shop/admin token/catalogue version; worker secret/fixed origin; final/work bucket names; existing CRON_SECRET and digest recipient settings. Confirm paid worker allocation/duration/cadence. Reauthorise Shopify with existing scopes plus `read_products` and Dropbox offline metadata/content read scopes. If the old deployed install-start cannot request `read_products` yet, use the provider's approved scope-update/install process during this preparatory step; do not assume the old endpoint already contains Task 13.
4. CJ provisions private `artwork-thumbnails` and private service-only `artwork-thumbnail-work`, verifies visibility/policies and applies the entire batch's additive migrations in dependency order. If seeding is selected, CJ copies the read-only index snapshot to the configured private work-bucket object from Task 17; the original reference remains untouched. Display/generation remain false. Check old code still works against the expanded schema. Never replay the recovered migration set indiscriminately.
5. CJ merges the reviewed bulk candidate once; Vercel produces the production deployment. Verify project/origin identity, auth guards and Sharp native packaging. Only after handlers exist, register Shopify product create/update webhooks at the pinned version and Dropbox webhook/challenge. Verify signatures and durable receipts, initialise recursive source inventory/cursor, then reconcile changes during setup. Preserve all digest schedules and Part 6 artifacts.
6. CJ enables generation with display off, starts the unique resumable launch run, monitors resource budgets and interactive priority, and checks seed provenance/current-source validation. Pause/resume as needed. Finish catalogue/source traversal, review every named failed/unsupported/unresolved item, correct aliases only with evidence, and reconcile post-backfill changes. No unexplained coverage gaps before display.
7. CJ enables display, tests a small operational sample and actual automatic product/file processing/timing, performs production smoke checks read-only where possible, tags the bulk release and watches logs/health at least 30 minutes. Confirm real cron execution/cursor progress and subsequent autonomous new/replaced art. Confirm AU/UK/US digest runs on their normal schedules; a manual Preview tick does not prove production scheduling.

### Rollback order

1. Owner switches display off immediately; pause generation if faulty/costly. Open tablets use safe reserved placeholders; no automatic fallback to per-row originals.
2. If intake itself is faulty, CJ disables only F3 subscriptions/scheduler targets, records the gap and preserves inbox/jobs/cursors. Retain CRON_SECRET and daily digest schedules. Pausing generation alone keeps verified intake durable.
3. CJ uses Instant Rollback to the recorded compatible deployment and runs release smoke checks. If that build lacks F3 endpoints, keep F3 subscriptions/targets paused to avoid futile delivery; verify legacy Dropbox reads and digest protection. Do not roll back to an unguarded digest endpoint without the separate access protection required by `docs/RELEASING.md`.
4. CJ fixes forward or reverts the bulk merge through a reviewed branch. Keep expanded schema, legacy aliases, jobs, checkpoints, old/new final objects and pointer history. Do not drop new objects/columns, edit old migrations or restore a database backup over new operational work. On recovery, re-enable intake and reconcile the recorded gap before resuming generation/display.

No contract migration is required to operate F3. Retiring legacy RPCs/cache columns or pruning old final/rollback objects requires a separately reviewed later release and retention policy; this batch only cleans eligible completed/superseded private intermediates.

## Out of scope

- Modifying Make Part 6, its local scripts/index or packing-slip preview folder; new manual generators after launch.
- Shopify product photos, writes to Shopify/source art, frame-specific renders, new stock/KPI/count/attribution rules or historical event changes.
- Rewriting order lookup, its API version, procurement `/orders`, existing cancellation rules or broader legacy SKU grammar.
- Repository/Dexie feature parity for a Supabase-only authenticated production service; neither repository implementation gains thumbnail methods.
- Dedicated conversion service unless the feasibility gate fails and CJ approves a revised design; Dropbox thumbnail fast path is optional and omitted here.
- Broad retirement of legacy RPCs, unrelated security cleanup, final-object retention deletion or new Slack/email alerts.

## Open questions

The defaults below are recommendations for this draft, not recorded approval. CJ reviews them with the spec. The coder stops here for unanticipated design changes; task-local implementation details do not authorise changing these contracts.

| Spec question | Default assumed by tasks | If CJ chooses otherwise |
| --- | --- | --- |
| 1. Set presentation | One equal-cell, no-crop, ordered composite of **all** components, accessible “Set of N”. | Tasks 2–4, 12, 15, 19–20 and 22 change for renderer/version, publication/response and display tests. Keep complete-set semantics and one canonical identity; review six-piece readability before acceptance. |
| 2. Bucket visibility | Private final bucket, 60-minute signed URLs refreshed five minutes early; work bucket always private. | Tasks 8, 12, 15, 19, 22 and release setup change for public final reads/cache. CJ explicitly accepts public retrievability; no relaxing writes or work-bucket privacy. Public reads bypass final-image read RLS. [Supabase bucket access](https://supabase.com/docs/guides/storage/buckets/fundamentals). |
| 3. Part 6 seed | Yes, optional at launch only, validated against exact current source hash plus decoded JPEG; no future dependency. | Task 17 omits seed adapter/index validation if declined; Tasks 3/22 and launch budgets/timing must demonstrate all-original backfill. Tasks 10–16 remain the automatic source of truth. |
| 4. Vercel plan/cadence | Confirmed 4 GB paid allocation, immediate kicks, one-minute recovery, 15-minute incremental and daily full audit. | Task 3 stops if capacity is unavailable; Tasks 12/16/18/22 and release configuration need a revised measured worker/scheduler design and cost decision. Daily-only recovery cannot silently meet the target. Platform maxima are not account evidence. [Vercel limits](https://vercel.com/docs/functions/limitations). |
| 5. Failure wording/action | Warning icon, code and “Artwork unavailable — tell a manager”; production remains usable; no staff action button. | Tasks 19–21/22 copy/accessibility tests change. If Check status is wanted, use bounded status/URL refresh in Task 19, not privileged retry or regeneration. |
| 6. Large-source feasibility | 150 MB/300 MP envelope with mandatory measured Task 3 gate, no local 500 MP exception. | Stop Tasks 4–22 until CJ reviews dedicated automated service/cost proposal; revise worker/auth/ops/resource tests. Sharp supports explicit pixel limits, but no documented limit proves process RSS. [Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/). |
| 7. Source authority/legacy names/sites | Exact audited alias map; shared library only where canonical identity truly agrees; conflicts are visible exceptions. | Tasks 4/10/11/17 and coverage tests pause for conflicting mappings. Separate site-specific identities would alter the spec's shared-key contract and require CJ/planner revision, not a coder workaround. |
| 9. Legacy rollback exposure | Preserve URL reads/fields, protect F3 state, select tested rollback build with valid credential. | Tasks 8/22 and rollback runbook change if current deployment cannot pass; fix compatible rollback path before release. Broader legacy RPC retirement remains separate. |

### Spec question 8 — closed: discovery notes supplied and reconciled

The user reproduced the coder's 2026-11-22 notes in this planning request, removing the unavailable-note-content blocker. This closes **reconciliation of the notes**, not the remaining live-source, account-tier or converter gates. The original denied notes file was not read; the draft spec is not edited in this task. Evidence is distinguished as follows:

- **Re-verified in this checkout:** server/client key disagreement (`S3-WIL0049-01` versus `S3WIL0049`, `AUX-FP-ESP` versus `ESP`), complete component helper, loose search fallback, legacy expiring-link route and stale-delete fallthrough; migration 0024's NOT NULL path and authenticated definer RPC grants; 0003's broad defaults; unused `ProductImage` and unexpiring session cache; F2 slot; missing `read_products`; only three digest crons; no Sharp dependency; frontend-only tsconfig and existing dedicated digest check; no artwork methods in Repository/either adapter. These findings drive Tasks 1, 4, 6–16 and 19–20.
- **Re-verified from local branch refs, not deployed state:** item-counting uses 0034–0046. Station redesign contains the ARTWORK placeholder at `src/components/production/station/StationOrderScreen.tsx` (the directory detail omitted in the notes), and is absent from this checkout. Task 20 waits for integration. Re-read current refs before implementation/merge; the notes' `origin/main @ 8519ac9` is historical context, not a claim about a freshly fetched remote head.
- **External reference facts supplied by the coder, not independently reread here:** manual one-shot Part 6 generator, content-hash JPEG naming, 150 MB/local 500 MP JPEG exception, quality ladder, exact matching conventions, static v1 index with 583 keys, parent-folder paths for `docs/print-exclusions.md` and `output/packing-preview-index-v1.json`, and known oversized filenames. They agree with the spec's read-only/optional-seed conclusion. They do not establish current remote contents, authoritative aliases or Vercel capacity. Local concurrency two and the JPEG exception are deliberately not inherited by F3.
- **Audit counts are different snapshots/populations:** the coder's September source audit (615 files/566 hashes) is not the spec's index analysis (583 keys/565 hashes/21 multi-candidate entries), nor the earlier preview-folder count. Do not “fix” these into one invented current count. Task 17 derives launch coverage from current sources/catalogue and records unresolved entries explicitly.
- **Operational conclusions retained:** static access token/old Shopify version are not adequate evidence for sustained integrations; add refresh credentials and current pinned catalogue version, with CJ reauthorisation/registration. A webhook is account notification plus durable cursor processing, not a file payload. No reliance on Dropbox's small-image thumbnail API is needed for the chosen baseline; any future fast path requires a separate verified eligibility test.
- **Still unverified:** live schemas/Storage policies, current originals/aliases across shops, remote webhook registrations/scopes, Vercel plan/Fluid memory/cadence and worst-case performance. These have explicit Tasks 3, 8, 10, 13–14, 17, 22 gates; closing question 8 does not mark them complete.

Provider links in the draft spec remain the implementation reference for OAuth, raw-body HMAC, paging and post-response lifetime. Supabase changelog/storage docs, Vercel limits and Sharp constructor were consulted during planning on 2026-11-22; re-check API versions/package compatibility during implementation, without treating documentation as proof of this account's setup.

## Implementation log

- Planning only, 2026-11-22: draft written from the template/spec; supplied discovery notes reconciled. No implementation task, staging benchmark, database test or CI run has been completed by this planning pass. No app code, provider configuration or migration was changed.
