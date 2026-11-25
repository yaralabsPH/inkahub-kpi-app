# Release: exact stock adjustments (0063)

## What changes

`adjust_on_hand` and `cascade_bom_step` (0002) floored every result at zero. Dispatch deductions
(0025/0026/0031, about 98% of live stock movements) have no floor, so live holds negative on-hand
(2026-11-25: AU 13, default 18, US 5 SKUs below zero). Any addition to a negative SKU snapped to 0.
For example, a 1-unit return restock on A0-Black (default) at −12 recorded +12 and left 0 instead
of −11, and no undo could restore −12.

From 0063 every stock change is exact in both directions, like dispatch:

| Before | After |
|---|---|
| −12, restock +1 → **0** (ledger +12) | −12, restock +1 → **−11** (ledger +1) |
| 1, remove 3 → **0** (ledger −1) | 1, remove 3 → **−2** (ledger −3) |
| −12, remove 1 → **0** (stock went UP) | −12, remove 1 → **−13** |

This covers shipment deliveries and reversals, manual adjustments, stocktakes, paper usage, CS
cases, returns, weekly sales entries and their BOM cascade. Dexie (local mode) uses the same rule
through `onHandAfterAdjust` (`src/lib/domain/stockAdjust.ts`). The returns modal preview no longer
claims stock stops at zero.

Only the two `v_after` lines change. The signature, permission check, row lock, ledger row
(actual change), BOM rule, owner and grants are unchanged. No table, column or grant change.
The old and new app both work on it.

## Evidence

- Unit tests: 431 passed (`npx tsc -b` clean, `npm run build` ok), including exact add/remove/undo,
  the live −12 case through the real `SupabaseRepo`, and the returns rules.
- Real Postgres, staging-2 (`supabase/staging/exact-stock-adjust/verify.sql`, rolled back, no rows
  left). It ran 8 checks as the staging owner through the real location check:
  - exact addition onto −12;
  - undo;
  - removal below zero;
  - zero delta;
  - BOM cascade and its reversal;
  - missing product;
  - other location denied;
  - shipment credit onto negative stock.

  The checks fail on the old function ("expected −11, got 0") and pass on 0063. 0063 applied twice:
  fine. The rollback script was applied, verified (old floor back), and 0063 was re-applied
  and verified.
- Live functions were checked before writing 0063: identical to `0002_rpc.sql` (and to staging-2)
  apart from line endings.

## Release steps (in this order)

1. In the Supabase SQL editor (live), run `supabase/migrations/0063_exact_stock_adjust.sql`,
   preceded by `set lock_timeout = '10s'; set statement_timeout = '600s';`. It replaces two
   functions in under a second.
2. Check: `select count(*) from pg_proc where proname in ('adjust_on_hand','cascade_bom_step') and pg_get_functiondef(oid) like '%GREATEST%';`
   should return **0**.
3. Run `docs/releases/exact-stock-adjust-fix-a0-black.sql` once. It moves A0-Black (default) from
   0 to −11 and adds a matching ledger row. It refuses to run unless live is exactly in the
   2026-11-25 state. Rehearsed on staging-2, where a second run was refused.
4. Deploy `main` (frontend: returns preview text and Dexie parity). Order relative to steps 1 to 3
   does not matter. The old frontend on the new SQL only shows an outdated preview.
5. Optional: delete test return #123 in the app. With 0063 that takes A0-Black (default) back
   to −12.

The release-stack migrations 0034 to 0062 do not touch these functions. 0063 is independent of
them and can go before or after.

## Rollback

Run `docs/releases/exact-stock-adjust-rollback.sql` (the 0002 bodies verbatim). It restores the
zero floor for future changes and leaves recorded stock as it is. Rehearsed on staging-2.

## Not recoverable

Past additions that were floored before 0063 (shipments, manual adjustments onto negative SKUs)
cannot be reconstructed, because the requested amount was never stored. Negative SKUs are
driven by dispatch and need a stocktake to be truly correct.
