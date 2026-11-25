# Departments browser acceptance

2026-11-22, code `6b5dcd3` / reviewed base `25c4c80`. Codex used Chrome against the local Vite build at `127.0.0.1:5175`, explicitly configured with the isolated staging URL/key. This is actual browser plus actual staging API evidence, not yet the final hosted Preview smoke check.

Passed with synthetic staging accounts/data:

- Owner creates a department, assigns Staging Staff, renames it, moves the person to another department; current home changes and previous name/history remain visible.
- Archiving a populated department refuses with a clear message and its member list. After moving the person away, archive and restore work.
- Turning tracking on requires a reason, saves and closes the confirmation (no reverse-action confirmation appears). Turn off likewise saves and closes; restored OFF.
- Owner left an unsaved rename form, signed out and signed in as manager without a page reload. Manager saw zero department headings/forms. Returning to owner started with empty creation input and no old rename form. Requests loaded afresh; no old caller form survived.
- With an ON confirmation open, a separate staging client turned the switch on then off. Refresh showed only the conflict explanation and Close; neither ON nor OFF action was offered. Captured intent stayed ON.

Operator cleanup removed exactly the two F5UI departments, two synthetic assignments and eleven related audit/receipt records after checking that no event referred to them. Final state: zero departments, 240,123 events, tracking OFF/version 9. Stored test evidence outside the repo: `f5-ui-records.json`.

Minor nonblocking UI observation: a successful rename leaves its form open, including when switching to the archived list. This does not save anything by itself and server rules still govern changes; no extra redesign requested. Browser automation occasionally needed a fresh locator or keyboard/coordinate fallback during rerenders; the underlying operations succeeded.

CI passed for `25c4c80` (PR 11, run 45025621621). Final combined hosted Preview, old-app rollback smoke and physical scanner commissioning remain separately recorded. No production changes.

Previous hosted F4 Preview smoke also passed after the schema expansion: synthetic kiosk signed in, selected the Framed station at AU, scanned the existing Staging Staff badge and reached the ready-for-order screen with counts loaded. This verifies startup/badge compatibility; it does not claim a full old stock/Shopify dispatch flow. The previous Preview URL is recorded in the deployment notes.
