/**
 * In-memory stand-in for supabase-js `rpc("load_production_evidence_v2", args)`.
 *
 * It ENFORCES the contract of migration 0035 (encoding v2): exact function
 * name and four named arguments, a copy of the visible rows taken at "statement start",
 * fake RLS applied to every family before joins, and the four evidence
 * families derived here, independently of the loader's code. Rows and
 * dictionaries come back deliberately unsorted (reversed), as the SQL makes
 * no ordering promise. Table reads, other RPCs (including v1), paging calls
 * and second evidence calls fail.
 *
 * Tests can also replace the raw response (malformed envelopes), return an
 * RPC error, throw a transport error, hold the response pending (abort and
 * deadline tests) or change rows after the snapshot was taken.
 */
import type { ProductionEvidenceEvent } from "../../src/lib/domain/productionCounts";

export const EVIDENCE_RPC_NAME = "load_production_evidence_v2";
const ARG_KEYS = ["p_as_of_utc", "p_end_utc_exclusive", "p_site", "p_start_utc"];
const COUNT_TYPES = ["line_verified", "completed", "dispatched", "cancelled"];

export interface FakeRpcArgs {
  p_site: string;
  p_start_utc: string;
  p_end_utc_exclusive: string;
  p_as_of_utc: string;
}

export interface FakeOptions {
  /** Fake RLS: rows this caller may see (default: all). Applied to every family before joins. */
  visible?: (r: ProductionEvidenceEvent) => boolean;
  /** Replace or edit the envelope the "server" returns (malformed-payload tests). */
  rawResponse?: (envelope: Record<string, unknown> | null, args: FakeRpcArgs) => unknown;
  /** Return { error } instead of data, or throw (transport failure). */
  beforeResponse?: (info: { call: number; args: FakeRpcArgs }) => { error?: unknown } | void;
  /** Called after the statement snapshot is taken, before the response is delivered. */
  afterSnapshot?: (db: FakeEventsDb) => void;
  /** Keep the response pending until this resolves. */
  hold?: Promise<void>;
  /** Echo request timestamps in this representation (default: as sent). */
  echo?: (iso: string) => string;
  /** Allow more than one evidence call (default: a second call fails). */
  allowRepeatCalls?: boolean;
  /** Row/dictionary order on the wire (default "reverse": deliberately unsorted). */
  order?: "reverse" | "asis";
}

export interface FakeEventsDb {
  client: {
    rpc(name: string, args: Record<string, unknown>): unknown;
    from(table: string): never;
  };
  rows: ProductionEvidenceEvent[];
  calls: Array<{ name: string; args: FakeRpcArgs; returned: number; aborted: boolean }>;
  /** Change rows (insert/edit/delete). */
  mutate(fn: (rows: ProductionEvidenceEvent[]) => void): void;
}

/** Independent exact-instant parse for the fake: [ms, micro-remainder]. */
function at(iso: string): [number, number] {
  const m = /^(.*?)(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/.exec(iso);
  if (!m) throw new Error(`fake: unreadable timestamp ${iso}`);
  const frac = (m[2] ?? "").padEnd(6, "0");
  const ms = Date.parse(`${m[1]}.${frac.slice(0, 3)}${m[3]}`);
  if (!Number.isFinite(ms)) throw new Error(`fake: unreadable timestamp ${iso}`);
  return [ms, Number(frac.slice(3))];
}
function cmp(a: string, b: string): number {
  const [am, au] = at(a);
  const [bm, bu] = at(b);
  return am - bm || au - bu;
}

/**
 * Encoding v2 (independent of the loader): dictionaries of distinct non-null
 * staff ids / SKUs used by the evidence, rows of ten slots holding indexes.
 * `order: "reverse"` (default) reverses rows and dictionaries.
 */
export function encodeV2(evidence: readonly ProductionEvidenceEvent[], order: "reverse" | "asis" = "reverse") {
  const distinct = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
  let staffIds = distinct(evidence.map((r) => r.staff_id));
  let skus = distinct(evidence.map((r) => r.line_sku));
  let rows = [...evidence];
  if (order === "reverse") {
    staffIds = staffIds.reverse();
    skus = skus.reverse();
    rows = rows.reverse();
  }
  const staffAt = new Map(staffIds.map((s, i) => [s, i]));
  const skuAt = new Map(skus.map((s, i) => [s, i]));
  return {
    staffIds,
    skus,
    rows: rows.map((r) => [
      r.id, r.staff_id === null ? null : staffAt.get(r.staff_id)!, r.department, r.order_number,
      r.line_sku === null ? null : skuAt.get(r.line_sku)!, r.line_quantity ?? null, r.event_type, r.created_at,
      r.parent_event_id, r.cs_case_id,
    ]),
  };
}

/** The four families of 0034, computed from a row snapshot. */
export function fakeEvidence(rows: readonly ProductionEvidenceEvent[], args: FakeRpcArgs, visible: (r: ProductionEvidenceEvent) => boolean) {
  const seen = rows.filter((r) => r.location === args.p_site && visible(r) && cmp(r.created_at, args.p_as_of_utc) <= 0);
  const win = seen.filter((r) => COUNT_TYPES.includes(r.event_type)
    && cmp(r.created_at, args.p_start_utc) >= 0 && cmp(r.created_at, args.p_end_utc_exclusive) < 0);
  const orders = new Set(win.filter((r) => (r.event_type === "completed" || r.event_type === "dispatched")
    && r.order_number !== null && r.order_number.trim() !== "").map((r) => r.order_number));
  const parentIds = new Set(win.filter((r) => r.event_type === "cancelled" && r.parent_event_id).map((r) => r.parent_event_id));
  const evidenceIds = new Set(win.filter((r) => r.event_type !== "cancelled").map((r) => r.id));
  const before = seen.filter((r) => cmp(r.created_at, args.p_start_utc) < 0);
  const qualification = before.filter((r) => r.event_type === "line_verified" && orders.has(r.order_number));
  const parents = before.filter((r) => parentIds.has(r.id));
  const later = seen.filter((r) => r.event_type === "cancelled" && r.parent_event_id !== null
    && cmp(r.created_at, args.p_end_utc_exclusive) >= 0 && evidenceIds.has(r.parent_event_id));
  const all = new Map<string, ProductionEvidenceEvent>();
  for (const r of [...win, ...qualification, ...parents, ...later]) all.set(`${r.location}\u0000${r.id}`, r);
  return [...all.values()].sort((a, b) => cmp(a.created_at, b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function checkArgs(name: string, args: Record<string, unknown>): FakeRpcArgs {
  if (name !== EVIDENCE_RPC_NAME) throw new Error(`fake: unexpected RPC ${name}`);
  const keys = Object.keys(args).sort();
  if (keys.join(",") !== ARG_KEYS.join(",")) throw new Error(`fake: unexpected RPC arguments ${keys.join(",")}`);
  for (const k of ARG_KEYS) if (typeof args[k] !== "string") throw new Error(`fake: argument ${k} is not text`);
  return args as unknown as FakeRpcArgs;
}

export function createFakeEventsDb(initial: ProductionEvidenceEvent[], opts: FakeOptions = {}): FakeEventsDb {
  const db: FakeEventsDb = {
    rows: [...initial],
    calls: [],
    client: undefined as never,
    mutate(fn) {
      fn(db.rows);
    },
  };
  const visible = opts.visible ?? (() => true);
  const echo = opts.echo ?? ((s: string) => s);

  db.client = {
    from(table: string): never {
      throw new Error(`fake: unexpected table read ${table}`);
    },
    rpc(name: string, rawArgs: Record<string, unknown>) {
      const args = checkArgs(name, rawArgs);
      if (db.calls.length > 0 && !opts.allowRepeatCalls) throw new Error("fake: second evidence RPC in one load");
      const entry = { name, args, returned: 0, aborted: false };
      db.calls.push(entry);
      let signal: AbortSignal | undefined;
      const fail = (what: string) => () => {
        throw new Error(`fake: unexpected ${what} on an evidence RPC`);
      };
      const call = {
        abortSignal(s: AbortSignal) {
          signal = s;
          s.addEventListener("abort", () => (entry.aborted = true), { once: true });
          return call;
        },
        range: fail(".range()"),
        limit: fail(".limit()"),
        order: fail(".order()"),
        then<R1, R2>(onOk: (v: { data: unknown; error: unknown }) => R1, onErr?: (e: unknown) => R2) {
          // Statement start: copy the visible rows now.
          const snapshot = db.rows.map((r) => ({ ...r }));
          return Promise.resolve()
            .then(async () => {
              opts.afterSnapshot?.(db);
              if (opts.hold) await opts.hold;
              if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
              const hook = opts.beforeResponse?.({ call: db.calls.length - 1, args });
              if (hook && hook.error) return { data: null, error: hook.error };
              const evidence = fakeEvidence(snapshot, args, visible);
              entry.returned = evidence.length;
              const encoded = encodeV2(evidence, opts.order);
              const envelope: Record<string, unknown> = {
                version: 2,
                site: args.p_site,
                startUtc: echo(args.p_start_utc),
                endUtcExclusive: echo(args.p_end_utc_exclusive),
                asOfUtc: echo(args.p_as_of_utc),
                complete: true,
                rowCount: encoded.rows.length,
                staffIds: encoded.staffIds,
                skus: encoded.skus,
                rows: encoded.rows,
              };
              return { data: opts.rawResponse ? opts.rawResponse(envelope, args) : envelope, error: null };
            })
            .then(onOk, onErr);
        },
      };
      return call;
    },
  };
  return db;
}
