# F11 review R1 — 2026-11-23

Accepted for isolated staging validation at0def36c; hosted acceptance remains pending.

Independent review reproduced two material Task1 defects, both corrected at437abb0 and independently accepted: F10 source keys now include the complete scoped Make identity via bounded SHA256 keys while retaining the real run id; mapping conflicts/ambiguity discovered after attachment append exact retractions, preserve originals, and keep references terminal so retries cannot restore false confirmation. SQL regressions cover both arrival orders and repeated retries.

Root reviewed the docs-only0def36c correction for Task2. Reporter placement must be a terminal side branch or after every required write and cross-part handoff. Ignore/Skip drops the failed route's bundle; it does not protect later main-chain modules. Failed-endpoint acceptance must prove downstream completion. Current UI/read wiring/privacy had no other material findings; run display remains the actual occurrence id after the scoped-key change.

Evidence: full gate at8be15be passed138files/3290tests, frontend/API/digest typechecks and build. After437abb0, seven affected SQL/API/domain/UI suites passed142tests and frontend/API typechecks were clean. No tests were repeated for docs-only0def36c. Reviewers ran isolated PGlite proofs for the original defects, not another full suite.

No0059/0060 migration applied anywhere, no new Preview deployed, and no Make milestone report has reached the app. Staging database recovery is still required. Six AU clones and separate resource utility exist, with isolated staging Sheets/folders; synthetic fixture setup is separate ongoing work. This review does not assert external commissioning. All three live Make systems and production remain unchanged. No late/fast features were added.

STATUS: COMPLETE
