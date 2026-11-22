# Review: scanner stations R2

Reviewed90937acf471df79cef7a81a4d0dc9bb090e723b1. All scoped R1 SQL/session/packaging/identity/StrictMode fixes are accepted except two client delivery gaps below. No broader redesign requested.

1. **P1 stale finalizer still returns false failure to UI.** client.ts:392-394 unconditionally returns blocked/uncertain:false even when outbox.ts:413 ignored a stale lease. Reproduced A sends -> lease expires -> B saves -> A receives refusal: database/job staydone, but A wall says notsaved/useclassic. Fenced markBlocked and retryLater should report whether they applied; ignored claims return superseded, including preparation refusals and wait paths. Extend the existing stale-lease test to check the returned report/controller message. Preserve LeaseLostError through store catch blocks (outbox.ts:198,232) so it remains superseded, not a storagefailure.
2. **P2 disposal during markAttempt still starts commit.** client.ts:366-373 checks active before awaiting markAttempt, then sends regardless. Recheck immediately after that await and before commit; release the claim and preserve exact payload/prioruncertainty. This attempt was never sent, so do not invent an unknown result. Add the delayed-markAttempt regression to existing tests.

## Actual staging evidence and migration freeze

0055 was independently reviewed at SHA2563e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620, then passed all160 assertions on actual staging inside a rollback transaction. It has now been persistently installed on STAGING via apply_migration success and is IMMUTABLE. Do not edit0055 or earlier migrations. R2 requires only client fixes.

Actual separate-connection races passed R1shared/classic, R2classic/shared, R3exactretry, R3boriginalrollback, R4twoscanners, R5clockin, plusR6classicline_verifiedheldopenWITHOUTdeduction provesinserttriggerlocking. All finalcredit/stock totals true. Actual PostgRESTowner/manager/kiosk allow andstaff/CS/anon denial, capturedcallermismatch, realkiosksave/exactreplay/noextraevents anddirectreceiptwrite denial passed. Syntheticfixturescleaned. Root evidence under overnight-20261122: f6-staging-rollback-schema.json, f6-concurrency.json, f6-postgrest-roles.json. Browser/hardware/finalPreview stillpending; don't claimthem.

Make these two narrow corrections, focused regressions and the normal final gate, commit and return writer slot. Update release/runbook/plan to reflectactualstaging evidence and finalcontracts. NoSQLchange, no deploy/push/F7.
