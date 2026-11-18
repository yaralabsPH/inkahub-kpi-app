/**
 * Planner checkpoint 2026-11-18, Must-fix T15P-1: the worker's deadline check
 * and single-flight heartbeat must run before EVERY actual frozen-read RPC
 * (internal member/by-id/children pages, coalesced flushes and fallbacks),
 * not only once per outer reader call.
 *
 * Reproduction (planner, offline): one parent with 500 one-row children pages,
 * 1 simulated second per RPC, 240 s budget. Before the fix: 501 RPCs, one
 * guard call, 501,000 ms elapsed, no stop.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { coalescingChildren } from "../../api/_lib/production-reporting-materialize";
import { rpcFrozenReader, type FrozenBatchRef } from "../../api/_lib/production-reporting-reader";
import { guardedReader, HEARTBEAT_MS, OWNER_GROUP, runReportingCycle, WORKER_BUDGET_MS } from "../../api/_lib/production-reporting-worker";
import { reportingDb } from "./pg/harness";
import { pgRpc } from "./pg/rpc";
import { pgDb } from "./pg/runtimeFixtures";
import { parityProblems } from "../staging/reportingWorkerRuntime";

const REF: FrozenBatchRef = { batchId: "11111111-1111-4111-8111-111111111111", fence: 1, site: "au", cutoff: "2026-11-15T12:00:00.000000Z", kind: "rebuild" };
const BIG = "x".repeat(600_000);
const img = (id: string, parent: string | null, type = "cancelled") => ({ id, location: "au", staff_id: null, department: "framed", order_number: "O-1", line_sku: null, line_quantity: null, event_type: type, created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: parent, cs_case_id: null, note: BIG });
const pad = (i: number) => String(i).padStart(4, "0");

class OutOfTimeProbe extends Error {}

function clock(budgetMs: number) {
  const s = { t: 0, calls: 0, guards: 0, afterDeadline: 0 };
  const guard = async () => {
    s.guards++;
    if (s.t >= budgetMs) throw new OutOfTimeProbe("out of time");
  };
  const tick = () => {
    s.calls++;
    if (s.t >= budgetMs) s.afterDeadline++;
    s.t += 1000;
  };
  return { s, guard, tick };
}

describe("per-RPC read guard (reader level)", () => {
  it("the planner's reproduction now stops at the deadline without requesting another page", async () => {
    const { s, guard, tick } = clock(240_000);
    const client = {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        tick();
        if (fn !== "read_reporting_children") throw new Error(`unexpected ${fn}`);
        const after = a.p_after_event_id as string | null;
        const i = after === null ? 0 : Number(after.slice(1)) + 1;
        return { data: i < 500 ? [{ parent_event_id: "p1", event_id: `c${pad(i)}`, image: img(`c${pad(i)}`, "p1") }] : [], error: null };
      },
    };
    const reader = guardedReader(coalescingChildren(rpcFrozenReader(client, REF, { beforeRead: guard })), guard);
    let kids = 0;
    await expect((async () => {
      for await (const _ of reader.children(["p1"])) kids++;
    })()).rejects.toBeInstanceOf(OutOfTimeProbe);
    expect(s.afterDeadline).toBe(0); // no RPC was sent once the deadline passed
    expect(s.calls).toBe(240);
    expect(s.guards).toBeGreaterThanOrEqual(s.calls);
    expect(kids).toBeLessThanOrEqual(240);
  });

  it("without the per-RPC guard the same read runs past the deadline (documents the defect)", async () => {
    const { s, guard, tick } = clock(240_000);
    const client = {
      rpc: async (_fn: string, a: Record<string, unknown>) => {
        tick();
        const after = a.p_after_event_id as string | null;
        const i = after === null ? 0 : Number(after.slice(1)) + 1;
        return { data: i < 500 ? [{ parent_event_id: "p1", event_id: `c${pad(i)}`, image: img(`c${pad(i)}`, "p1") }] : [], error: null };
      },
    };
    const reader = guardedReader(coalescingChildren(rpcFrozenReader(client, REF)), guard);
    for await (const _ of reader.children(["p1"])) void 0;
    expect(s.calls).toBe(501);
    expect(s.afterDeadline).toBeGreaterThan(0);
  });

  it("a multi-page owner-member read checks before each page", async () => {
    const { s, guard, tick } = clock(10_000_000);
    let page = 0;
    const client = {
      rpc: async () => {
        tick();
        page++;
        return { data: page <= 3 ? [{ owner_index: 0, event_id: `e${page}`, image: img(`e${page}`, null, "line_verified") }] : [], error: null };
      },
    };
    const out = await rpcFrozenReader(client, REF, { beforeRead: guard }).members([{ partitionKind: "order", partitionKey: "O-1" }], 1000);
    expect([...out.values()][0]).toHaveLength(3);
    expect(s.calls).toBe(4);
    expect(s.guards).toBe(4);
  });

  it("a byte-capped by-id read checks before each continuation page and stops at the deadline", async () => {
    const { s, guard, tick } = clock(2000);
    const client = {
      rpc: async (_fn: string, a: Record<string, unknown>) => {
        tick();
        const first = (a.p_ids as string[])[0];
        return { data: [{ event_id: first, image: img(first, null, "line_verified") }], error: null }; // one id per (byte-capped) page
      },
    };
    await expect(rpcFrozenReader(client, REF, { beforeRead: guard }).byIds(["a", "b", "c", "d"])).rejects.toBeInstanceOf(OutOfTimeProbe);
    expect(s.calls).toBe(2);
    expect(s.afterDeadline).toBe(0);
  });

  it("without a guard the reader behaves exactly as before", async () => {
    const client = { rpc: async () => ({ data: [], error: null }) };
    const out = await rpcFrozenReader(client, REF).byIds(["a"]);
    expect(out.size).toBe(0);
  });
});

describe("the real worker over real SQL with 1 simulated second per RPC: budget, heartbeat, resume, exact publication", () => {
  const W = (i: number) => `${String(i).padStart(8, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
  let db: PGlite;
  beforeAll(async () => {
    db = await reportingDb();
    for (let w = 0; w < 3; w++) await db.query("insert into auth.users (id, email) values ($1, $2)", [W(w), `p${w}@x`]);
    let n = 0;
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 150; i++) {
        const id = `pg-${w}-${pad(i)}`;
        const at = new Date(Date.parse("2026-10-01T00:00:00Z") + (n++) * 7000).toISOString();
        await db.query(
          `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
           values ('au', $1, $2, 'framed', $3, 'INKA-KAN0566-A4-FB', 1, 'line_verified', 's', '', $4, null)`,
          [id, W(w), `PG-${w}-${Math.floor(i / 3)}`, at]);
      }
    }
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: "au", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  }, 300_000);
  afterAll(async () => db?.close());

  it("each invocation stops within budget + the in-flight group, renewals stay ~30 s apart, resumes publish exactly", async () => {
    let t = Date.parse("2026-11-18T00:00:00Z");
    const inner = pgRpc(db);
    const states: string[] = [];
    const overruns: number[] = [];
    const gaps: number[] = [];
    for (let inv = 0; inv < 40; inv++) {
      const started = t;
      let last = t;
      const client = {
        rpc: async (fn: string, a: Record<string, unknown>) => {
          t += 1000;
          if (fn === "renew_reporting_lease") {
            gaps.push(t - last);
            last = t;
          }
          return inner.rpc(fn, a);
        },
      };
      const r = await runReportingCycle({ client, now: () => t, sleep: async () => undefined }, { site: "au", mode: "rebuild" });
      expect(r.problems).toEqual([]);
      states.push(r.state);
      overruns.push(t - started - WORKER_BUDGET_MS);
      if (r.state === "published") break;
      t += 400_000; // past the 360 s lease before the next invocation resumes (simulated clock)
      // The lease expiry is checked against the database clock, so expire it there too (as walk-resume.test.ts does).
      await db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = 'au' and state in ('active', 'frozen', 'publishing')");
      await db.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = 'au' and active_batch_id is not null");
    }
    expect(states.at(-1)).toBe("published");
    expect(states.filter((x) => x === "pending").length).toBeGreaterThan(0); // plan/stage really were interrupted and resumed
    // Over budget by at most the in-flight owner group plus publication bookkeeping, never by an unbounded page loop.
    expect(Math.max(...overruns)).toBeLessThanOrEqual((OWNER_GROUP + 2) * 1000 + 10_000);
    if (gaps.length) expect(Math.max(...gaps)).toBeLessThanOrEqual(HEARTBEAT_MS + (OWNER_GROUP + 2) * 1000);
    for (const who of [null, W(0), W(1), W(2)]) expect(await parityProblems(pgDb(db), "au", who)).toEqual([]);
  }, 600_000);
});

describe("the real worker wires the per-RPC guard: one line with 300 cancellations read one row per page", () => {
  const STAFF = "00000009-cccc-4ccc-8ccc-cccccccccccc";
  let db: PGlite;
  beforeAll(async () => {
    db = await reportingDb();
    await db.query("insert into auth.users (id, email) values ($1, 'c@x')", [STAFF]);
    const ins = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
      values ('au', $1, $2, 'framed', 'PG-LONG', $3, $4, $5, 's', '', $6, $7)`;
    await db.query(ins, ["pl-line", STAFF, "INKA-KAN0566-A4-FB", 1, "line_verified", "2026-10-01T00:00:00Z", null]);
    for (let i = 0; i < 300; i++) await db.query(ins, [`pl-c${pad(i)}`, STAFF, null, null, "cancelled", new Date(Date.parse("2026-10-01T00:00:01Z") + i * 1000).toISOString(), "pl-line"]);
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: "au", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  }, 300_000);
  afterAll(async () => db?.close());

  // FINDING for the planner (Open question): an owner whose reads alone exceed one invocation's budget never finishes,
  // because owner materialization restarts from the beginning on resume. This is not new: without the T15P-1 wiring the
  // same owner also stayed pending here, only with each invocation overrunning by ~70 s (measured 74,000/68,000/68,000 ms).
  it("no invocation runs past the budget by more than the in-flight group; the over-budget owner stays pending and nothing partial is published", async () => {
    let t = Date.parse("2026-11-18T00:00:00Z");
    const inner = pgRpc(db);
    const overruns: number[] = [];
    let last = "";
    for (let inv = 0; inv < 3; inv++) {
      const started = t;
      const client = {
        rpc: async (fn: string, a: Record<string, unknown>) => {
          t += 1000;
          // Byte-capped pages: every children read returns at most one row (the hosted 1 MiB cap with large images).
          return inner.rpc(fn, fn === "read_reporting_children" ? { ...a, p_limit: 1 } : a);
        },
      };
      const r = await runReportingCycle({ client, now: () => t, sleep: async () => undefined }, { site: "au", mode: "rebuild" });
      expect(r.problems).toEqual([]);
      overruns.push(t - started - WORKER_BUDGET_MS);
      last = r.state;
      if (r.state === "published") break;
      await db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = 'au' and state in ('active', 'frozen', 'publishing')");
      await db.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = 'au' and active_batch_id is not null");
      t += 400_000;
    }
    expect(Math.max(...overruns), `overruns (ms): ${overruns.join(",")}`).toBeLessThanOrEqual((OWNER_GROUP + 2) * 1000 + 10_000);
    expect(last).toBe("pending");
    // no partial publication: no generation exists and the site still reads legacy
    expect((await db.query<{ n: number }>("select count(*)::int as n from reporting_private.generations where site = 'au'")).rows[0].n).toBe(0);
    expect((await db.query<{ m: string }>("select read_mode as m from reporting_private.site_state where site = 'au'")).rows[0].m).toBe("legacy");
  }, 600_000);
});
