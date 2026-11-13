/**
 * item-counting · Task 4 staging gate: time the real one-call evidence loader.
 *
 * STAGING ONLY. Called by tests/staging/run-item-counting.ts
 * (`npm run staging:item-counting`) once as the owner test user and once as
 * the manager test user. Signs in with the browser (anon) key, so the real
 * RLS policies apply, then runs loadProductionEvidence (one RPC) plus the
 * counting reducer for one-day and three-month windows at each site.
 *
 * Every run records: the evidence RPC count, time to response headers, body
 * transfer time, raw (decoded) and wire bytes, JSON parse time at the SDK's
 * parse call, the loader's total, the reducer's time and the paired total.
 * The independent window count is read OUTSIDE the timed load.
 *
 * Nothing is written to the database. Credentials are never printed.
 */
import { createClient } from "@supabase/supabase-js";
import { productionRange, type ReportSite } from "../../src/lib/domain/productionPeriods";
import { prepareProductionEvidence, summarizeProduction } from "../../src/lib/domain/productionCounts";
import {
  EVIDENCE_RPC,
  loadProductionEvidence,
  productionVisibilityFor,
  ProductionReadError,
} from "../../src/lib/repository/supabase/productionEvidence";

export const STAGING_REF = "ybrzhrgfrnvtcwymjdrq";
/** Fixed cutoff shared with 03-query-evidence.sql so SQL expectations and loads see the same rows. */
export const STAGING_CUTOFF = "2026-11-12T00:00:00.000Z";
const COUNT_TYPES = ["line_verified", "cancelled", "completed", "dispatched"];

export interface MeasureCase {
  label: string;
  /** Machine label shared with 03-query-evidence.sql. */
  scope: string;
  site: ReportSite;
  first: string;
  last: string;
  targetMs: number;
}

export const MEASURE_CASES: readonly MeasureCase[] = [
  { label: "AU busy day", scope: "au-busy-day", site: "au", first: "2026-09-15", last: "2026-09-15", targetMs: 2_000 },
  { label: "AU 3 months (busy)", scope: "au-3-months", site: "au", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "UK day", scope: "uk-day", site: "uk", first: "2026-03-29", last: "2026-03-29", targetMs: 2_000 },
  { label: "UK 3 months", scope: "uk-3-months", site: "uk", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "US day", scope: "us-day", site: "us", first: "2026-03-08", last: "2026-03-08", targetMs: 2_000 },
  { label: "US 3 months", scope: "us-3-months", site: "us", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
];

/** One timed load + reduce. */
export interface RunMetrics {
  run: number;
  error: string | null;
  /** All HTTP requests during the timed load, and those to the evidence RPC. */
  requests: number;
  evidenceCalls: number;
  /** Calls to any other evidence RPC (e.g. the old v1); must be 0. */
  otherEvidenceCalls: number;
  /** Request start to response headers, and headers to full body. */
  headersMs: number | null;
  bodyMs: number | null;
  /** Decoded response bytes; wire bytes from Content-Length when the server sent it. */
  rawBytes: number;
  wireBytes: number | null;
  contentEncoding: string | null;
  /** JSON.parse time during the load (the SDK's parse of the response). */
  parseMs: number | null;
  parseCalls: number;
  /** loadProductionEvidence total, and the derived remainder (validation + snapshot assembly). */
  loadMs: number | null;
  validateMs: number | null;
  reducerMs: number | null;
  totalMs: number | null;
  rows: number;
  inWindowRows: number;
}

export interface MeasureRow {
  label: string;
  scope: string;
  site: ReportSite;
  windowStartUtc: string;
  windowEndUtc: string;
  visibility: "site" | "limited";
  /** Independent in-window count (PostgREST head count, outside the timed load). */
  serverCount: number | null;
  runs: RunMetrics[];
  /** Median / first / slowest paired total (load + reducer) over completed runs. */
  medianTotalMs: number | null;
  firstTotalMs: number | null;
  slowestTotalMs: number | null;
  targetMs: number;
  /** Case-level failure (e.g. the independent count failed). */
  error: string | null;
  /** Every run finished, made exactly one evidence call and loaded exactly the server's in-window rows. */
  complete: boolean;
  withinTarget: boolean;
}

export interface MeasureResult {
  email: string;
  role: string | null;
  sites: string[];
  asOfUtc: string;
  runs: number;
  rows: MeasureRow[];
}

export interface MeasureProgress {
  phase: "case-start" | "heartbeat" | "run-done" | "case-done";
  label: string;
  caseIndex: number;
  caseCount: number;
  /** 1-based run; 0 before the first run starts. */
  run: number;
  runs: number;
  serverCount: number | null;
  /** waiting / receiving / validating / done. */
  stage: string;
  rawBytes: number;
  /** Rows validated (known only after decoding). */
  rows: number | null;
  elapsedMs: number;
}

export interface MeasureOptions {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  runs?: number;
  asOfUtc?: string;
  onProgress?: (p: MeasureProgress) => void;
  onUpdate?: (partial: MeasureResult) => void;
  heartbeatMs?: number;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function assertStagingSupabaseUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("Staging Supabase URL is not a valid URL.");
  }
  if (!host.startsWith(`${STAGING_REF}.`)) {
    throw new Error(`Refusing to run: the Supabase URL is not the staging project (${STAGING_REF}).`);
  }
}

/**
 * Time every JSON.parse call made while `fn` runs, then restore JSON.parse.
 * The wrapper delegates exactly once per call and returns the same value.
 */
export async function withJsonParseTimer<T>(fn: () => Promise<T>): Promise<{ value: T; parseMs: number; parseCalls: number }> {
  const original = JSON.parse;
  let parseMs = 0;
  let parseCalls = 0;
  const timed = function (this: unknown, text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const t0 = performance.now();
    try {
      return original.call(JSON, text, reviver);
    } finally {
      parseMs += performance.now() - t0;
      parseCalls++;
    }
  } as typeof JSON.parse;
  JSON.parse = timed;
  try {
    const value = await fn();
    return { value, parseMs, parseCalls };
  } finally {
    JSON.parse = original;
  }
}

const round = (x: number | null) => (x === null ? null : Math.round(x));

export async function measureItemCounting(opts: MeasureOptions): Promise<MeasureResult> {
  assertStagingSupabaseUrl(opts.supabaseUrl);
  const runs = Math.max(1, opts.runs ?? 3);
  const asOfUtc = opts.asOfUtc ?? STAGING_CUTOFF;

  // Per-run instrumentation, filled by the fetch wrapper.
  let cur = blankNet();
  function blankNet() {
    return { requests: 0, evidenceCalls: 0, otherEvidenceCalls: 0, headersMs: 0, bodyMs: 0, rawBytes: 0, wireBytes: null as number | null, contentEncoding: null as string | null, stage: "waiting" };
  }
  const countingFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const evidence = path.endsWith(`/rpc/${EVIDENCE_RPC}`);
    if (!evidence && /\/rpc\/load_production_evidence/.test(path)) cur.otherEvidenceCalls++;
    const t0 = performance.now();
    const res = await fetch(input, init);
    const t1 = performance.now();
    if (evidence) cur.stage = "receiving";
    const body = await res.arrayBuffer();
    const t2 = performance.now();
    cur.requests++;
    if (evidence) {
      cur.evidenceCalls++;
      cur.headersMs += t1 - t0;
      cur.bodyMs += t2 - t1;
      cur.rawBytes += body.byteLength;
      const len = res.headers.get("content-length");
      cur.wireBytes = len !== null && Number.isFinite(Number(len)) ? Number(len) : null;
      cur.contentEncoding = res.headers.get("content-encoding");
      cur.stage = "validating";
    }
    // The body is already decoded; don't advertise the wire encoding/length on the copy.
    const headers = new Headers(res.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(body, { status: res.status, statusText: res.statusText, headers });
  };

  const client = createClient(opts.supabaseUrl, opts.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: countingFetch },
  });
  const { data: auth, error: authError } = await client.auth.signInWithPassword({
    email: opts.email,
    password: opts.password,
  });
  if (authError || !auth.user) throw new Error(`Sign-in failed for ${opts.email}: ${authError?.message ?? "no user"}`);

  try {
    const { data: profile, error: profileError } = await client
      .from("profiles").select("role").eq("user_id", auth.user.id).maybeSingle();
    if (profileError) throw new Error(`Could not read role: ${profileError.message}`);
    const { data: memberships, error: memberError } = await client
      .from("user_locations").select("location").eq("user_id", auth.user.id);
    if (memberError) throw new Error(`Could not read site memberships: ${memberError.message}`);
    const role = (profile as { role?: string } | null)?.role ?? null;
    const sites = ((memberships ?? []) as Array<{ location: string }>).map((m) => m.location).sort();
    const siteSet = new Set(sites);

    const rows: MeasureRow[] = [];
    const snapshot = (): MeasureResult => ({ email: opts.email, role, sites, asOfUtc, runs, rows: [...rows] });
    opts.onUpdate?.(snapshot());
    const heartbeatMs = Math.max(1_000, opts.heartbeatMs ?? 10_000);

    for (const [caseIndex, c] of MEASURE_CASES.entries()) {
      const range = productionRange(c.site, c.first, c.last);
      const window = { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive };
      const visibility = productionVisibilityFor(role, siteSet.has(c.site));

      // Independent completeness check, outside the timed load.
      const { count: serverCount, error: countError } = await client
        .from("production_events")
        .select("id", { count: "exact", head: true })
        .eq("location", c.site)
        .in("event_type", COUNT_TYPES)
        .gte("created_at", window.startUtc)
        .lt("created_at", window.endUtcExclusive)
        .lte("created_at", asOfUtc);

      const progress = (phase: MeasureProgress["phase"], run: number, elapsedMs: number, rowCount: number | null = null) =>
        opts.onProgress?.({
          phase, label: c.label, caseIndex: caseIndex + 1, caseCount: MEASURE_CASES.length, run, runs,
          serverCount: serverCount ?? null, stage: cur.stage, rawBytes: cur.rawBytes, rows: rowCount, elapsedMs: Math.round(elapsedMs),
        });
      cur = blankNet();
      progress("case-start", 0, 0);

      const done: RunMetrics[] = [];
      const caseError = countError ? `server count failed: ${countError.message}` : null;
      for (let i = 0; i < runs && !caseError; i++) {
        cur = blankNet();
        const t0 = performance.now();
        const beat = setInterval(() => progress("heartbeat", i + 1, performance.now() - t0), heartbeatMs);
        const m: RunMetrics = {
          run: i + 1, error: null, requests: 0, evidenceCalls: 0, otherEvidenceCalls: 0, headersMs: null, bodyMs: null, rawBytes: 0,
          wireBytes: null, contentEncoding: null, parseMs: null, parseCalls: 0, loadMs: null, validateMs: null,
          reducerMs: null, totalMs: null, rows: 0, inWindowRows: 0,
        };
        try {
          const { value: evidence, parseMs, parseCalls } = await withJsonParseTimer(() =>
            loadProductionEvidence(client, { site: c.site, range: window, asOfUtc, visibility }));
          const t1 = performance.now();
          summarizeProduction(prepareProductionEvidence(evidence), { range: window });
          const t2 = performance.now();
          const s = Date.parse(window.startUtc);
          const e = Date.parse(window.endUtcExclusive);
          Object.assign(m, {
            parseMs, parseCalls,
            loadMs: t1 - t0,
            validateMs: Math.max(0, t1 - t0 - cur.headersMs - cur.bodyMs - parseMs),
            reducerMs: t2 - t1,
            totalMs: t2 - t0,
            rows: evidence.events.length,
            inWindowRows: evidence.events.filter((ev) => {
              const ms = Date.parse(ev.created_at);
              return ms >= s && ms < e;
            }).length,
          });
          cur.stage = "done";
        } catch (err) {
          m.error = err instanceof ProductionReadError ? `${err.kind}: ${err.message}` : String(err);
        } finally {
          clearInterval(beat);
        }
        Object.assign(m, {
          requests: cur.requests, evidenceCalls: cur.evidenceCalls, otherEvidenceCalls: cur.otherEvidenceCalls, rawBytes: cur.rawBytes, wireBytes: cur.wireBytes,
          contentEncoding: cur.contentEncoding,
          headersMs: cur.evidenceCalls ? cur.headersMs : null, bodyMs: cur.evidenceCalls ? cur.bodyMs : null,
        });
        for (const k of ["parseMs", "loadMs", "validateMs", "reducerMs", "totalMs", "headersMs", "bodyMs"] as const) m[k] = round(m[k]);
        done.push(m);
        progress("run-done", i + 1, m.totalMs ?? performance.now() - t0, m.rows);
      }

      const ok = done.filter((r) => r.error === null && r.totalMs !== null);
      const totals = ok.map((r) => r.totalMs as number);
      const medianTotalMs = round(median(totals));
      const complete = caseError === null && done.length === runs && ok.length === runs
        && done.every((r) => r.evidenceCalls === 1 && r.otherEvidenceCalls === 0 && r.inWindowRows === serverCount);
      rows.push({
        label: c.label,
        scope: c.scope,
        site: c.site,
        windowStartUtc: window.startUtc,
        windowEndUtc: window.endUtcExclusive,
        visibility: visibility.kind,
        serverCount: serverCount ?? null,
        runs: done,
        medianTotalMs,
        firstTotalMs: totals.length ? totals[0] : null,
        slowestTotalMs: totals.length ? Math.max(...totals) : null,
        targetMs: c.targetMs,
        error: caseError,
        complete,
        withinTarget: complete && medianTotalMs !== null && medianTotalMs <= c.targetMs,
      });
      progress("case-done", runs, medianTotalMs ?? 0);
      opts.onUpdate?.(snapshot());
    }
    return snapshot();
  } finally {
    await client.auth.signOut();
  }
}

const mb = (bytes: number | null) => (bytes === null ? "n/a" : `${(bytes / 1_048_576).toFixed(1)} MB`);

export function measureTable(result: MeasureResult): string {
  const lines = [
    `user: ${result.email} · role: ${result.role ?? "?"} · sites: ${result.sites.join(", ") || "none"}`,
    `cutoff (as of): ${result.asOfUtc} · runs per case: ${result.runs} (median of paired load + reducer total)`,
    "",
    "| Case | Window (UTC) | Visibility | Server count | Rows | Median total ms | First | Slowest | Target ms | Result |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of result.rows) {
    const bad = r.runs.find((x) => x.error);
    const verdict = r.error
      ? `ERROR (${r.error})`
      : bad
        ? `ERROR run ${bad.run} (${bad.error})`
        : !r.complete
          ? "INCOMPLETE (see runs)"
          : r.withinTarget
            ? "within target"
            : "OVER TARGET";
    const rowsShown = r.runs.length ? r.runs[r.runs.length - 1].rows : 0;
    lines.push(
      `| ${r.label} | ${r.windowStartUtc} → ${r.windowEndUtc} | ${r.visibility} | ${r.serverCount ?? "?"} | ${rowsShown} | ${r.medianTotalMs ?? "–"} | ${r.firstTotalMs ?? "–"} | ${r.slowestTotalMs ?? "–"} | ${r.targetMs} | ${verdict} |`,
    );
  }
  lines.push(
    "",
    "Per run (headers = request to response headers; body = transfer; parse = JSON.parse; validate = load − headers − body − parse, which includes dictionary decoding and the single client sort):",
    "",
    "| Case | Run | RPCs | Requests | Rows | In-window | Raw | Wire | Encoding | Headers ms | Body ms | Parse ms | Validate ms | Load ms | Reducer ms | Total ms | Error |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const r of result.rows) {
    for (const x of r.runs) {
      lines.push(
        `| ${r.label} | ${x.run} | ${x.evidenceCalls} | ${x.requests} | ${x.rows} | ${x.inWindowRows} | ${mb(x.rawBytes)} | ${mb(x.wireBytes)} | ${x.contentEncoding ?? "n/a"} | ${x.headersMs ?? "–"} | ${x.bodyMs ?? "–"} | ${x.parseMs ?? "–"} | ${x.validateMs ?? "–"} | ${x.loadMs ?? "–"} | ${x.reducerMs ?? "–"} | ${x.totalMs ?? "–"} | ${x.error ?? ""} |`,
      );
    }
  }
  return lines.join("\n");
}
