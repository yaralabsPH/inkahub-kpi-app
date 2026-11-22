# Scanner stations: final review and staging acceptance

Implementation9e9d1c0 (code2ac85bd) is accepted for the combined staging Preview. Independent reviewer cleared the two R2 delivery races and LeaseLostError handling; other R1 findings were cleared at90937ac/af2ab96. Final typecheck, digest/API typechecks,957tests/40files andbuild passed. No newdependency/testframework.

0055 installed on stagingybrzhrgfrnvtcwymjdrq only, SHA2563e5981954ad37c992b78d2765d4329162efb1c69b606afe11f9dd95b177b2620. Immutable from this point. All160 realPostgres assertions passed rollback-contained before persistentapply. Real separateconnections verifiedR1shared/classic,R2classic/shared,R3exactretry,R3boriginalrollback,R4twoscanners,R5oneclockin, andR6classicverificationalone(withoutdeductionRPC) blocks newcommit. Actualpg_stat_activity lock waits observed; allstock/credit totals correct. ActualPostgREST owner/manager/kioskallow,staff/CS/anondenial,capturedcallermismatch,kiosksave/replayanddirectreceiptwritedenial passed.

Alltestfixturesremoved. Finalexistingproducts/ledger/production_events fullrowhashes matchpreF6baseline (240123events), scanner_receipts0,receivers0,departments0,F5trackingOFF,F1captureOFF. Evidence: externalovernightfolder f6-staging-rollback-schema.json,f6-concurrency.json,f6-postgrest-roles.json,f6-clean-verification.json.

OldF4hostedPreview basiccompatibility checked after0055: synthetickioskAUFramed badgeAB4B5880 signedStagingStaff in andshowedreadyfornextorderwithcounts. No stockflowclaim. Browserinput needednativefocus becauseChromeSavepasswordbubble/backgroundtabinterfered; thiswasnotanappdefect. FinalcombinedF6/F7browserflowsandIndexedDBrecovery remainpending. Realcordlesshardware,kioskOSstartup,physicalaudio/wakelockandactualboxrulescommissioning arenotclaimed.

No productionSQL,productiondeploy,mainmergeorproductionenvironmentchange occurred.
