/**
 * Page through a Supabase query that may exceed the 1000-row hosted
 * PostgREST cap. The caller supplies a builder fn that takes (from, to)
 * and returns a PromiseLike of { data, error } - the standard supabase-js
 * thenable. We loop, requesting 1000-row pages, until either a short
 * page comes back (signalling the end) or we hit a hard safety ceiling.
 *
 * Usage:
 *   const events = await fetchAllRows<RawEvent>((from, to) =>
 *     supabase
 *       .from("production_events")
 *       .select("*")
 *       .eq("location", location)
 *       .gte("created_at", fromIso)
 *       .lte("created_at", toIso)
 *       .order("created_at", { ascending: true })
 *       .range(from, to),
 *   );
 *
 * Each call is independent, so the caller MUST include a TOTAL order
 * (e.g. .order("created_at").order("id")) in the builder for stable pages.
 *
 * The result is complete or an error: a page error rejects, and reaching
 * the safety cap with a full final page throws PageThroughIncompleteError
 * (more rows may exist), never a silently truncated array.
 */
export class PageThroughIncompleteError extends Error {
  constructor(readonly maxPages: number, readonly pageSize: number) {
    super(`Read stopped at the safety cap of ${maxPages} pages (${maxPages * pageSize} rows); the result would be incomplete`);
    this.name = "PageThroughIncompleteError";
  }
}

export async function fetchAllRows<T>(
  buildQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts?: { pageSize?: number; maxPages?: number },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const maxPages = opts?.maxPages ?? 100; // hard safety: 100k rows
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new RangeError("maxPages must be a positive integer");
  const all: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery(from, to);
    if (error) {
      // Mimic supabase-js error surface - throw with the message if any.
      const msg =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      throw new Error(msg);
    }
    if (!data || data.length === 0) return all;
    all.push(...data);
    if (data.length < pageSize) return all;
  }
  // Every page was full up to the cap: more rows may exist, so the result is not complete.
  throw new PageThroughIncompleteError(maxPages, pageSize);
}