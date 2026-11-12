/**
 * item-counting · Task 4 staging gate: time the real evidence loader.
 *
 * STAGING ONLY. Called by tests/staging/run-item-counting.ts
 * (`npm run staging:item-counting`) once as the owner test user and once as
 * the manager test user. Signs in with the browser (anon) key, so the real
 * RLS policies apply, then runs loadProductionEvidence plus the counting
 * reducer for one-day and three-month windows at each site.
 *
 * Nothing is written to the database. Credentials are never printed.
 */
import { createClient } from "@supabase/supabase-js";
import { productionRange, type ReportSite } from "../../src/lib/domain/productionPeriods";
import { prepareProductionEvidence, summarizeProduction } from "../../src/lib/domain/productionCounts";
import {
  loadProductionEvidence,
  productionVisibilityFor,
  ProductionReadError,
} from "../../src/lib/repository/supabase/productionEvidence";

export const STAGING_REF = "ybrzhrgfrnvtcwymjdrq";
const COUNT_TYPES = ["line_verified", "cancelled", "completed", "dispatched"];

export interface MeasureCase {
  label: string;
  site: ReportSite;
  first: string;
  last: string;
  targetMs: number;
}

export const MEASURE_CASES: readonly MeasureCase[] = [
  { label: "AU busy day", site: "au", first: "2026-09-15", last: "2026-09-15", targetMs: 2_000 },
  { label: "AU 3 months (busy)", site: "au", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "UK day", site: "uk", first: "2026-03-29", last: "2026-03-29", targetMs: 2_000 },
  { label: "UK 3 months", site: "uk", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "US day", site: "us", first: "2026-03-08", last: "2026-03-08", targetMs: 2_000 },
  { label: "US 3 months", site: "us", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
];

export interface MeasureRow {
  label: string;
  site: ReportSite;
  windowStartUtc: string;
  windowEndUtc: string;
  visibility: "site" | "limited";
  serverCount: number | null;
  loadedRows: number;
  inWindowRows: number;
  requests: number;
  payloadBytes: number;
  loadMs: number | null;
  countMs: number | null;
  targetMs: number;
  /** Load or count threw; no timing evidence. */
  error: string | null;
  /** In-window rows equal the server's authorized count. */
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

export interface MeasureOptions {
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
  runs?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
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

export async function measureItemCounting(opts: MeasureOptions): Promise<MeasureResult> {
  assertStagingSupabaseUrl(opts.supabaseUrl);
  const runs = Math.max(1, opts.runs ?? 3);

  // Count every request and response byte the loader causes.
  let requests = 0;
  let bytes = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const body = await res.arrayBuffer();
    requests++;
    bytes += body.byteLength;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
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

    const asOfUtc = new Date().toISOString();
    const rows: MeasureRow[] = [];
    for (const c of MEASURE_CASES) {
      const range = productionRange(c.site, c.first, c.last);
      const window = { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive };
      const visibility = productionVisibilityFor(role, siteSet.has(c.site));

      // Independent completeness check: in-window count rows this user can see.
      const { count: serverCount, error: countError } = await client
        .from("production_events")
        .select("id", { count: "exact", head: true })
        .eq("location", c.site)
        .in("event_type", COUNT_TYPES)
        .gte("created_at", window.startUtc)
        .lt("created_at", window.endUtcExclusive)
        .lte("created_at", asOfUtc);

      const loadTimes: number[] = [];
      const countTimes: number[] = [];
      let loaded = 0;
      let inWindow = 0;
      let reqs = 0;
      let payload = 0;
      let error: string | null = countError ? `server count failed: ${countError.message}` : null;
      for (let i = 0; i < runs && !error; i++) {
        requests = 0;
        bytes = 0;
        const t0 = performance.now();
        try {
          const snapshot = await loadProductionEvidence(client, { site: c.site, range: window, asOfUtc, visibility });
          const t1 = performance.now();
          summarizeProduction(prepareProductionEvidence(snapshot), { range: window });
          const t2 = performance.now();
          loadTimes.push(t1 - t0);
          countTimes.push(t2 - t1);
          loaded = snapshot.events.length;
          const s = Date.parse(window.startUtc);
          const e = Date.parse(window.endUtcExclusive);
          inWindow = snapshot.events.filter((ev) => {
            const ms = Date.parse(ev.created_at);
            return ms >= s && ms < e;
          }).length;
          reqs = requests;
          payload = bytes;
        } catch (e) {
          error = e instanceof ProductionReadError ? `${e.kind}: ${e.message}` : String(e);
        }
      }

      const loadMs = loadTimes.length ? Math.round(median(loadTimes)) : null;
      const countMs = countTimes.length ? Math.round(median(countTimes)) : null;
      const complete = error === null && serverCount === inWindow;
      rows.push({
        label: c.label,
        site: c.site,
        windowStartUtc: window.startUtc,
        windowEndUtc: window.endUtcExclusive,
        visibility: visibility.kind,
        serverCount: serverCount ?? null,
        loadedRows: loaded,
        inWindowRows: inWindow,
        requests: reqs,
        payloadBytes: payload,
        loadMs,
        countMs,
        targetMs: c.targetMs,
        error,
        complete,
        withinTarget: complete && loadMs !== null && countMs !== null && loadMs + countMs <= c.targetMs,
      });
    }
    return { email: opts.email, role, sites, asOfUtc, runs, rows };
  } finally {
    await client.auth.signOut();
  }
}

export function measureTable(result: MeasureResult): string {
  const lines = [
    `user: ${result.email} · role: ${result.role ?? "?"} · sites: ${result.sites.join(", ") || "none"}`,
    `cutoff (as of): ${result.asOfUtc} · runs per case: ${result.runs} (median shown)`,
    "",
    "| Case | Window (UTC) | Visibility | Server count | Loaded rows | In-window rows | Requests | Payload | Load ms | Count ms | Target ms | Result |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of result.rows) {
    const verdict = r.error
      ? `ERROR (${r.error})`
      : !r.complete
        ? `INCOMPLETE (in-window ${r.inWindowRows} ≠ server ${r.serverCount})`
        : r.withinTarget
          ? "within target"
          : "OVER TARGET";
    lines.push(
      `| ${r.label} | ${r.windowStartUtc} → ${r.windowEndUtc} | ${r.visibility} | ${r.serverCount ?? "?"} | ${r.loadedRows} | ${r.inWindowRows} | ${r.requests} | ${(r.payloadBytes / 1_048_576).toFixed(1)} MB | ${r.loadMs ?? "–"} | ${r.countMs ?? "–"} | ${r.targetMs} | ${verdict} |`,
    );
  }
  return lines.join("\n");
}
