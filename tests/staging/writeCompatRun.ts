/**
 * Run the write-path/digest compatibility steps on STAGING (`--write-compat`).
 *
 * One transaction, always ROLLED BACK: with 0036's policies (as installed),
 * then, under a savepoint, with the pre-0036 SELECT policies restored from the
 * plan's rollback text (the rollback rehearsal). Every role step uses that
 * role's real session claims, `authenticated` with RLS on and authenticated's
 * catalog statement_timeout. Never commits; never logs claims.
 */
import type pg from "pg";
import { checkPolicySet, type ParityArtifact } from "./itemCountingPolicyParity";
import { APPLY_TIMEOUT, catalog } from "./policyParityRun";
import { deductSummary, STEPS, type Actor, type PolicySet, type SetOutcome, type StepOutcome } from "./writeCompat";

/** The plan's policy rollback body (Release and rollback), without BEGIN/COMMIT. */
export const PRE_0036_RESTORE = [
  "set local search_path = public",
  "drop policy production_events_read on public.production_events",
  "drop policy production_events_select on public.production_events",
  `create policy production_events_read on production_events for select
  using (can_access_location(location) and (staff_id = auth.uid() or is_manager_or_higher()))`,
  `create policy production_events_select on production_events for select
  using (can_access_location(location) and (staff_id = auth.uid() or current_user_role() in ('owner', 'manager', 'cs', 'kiosk')))`,
];

async function become(client: pg.Client, actor: Actor, claimsText: Record<string, string>): Promise<void> {
  await client.query("reset role");
  if (actor === "postgres") return;
  const claims = actor === "service_role" ? JSON.stringify({ role: "service_role" }) : actor === "anon" ? JSON.stringify({ role: "anon" }) : claimsText[actor];
  if (!claims) throw new Error(`no session claims for ${actor}`);
  await client.query(
    "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', '', true)",
    [claims],
  );
  await client.query(`set local role ${actor === "service_role" ? "service_role" : actor === "anon" ? "anon" : "authenticated"}`);
  if (actor !== "service_role" && actor !== "anon") await client.query(APPLY_TIMEOUT);
}

async function runSteps(client: pg.Client, ctx: { staff: string; manager: string }, claimsText: Record<string, string>, log: (l: string) => void): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (const step of STEPS) {
    await client.query("savepoint wc_step");
    let result: string;
    try {
      await become(client, step.actor, claimsText);
      const res = await client.query(step.sql, (step.params ?? []).map((k) => ctx[k]));
      const row = res.rows[0] as Record<string, unknown> | undefined;
      if (row && "r" in row) result = deductSummary(row.r);
      else if (row && "result" in row) result = String(row.result);
      else result = String(res.rowCount ?? 0);
      await client.query("reset role");
      await client.query("release savepoint wc_step");
    } catch (e) {
      const code = (e as { code?: string }).code ?? "unknown";
      result = `error ${code}`;
      await client.query("rollback to savepoint wc_step");
      await client.query("reset role");
    }
    log(`${step.id} ${step.actor} · ${step.what}: ${result}`);
    out.push({ id: step.id, actor: step.actor, result });
  }
  return out;
}

export async function collectWriteCompat(
  client: pg.Client,
  opts: { claimsText: Record<string, string>; parity: ParityArtifact | null; log: (l: string) => void },
): Promise<{ post: SetOutcome; pre: SetOutcome }> {
  // Before: the standard baseline snapshot. After: the passing standard comparison's after-hash.
  const snapHash = (mode: "before" | "after") => {
    if (mode === "before") return [...(opts.parity?.snapshots ?? [])].reverse().find((s) => s.mode === "before" && s.arrangement === "standard")?.catalog.policyHash ?? null;
    const cmp = (opts.parity?.comparisons ?? []).find((c) => c.arrangement === "standard" && c.problems.length === 0);
    return cmp?.afterHash ?? null;
  };
  await client.query("begin");
  try {
    const ids = await client.query(
      "select email, id::text as id from auth.users where email in ('staff@inka-staging.test', 'manager@inka-staging.test')",
    );
    const by = Object.fromEntries(ids.rows.map((r) => [String(r.email).split("@")[0], String(r.id)]));
    if (!by.staff || !by.manager) throw new Error("staff/manager test users not found");
    const ctx = { staff: by.staff, manager: by.manager };

    const runSet = async (set: PolicySet): Promise<SetOutcome> => {
      await client.query(`savepoint wc_set`);
      try {
        if (set === "pre") for (const sql of PRE_0036_RESTORE) await client.query(sql);
        if (set === "pre") await client.query("set local search_path = \"$user\", public, extensions");
        const cat = await catalog(client);
        const expected = snapHash(set === "post" ? "after" : "before");
        const policyProblems = checkPolicySet(cat.policies, set);
        if (!expected) policyProblems.push(`no ${set === "post" ? "after" : "before"} parity snapshot to compare the policy hash with`);
        else if (cat.policyHash !== expected) policyProblems.push(`policy hash ${cat.policyHash.slice(0, 12)} differs from the parity ${set === "post" ? "after" : "before"} snapshot ${expected.slice(0, 12)}`);
        opts.log(`policies: ${set === "post" ? "0036 (installed)" : "pre-0036 restored in a rolled-back savepoint"} · hash ${cat.policyHash.slice(0, 12)}`);
        const steps = await runSteps(client, ctx, opts.claimsText, opts.log);
        return { set, policyHash: cat.policyHash, policyProblems, steps };
      } finally {
        await client.query("rollback to savepoint wc_set");
      }
    };
    const post = await runSet("post");
    const pre = await runSet("pre");
    return { post, pre };
  } finally {
    await client.query("rollback");
  }
}
