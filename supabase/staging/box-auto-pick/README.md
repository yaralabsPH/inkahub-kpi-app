# F4 box-auto-pick — staging verification

**Staging only. Never run any of this against production.**

Who runs it: CJ, or Astra by delegation (see `docs/RELEASING.md`). Agents do
not apply the migration; CJ does.

## 1. Before you start

1. Apply `supabase/migrations/0047_packaging_auto_pick.sql` to **staging**.
   Coordinate with F3/F5 so only one feature's migration is being tested on
   shared staging at a time. Renumber the file first if `0047` is taken.
2. Staging needs at least one owner or manager with access to a site. A
   kiosk user and a staff user at the same site are used when present (the
   script says which checks it skipped when they are missing).

## 2. Single-session checks

Run `01-verify.sql` in the staging SQL editor (or `psql`). It:

- runs in one transaction and ends with `ROLLBACK`: nothing is kept;
- uses made-up products (`f4t-…`), made-up order numbers (`F4T-…`) and a
  made-up rule set;
- impersonates existing staging users only by setting the request claims for
  that transaction.

**Pass:** the last notice is
`F4 verify: ALL CHECKS PASSED (rolling back, nothing kept)`.
**Fail:** an exception `F4 verify FAILED [<check name>] …` names the check.

It also reports which stock rule staging has: "allows negative on-hand (pick
marked short)" or "forbids negative on-hand (pick left unposted)". Both are
handled; note which one production has (spec risk R4).

What it covers: grants and RLS flags; rule roles, drafts, activation gate,
immutability; apply once per shipment, replay, second device, separate picks
per packing point and per CS case; refusals (anonymous, other site, wrong
role, missing or wrong event, product outside the catalogue, bad
quantities); override deltas, audit row, stale revision, replay; shortage
and retry; adopting a box the old scan path already deducted; the ledger
unique index.

## 3. Two-session check (real concurrency)

A single transaction cannot prove two devices racing. Do this once, with two
SQL sessions (A and B) on staging. Replace `<site>` and `<owner-uuid>`; use a
real packaging product id at that site for `<product>` and note its on-hand.

Setup, in session A, committed:

```sql
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', true);
SELECT packaging_save_rule_set('<site>', NULL,
  '{"schema_version":1,"catalogue":[{"key":"T","product_id":"<product>","label":"Race test"}],"rules":[],
    "examples":[{"id":"e","packing_point":"dispatch","contents":[{"kind":"framed","size":"A1","pieces":1}],"expect":"unresolved"}]}',
  'F4 race test');  -- note the returned id as <rs>
SELECT packaging_activate_rule_set('<site>', '<rs>');
INSERT INTO production_events (location, id, staff_id, department, order_number, event_type)
VALUES ('<site>', 'f4t-race-ev', '<owner-uuid>', 'dispatch', 'F4T-RACE-1', 'dispatched');
COMMIT;
```

Race:

```sql
-- Session A
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', true);
SELECT packaging_apply('<site>', 'f4t-race-req-A', 'f4t-race-ev', '<rs>', true, '{"<product>":1}', '{"<product>":1}', NULL);
-- do NOT commit yet

-- Session B (it must wait here until A commits)
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', true);
SELECT packaging_apply('<site>', 'f4t-race-req-B', 'f4t-race-ev', '<rs>', true, '{"<product>":1}', '{"<product>":1}', NULL);

-- Session A
COMMIT;
-- Session B now returns; then
COMMIT;
```

**Pass:** A returns `"status":"applied"`, B blocks until A commits and then
returns `"status":"already_applied"`; the product's on-hand dropped by
exactly 1; there is one `packaging_picks` row and one `pkg:` ledger row for
`F4T-RACE-1`.

Clean up (staging only):

```sql
-- return the box, then remove the synthetic rows
SELECT set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', false);
SELECT packaging_override('<site>', 'f4t-race-clean', '<pick id>', 1, '{}', 'race test clean-up', NULL);
```

The pick, its audit rows, the two ledger rows (net zero), the test event and
the test rule set stay on staging as harmless synthetic records. If the test
rule set should not stay active, activate the previous one again from
Settings, or leave the site in `scan` mode.

## 4. Old app on the new schema

After applying the migration and before deploying the new preview, open the
**previous** preview build and complete one order with a box scan. It must
behave exactly as before (same deduction, `prod:order_…` ledger key).

## 5. Synthetic rules for testing the preview

Until the rule editor is built (plan Task 12), a rule set with rules has to
be saved with SQL. On **staging**, as an owner or manager of the site, with
two made-up packaging products created first (replace the ids):

```sql
SELECT set_config('request.jwt.claims', '{"sub":"<owner-uuid>","role":"authenticated"}', false);
SELECT packaging_save_rule_set('<site>', NULL, '{
  "schema_version": 1,
  "catalogue": [
    {"key": "TEST-S", "product_id": "<small box product id>", "label": "Test small box", "legacy_barcode": "+90="},
    {"key": "TEST-L", "product_id": "<large box product id>", "label": "Test large box", "legacy_barcode": "+91="}
  ],
  "rules": [
    {"id": "t1", "label": "TEST ONLY: one framed piece", "packing_point": "dispatch", "kinds": ["framed"], "max_pieces": 1,
     "output": {"mode": "fixed", "packages": [{"key": "TEST-S", "qty": 1}]}},
    {"id": "t2", "label": "TEST ONLY: two framed pieces", "packing_point": "dispatch", "kinds": ["framed"], "min_pieces": 2, "max_pieces": 2,
     "output": {"mode": "fixed", "packages": [{"key": "TEST-L", "qty": 1}]}}
  ],
  "examples": [
    {"id": "x1", "packing_point": "dispatch", "contents": [{"kind": "framed", "size": "A1", "pieces": 1}], "expect": [{"key": "TEST-S", "qty": 1}]},
    {"id": "x2", "packing_point": "dispatch", "contents": [{"kind": "framed", "size": "A1", "pieces": 3}], "expect": "unresolved"}
  ]
}', 'TEST ONLY - synthetic rules, not Inka box rules');
```

These rules are deliberately meaningless (one piece = small, two = large,
anything else = flagged). They exist to exercise the screens, not to
describe how Inka packs. Open the draft in Settings, activate it there, and
switch the site to automatic. Never copy them to production.
