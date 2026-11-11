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
 * Each call is independent, so the caller MUST include .order(...) in
 * the builder to get stable ordering across pages.
 */
export async function fetchAllRows<T>(
  buildQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
  opts?: { pageSize?: number; maxPages?: number },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 1000;
  const maxPages = opts?.maxPages ?? 100; // hard safety: 100k rows
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
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}