/**
 * Order lookup read for Reports (every saved event for one order at one site,
 * up to a fixed cutoff). Unlike a single unpaged select, this reads with an
 * exact count and pages by the rows actually returned, so a server row cap
 * cannot silently drop earlier verifications. `complete` is false when the
 * read could not be confirmed complete; callers must then not present derived
 * counts as authoritative (the timeline itself can still be shown).
 */
export interface OrderLookupRequest {
  location: string;
  orderNumber: string;
  /** Fixed cutoff for this search. */
  asOfUtc: string;
  pageSize?: number;
}

export interface OrderLookupResult<T> {
  events: T[];
  complete: boolean;
}

interface PageResult {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
}

/** Structural view of the supabase-js query builder used here. */
interface LookupQuery {
  select(cols: string, opts: { count: "exact" }): LookupQuery;
  eq(col: string, v: string): LookupQuery;
  lte(col: string, v: string): LookupQuery;
  order(col: string, opts: { ascending: boolean }): LookupQuery;
  range(from: number, to: number): PromiseLike<PageResult>;
}

export interface OrderLookupClient {
  from(table: string): unknown;
}

export async function loadOrderLookup<T>(client: OrderLookupClient, req: OrderLookupRequest): Promise<OrderLookupResult<T>> {
  const size = req.pageSize ?? 1000;
  const out: T[] = [];
  let total: number | null = null;
  for (let from = 0; ; ) {
    const q = (client.from("production_events") as LookupQuery)
      .select("*", { count: "exact" })
      .eq("location", req.location)
      .eq("order_number", req.orderNumber)
      .lte("created_at", req.asOfUtc)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    const { data, error, count } = await q.range(from, from + size - 1);
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) return { events: out, complete: false };
    if (typeof count !== "number" || (total !== null && count !== total)) {
      out.push(...(data as T[]));
      return { events: out, complete: false };
    }
    total = count;
    out.push(...(data as T[]));
    if (out.length === total) return { events: out, complete: true };
    if (out.length > total || data.length === 0) return { events: out, complete: false };
    from += data.length;
  }
}
