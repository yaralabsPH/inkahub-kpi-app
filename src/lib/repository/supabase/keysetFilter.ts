/**
 * Keyset continuation for a DESCENDING (created_at, id) PostgREST read: the
 * next page holds the rows strictly older than the last shown row,
 *
 *   created_at < t  OR  (created_at = t AND id < i)
 *
 * so rows inserted or deleted earlier in the window can never shift a page
 * boundary (no duplicate, no skip), unlike an offset. Both values are
 * double-quoted with `"` and `\` escaped, so reserved PostgREST characters
 * (commas, parentheses, dots) in an id cannot change the filter.
 */
export interface KeysetCursor { createdAt: string; id: string }

/** A PostgREST logic-tree value: double-quoted, with `\` and `"` escaped. */
export function quotePostgrestValue(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The `.or(...)` condition for the page after `cursor` in descending (created_at, id) order. */
export function olderThanFilter(cursor: KeysetCursor): string {
  if (!cursor.createdAt || !cursor.id) throw new RangeError("A keyset cursor needs both its created_at and its id");
  const t = quotePostgrestValue(cursor.createdAt);
  return `created_at.lt.${t},and(created_at.eq.${t},id.lt.${quotePostgrestValue(cursor.id)})`;
}
