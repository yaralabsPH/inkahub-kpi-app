/**
 * In-memory stand-in for supabase-js `from("production_events").select(...)`
 * that ENFORCES the filters the evidence reader sends: site, time bounds,
 * event types, quoted in-lists, the (created_at, id) keyset cursor, ordering
 * and a server-side row cap. Removing a filter or the pagination from the
 * reader changes results, so tests fail.
 */
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

type Pred = (r: ProductionEvidenceEvent) => boolean;

export interface FakeOptions {
  /** Max rows the "server" returns per request, regardless of limit. */
  serverCap?: number;
  /** Called before each response; may throw, mutate rows or return an error. */
  beforeResponse?: (info: { call: number; filters: string[] }) => { error?: unknown } | void;
  /** When false, ignore .order() and return rows in reverse. */
  honorOrder?: boolean;
}

export interface FakeEventsDb {
  client: { from(table: string): { select(columns: string): unknown } };
  rows: ProductionEvidenceEvent[];
  calls: Array<{ filters: string[]; columns: string; returned: number }>;
  /** Change rows (insert/edit/delete) and re-sort the fake's index. */
  mutate(fn: (rows: ProductionEvidenceEvent[]) => void): void;
}

function byKeyset(a: ProductionEvidenceEvent, b: ProductionEvidenceEvent): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const TIME_COLS = new Set(["created_at"]);

function parseQuotedList(raw: string): string[] {
  if (!raw.startsWith("(") || !raw.endsWith(")")) throw new Error(`fake: bad in-list ${raw}`);
  const body = raw.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '"') throw new Error(`fake: unquoted in-list value in ${raw}`);
    let v = "";
    i++;
    while (i < body.length && body[i] !== '"') {
      if (body[i] === "\\") i++;
      v += body[i];
      i++;
    }
    out.push(v);
    i++; // closing quote
    if (body[i] === ",") i++;
  }
  return out;
}

function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) throw new Error(`fake: expected quoted value, got ${s}`);
  return s.slice(1, -1).replace(/\\(.)/g, "$1");
}

function cmp(col: string, a: unknown, b: string): number {
  if (TIME_COLS.has(col)) return Date.parse(String(a)) - Date.parse(b);
  const x = String(a);
  return x < b ? -1 : x > b ? 1 : 0;
}

function field(r: ProductionEvidenceEvent, col: string): unknown {
  return (r as unknown as Record<string, unknown>)[col];
}

export function createFakeEventsDb(initial: ProductionEvidenceEvent[], opts: FakeOptions = {}): FakeEventsDb {
  const db: FakeEventsDb = {
    rows: [...initial].sort(byKeyset),
    calls: [],
    client: undefined as never,
    mutate(fn) {
      fn(db.rows);
      db.rows.sort(byKeyset);
    },
  };
  const cap = opts.serverCap ?? 1000;

  db.client = {
    from(table: string) {
      if (table !== "production_events") throw new Error(`fake: unexpected table ${table}`);
      return {
        select(columns: string) {
          const preds: Pred[] = [];
          let cursor: { ms: number; id: string } | null = null;
          const filters: string[] = [];
          let limit = Number.POSITIVE_INFINITY;
          const orders: string[] = [];
          const builder = {
            eq(col: string, v: string) {
              filters.push(`${col}=eq.${v}`);
              preds.push((r) => field(r, col) === v);
              return builder;
            },
            in(col: string, vals: readonly string[]) {
              filters.push(`${col}=in.${vals.join(",")}`);
              const set = new Set(vals);
              preds.push((r) => set.has(String(field(r, col))));
              return builder;
            },
            gte(col: string, v: string) {
              filters.push(`${col}=gte.${v}`);
              preds.push((r) => cmp(col, field(r, col), v) >= 0);
              return builder;
            },
            lt(col: string, v: string) {
              filters.push(`${col}=lt.${v}`);
              preds.push((r) => cmp(col, field(r, col), v) < 0);
              return builder;
            },
            lte(col: string, v: string) {
              filters.push(`${col}=lte.${v}`);
              preds.push((r) => cmp(col, field(r, col), v) <= 0);
              return builder;
            },
            filter(col: string, op: string, v: string) {
              filters.push(`${col}=${op}.${v}`);
              if (op === "in") {
                const set = new Set(parseQuotedList(v));
                preds.push((r) => set.has(String(field(r, col))));
              } else if (op === "not.is" && v === "null") {
                preds.push((r) => field(r, col) != null);
              } else {
                throw new Error(`fake: unsupported filter ${op}`);
              }
              return builder;
            },
            or(expr: string) {
              filters.push(`or=${expr}`);
              const m = /^created_at\.gt\.("(?:[^"\\]|\\.)*"),and\(created_at\.eq\.("(?:[^"\\]|\\.)*"),id\.gt\.("(?:[^"\\]|\\.)*")\)$/.exec(expr);
              if (!m) throw new Error(`fake: unsupported or() ${expr}`);
              const t = unquote(m[1]);
              const t2 = unquote(m[2]);
              const id = unquote(m[3]);
              if (t !== t2) throw new Error("fake: keyset timestamps differ");
              cursor = { ms: Date.parse(t), id };
              return builder;
            },
            order(col: string) {
              orders.push(col);
              return builder;
            },
            limit(n: number) {
              limit = n;
              return builder;
            },
            abortSignal() {
              return builder;
            },
            then<R1, R2>(onOk: (v: { data: unknown[] | null; error: unknown }) => R1, onErr?: (e: unknown) => R2) {
              return Promise.resolve()
                .then(() => {
                  const call = db.calls.length;
                  const hook = opts.beforeResponse?.({ call, filters });
                  if (hook && hook.error) {
                    db.calls.push({ filters, columns, returned: 0 });
                    return { data: null, error: hook.error };
                  }
                  const max = Math.min(limit, cap);
                  const rows = db.rows; // kept sorted by (created_at, id)
                  const ordered = opts.honorOrder !== false && orders[0] === "created_at" && orders[1] === "id";
                  let start = 0;
                  if (cursor) {
                    // first row strictly after the cursor
                    let lo = 0;
                    let hi = rows.length;
                    while (lo < hi) {
                      const mid = (lo + hi) >> 1;
                      const r = rows[mid];
                      const d = Date.parse(r.created_at) - cursor.ms;
                      if (d < 0 || (d === 0 && r.id <= cursor.id)) lo = mid + 1;
                      else hi = mid;
                    }
                    start = lo;
                  }
                  const page: ProductionEvidenceEvent[] = [];
                  if (ordered) {
                    for (let i = start; i < rows.length && page.length < max; i++) {
                      if (preds.every((p) => p(rows[i]))) page.push({ ...rows[i] });
                    }
                  } else {
                    for (let i = rows.length - 1; i >= start && page.length < max; i--) {
                      if (preds.every((p) => p(rows[i]))) page.push({ ...rows[i] });
                    }
                  }
                  db.calls.push({ filters, columns, returned: page.length });
                  return { data: page, error: null };
                })
                .then(onOk, onErr);
            },
          };
          return builder;
        },
      };
    },
  };
  return db;
}
