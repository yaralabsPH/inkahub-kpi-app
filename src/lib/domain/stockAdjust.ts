/**
 * On-hand after a Repository.adjustOnHand-style change. `delta` follows the
 * adjustOnHand convention: positive REMOVES stock, negative ADDS stock.
 *
 * Exact in both directions, no floor at zero. This matches SQL
 * adjust_on_hand / cascade_bom_step from migration 0063 and the dispatch
 * deductions, which have always allowed negative on-hand. With a floor, an
 * addition to a negative SKU snapped to 0 and its undo could not restore it.
 */
export function onHandAfterAdjust(before: number, delta: number): number {
  return before - delta;
}
