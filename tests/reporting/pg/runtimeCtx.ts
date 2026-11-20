/**
 * Offline RuntimeCtx over PGlite for the Task 15 harness tests (not a test
 * file). The lease-expiry wait is shimmed HERE ONLY by expiring the lease row;
 * the hosted runner waits for real and never edits a lease.
 */
import type { PGlite } from "@electric-sql/pglite";
import { serviceRpcClient } from "../../staging/serviceRpc";
import type { Observation } from "../../staging/reportingPublication";
import { INSTALLED_HISTORY } from "../../staging/reportingWorkerHarness";
import type { RuntimeOwnership } from "../../staging/reportingWorkerRuntime";
import type { RuntimeCtx } from "../../staging/reportingWorkerScenario";
import { pgDb, smallState, W1 } from "./runtimeFixtures";

export const HISTORY_0043 = [...INSTALLED_HISTORY.map((h) => ({ ...h })), { version: "20261117000000", name: "0043_reporting_worker_state" }];

export function pgCtx(db: PGlite, own: RuntimeOwnership, over: Partial<RuntimeCtx> = {}) {
  const observations: Observation[] = [];
  const saves = { n: 0 };
  const conn = () => ({ ...pgDb(db), end: async () => undefined });
  const ctx: RuntimeCtx = {
    site: own.site, staff: W1,
    open: async () => conn(),
    rpcClient: (c, opts) => serviceRpcClient(c, opts),
    asRole: async (c, role) => {
      await c.query("reset role");
      if (role !== "postgres") await c.query(`set local role ${role}`);
    },
    toggle: async (enabled) => {
      const epoch = async () => String((await db.query<{ e: string }>("select capture_epoch::text as e from reporting_private.control")).rows[0].e);
      const before = await epoch();
      const r = await serviceRpcClient(pgDb(db)).rpc("set_reporting_capture", { p_enabled: enabled });
      if (r.error) throw new Error(r.error.message);
      const after = await epoch();
      own.captureTransitions.push({ enable: enabled, before, after, state: "confirmed" });
      return Number(after);
    },
    history: async () => HISTORY_0043,
    state: (c) => smallState(c),
    awaitLeaseExpiry: async (site) => {
      await db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = $1 and state in ('active', 'frozen', 'publishing')", [site]);
      await db.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = $1 and active_batch_id is not null", [site]);
      return 0;
    },
    record: (o) => observations.push(o),
    save: () => void saves.n++,
    redact: (s) => s.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]").replace(/postgres(ql)?:\/\/\S+/g, "[url]"),
    now: () => Date.now(),
    sleep: async () => undefined,
    limits: { paceCalls: 3, maxInvocations: 30 },
    ...over,
  };
  return { ctx, observations, saves };
}
