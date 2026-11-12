/**
 * item-counting · Task 4 staging gate: time the real evidence loader.
 *
 * STAGING ONLY. Run by CJ after supabase/staging/item-counting/01..02.
 * Signs in as a staging test user with the browser (anon) key, so the real
 * RLS policies apply, then runs loadProductionEvidence + the counting
 * reducer for one-day and three-month windows and prints a Markdown table.
 *
 * Setup: create `.env.staging.local` in the repo root (git-ignored), with
 *   STAGING_SUPABASE_URL=https://ybrzhrgfrnvtcwymjdrq.supabase.co
 *   STAGING_SUPABASE_ANON_KEY=<staging anon/publishable key>
 *   STAGING_EMAIL=owner@inka-staging.test
 *   STAGING_PASSWORD=<that test user's password>
 * Run:  npx vite-node tests/staging/measure-item-counting.ts
 * Optional: STAGING_RUNS=3 (repeats per case; the median is reported).
 *
 * Nothing is written to the database. Credentials are read from the file
 * or environment and never printed.
 */
import { readFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { productionRange, type ReportSite } from "../../src/lib/domain/productionPeriods";
import { prepareProductionEvidence, summarizeProduction } from "../../src/lib/domain/productionCounts";
import {
  loadProductionEvidence,
  productionVisibilityFor,
  ProductionReadError,
} from "../../src/lib/repository/supabase/productionEvidence";

const STAGING_REF = "ybrzhrgfrnvtcwymjdrq";
const COUNT_TYPES = ["line_verified", "cancelled", "completed", "dispatched"];

function loadEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const file = ".env.staging.local";
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith("#")) env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

function need(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing ${key} (set it in .env.staging.local or the environment)`);
  return v;
}

interface Case {
  label: string;
  site: ReportSite;
  first: string;
  last: string;
  targetMs: number;
}

const CASES: Case[] = [
  { label: "AU busy day", site: "au", first: "2026-09-15", last: "2026-09-15", targetMs: 2_000 },
  { label: "AU 3 months (busy)", site: "au", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "UK day", site: "uk", first: "2026-03-29", last: "2026-03-29", targetMs: 2_000 },
  { label: "UK 3 months", site: "uk", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
  { label: "US day", site: "us", first: "2026-03-08", last: "2026-03-08", targetMs: 2_000 },
  { label: "US 3 months", site: "us", first: "2026-08-01", last: "2026-10-31", targetMs: 10_000 },
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = need(env, "STAGING_SUPABASE_URL");
  if (!new URL(url).hostname.startsWith(`${STAGING_REF}.`)) {
    throw new Error(`Refusing to run: STAGING_SUPABASE_URL is not the staging project (${STAGING_REF}).`);
  }
  const runs = Math.max(1, Number(env.STAGING_RUNS ?? 3) || 3);

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

  const client = createClient(url, need(env, "STAGING_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: countingFetch },
  });
  const email = need(env, "STAGING_EMAIL");
  const { data: auth, error: authError } = await client.auth.signInWithPassword({
    email,
    password: need(env, "STAGING_PASSWORD"),
  });
  if (authError || !auth.user) throw new Error(`Sign-in failed: ${authError?.message ?? "no user"}`);

  const { data: profile } = await client.from("profiles").select("role").eq("user_id", auth.user.id).maybeSingle();
  const { data: memberships } = await client.from("user_locations").select("location").eq("user_id", auth.user.id);
  const role = (profile as { role?: string } | null)?.role ?? null;
  const sites = new Set(((memberships ?? []) as Array<{ location: string }>).map((m) => m.location));

  const asOfUtc = new Date().toISOString();
  console.log(`# item-counting staging measurements`);
  console.log(`user: ${email} · role: ${role ?? "?"} · sites: ${[...sites].sort().join(", ") || "none"}`);
  console.log(`cutoff (as of): ${asOfUtc} · runs per case: ${runs} (median shown)\n`);
  console.log("| Case | Window (UTC) | Visibility | Server count rows | Loaded rows | Requests | Payload | Load ms | Count ms | Target | Result |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");

  let failures = 0;
  for (const c of CASES) {
    const range = productionRange(c.site, c.first, c.last);
    const window = { startUtc: range.startUtc, endUtcExclusive: range.endUtcExclusive };
    const visibility = productionVisibilityFor(role, sites.has(c.site));

    // Independent completeness check: how many in-window count rows can this user see?
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
    let error: string | null = null;
    for (let i = 0; i < runs && !error; i++) {
      requests = 0;
      bytes = 0;
      const t0 = performance.now();
      try {
        const snapshot = await loadProductionEvidence(client, { site: c.site, range: window, asOfUtc, visibility });
        const t1 = performance.now();
        const summary = summarizeProduction(prepareProductionEvidence(snapshot), { range: window });
        const t2 = performance.now();
        loadTimes.push(t1 - t0);
        countTimes.push(t2 - t1);
        loaded = snapshot.events.length;
        inWindow = snapshot.events.filter((e) => {
          const ms = Date.parse(e.created_at);
          return ms >= Date.parse(window.startUtc) && ms < Date.parse(window.endUtcExclusive);
        }).length;
        reqs = requests;
        payload = bytes;
        if (i === 0 && summary.coverage === undefined) error = "summary has no coverage";
      } catch (e) {
        error = e instanceof ProductionReadError ? `${e.kind}: ${e.message}` : String(e);
      }
    }

    const loadMs = loadTimes.length ? Math.round(median(loadTimes)) : NaN;
    const countMs = countTimes.length ? Math.round(median(countTimes)) : NaN;
    const complete = !countError && serverCount === inWindow;
    const pass = !error && complete && loadMs + countMs <= c.targetMs;
    if (!pass) failures++;
    const result = error
      ? `FAIL (${error})`
      : !complete
        ? `FAIL (in-window rows ${inWindow} ≠ server count ${countError ? "error" : serverCount})`
        : pass
          ? "pass"
          : "FAIL (over target)";
    console.log(
      `| ${c.label} | ${window.startUtc} → ${window.endUtcExclusive} | ${visibility.kind} | ${serverCount ?? "?"} | ${loaded} | ${reqs} | ${(payload / 1_048_576).toFixed(1)} MB | ${loadMs} | ${countMs} | ${c.targetMs} | ${result} |`,
    );
  }

  await client.auth.signOut();
  console.log(`\n${failures === 0 ? "All cases within target." : `${failures} case(s) failed or exceeded target.`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
