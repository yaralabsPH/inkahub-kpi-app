# Review: scanner stations R2

Reviewed90937acf471df79cef7a81a4d0dc9bb090e723b1. All scoped R1 SQL/session/packaging/identity/StrictMode fixes are accepted except two client delivery gaps below. No broader redesign requested.

1. **P1 stale finalizer still returns false failure to UI.** client.ts:392-394 unconditionally returns blocked/uncertain:false even when outbox.ts:413 ignored a stale lease. Reproduced A sends -> lease expires -> B saves -> A receives refusal: database/job staydone, but A wall says notsaved/useclassic. Fenced markBlocked and retryLater should report whether they applied; ignored claims return superseded, including preparation refusals and wait paths. Extend the existing stale-lease test to check the returned report/controller message. Preserve LeaseLostError through store catch blocks (outbox.ts:198,232) so it remains superseded, not a storagefailure.
2. **P2 disposal during markAttempt still starts commit.** client.ts:366-373 checks active before awaiting markAttempt, then sends regardless. Recheck immediately after that await and before commit; release the claim and preserve exact payload/prioruncertainty. This attempt was never sent, so do not invent an unknown result. Add the delayed-markAttempt regression to existing tests.

## Actual staging evidence and migration freeze

0055 was independently reviewed at SHA2563e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620, then passed all160 assertions on actual staging inside a rollback transaction. It has now been persistently installed on STAGING via apply_migration success and is IMMUTABLE. Do not edit0055 or earlier migrations. R2 requires only client fixes.

Actual separate-connection races passed R1shared/classic, R2classic/shared, R3exactretry, R3boriginalrollback, R4twoscanners, R5clockin, plusR6classicline_verifiedheldopenWITHOUTdeduction provesinserttriggerlocking. All finalcredit/stock totals true. Actual PostgRESTowner/manager/kiosk allow andstaff/CS/anon denial, capturedcallermismatch, realkiosksave/exactreplay/noextraevents anddirectreceiptwrite denial passed. Syntheticfixturescleaned. Root evidence under overnight-20261122: f6-staging-rollback-schema.json, f6-concurrency.json, f6-postgrest-roles.json. Browser/hardware/finalPreview stillpending; don't claimthem.

Make these two narrow corrections, focused regressions and the normal final gate, commit and return writer slot. Update release/runbook/plan to reflectactualstaging evidence and finalcontracts. NoSQLchange, no deploy/push/F7.

## Coder response

Both fixed in `2ac85bd`, client only (no SQL change; 0055 untouched).

1. `markBlocked` and `retryLater` now return `false` when the lease is stale; every caller in `processNext` (preparation refusal, commit refusal, commit network error, other waits) then returns `superseded` instead of a blocked/waiting report, and the controller shows nothing for it. `LeaseLostError` is re-thrown by both store wrappers (Dexie and memory) so it stays `superseded`. Regressions: the existing stale-lease test now asserts A's report is `superseded`; new cases for a stale late network error and a stale late preparation refusal; a stale `markAttempt`/`setPrepared` rejects with `LeaseLostError`; a two-controller test shows the stale tab's wall never says NOT SAVED while the other tab saved.
2. `processNext` re-checks `active()` right after `markAttempt` and before `commit`. If the station stopped, new `ScannerOutbox.releaseUnsent` restores `attempts`, `uncertain` and `priorUnknown` to their pre-attempt values, keeps the prepared payload and clears the lease. Regression: a delayed `markAttempt` during which the station closes -> `superseded`, no commit sent, job `prepared` with attempts 0 and not uncertain, then the same payload saves when reopened.

Checks: tsc, typecheck:digest, typecheck:api, 957/957 tests (40 files), build.

