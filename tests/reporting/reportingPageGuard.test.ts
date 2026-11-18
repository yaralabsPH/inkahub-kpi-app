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

describe("T15P-1a: the deadline is checked again after a lease renewal (real worker, real SQL, simulated clock)", () => {
  const S = (i: number) => `${String(i).padStart(8, "0")}-dddd-4ddd-8ddd-dddddddddddd`;
  const FROZEN = /^(read_reporting_|list_reporting_owners$)/;
  const MATERIALIZE = /^read_reporting_(owner_members|events_by_id|children|staff_stream|predecessor_page)$/;
  let db: PGlite;
  beforeAll(async () => {
    db = await reportingDb();
    // ONE owner whose children are read one row per page (byte-capped), so a due renewal lands INSIDE its reads,
    // i.e. in the per-RPC page guard, not at the between-group checkpoints (which already check the deadline).
    await db.query("insert into auth.users (id, email) values ($1, 'd0@x')", [S(0)]);
    const ins = `insert into public.production_events (location, id, staff_id, department, order_number, line_sku, line_quantity, event_type, station_id, note, created_at, parent_event_id)
      values ('au', $1, $2, 'framed', 'DL-LONG', $3, $4, $5, 's', '', $6, $7)`;
    await db.query(ins, ["dl-line", S(0), "INKA-KAN0566-A4-FB", 1, "line_verified", "2026-10-01T00:00:00Z", null]);
    for (let i = 0; i < 300; i++) await db.query(ins, [`dl-c${pad(i)}`, S(0), null, null, "cancelled", new Date(Date.parse("2026-10-01T00:00:01Z") + i * 1000).toISOString(), "dl-line"]);
    const c = pgRpc(db);
    expect((await c.rpc("set_reporting_capture", { p_enabled: true })).error).toBeNull();
    expect((await c.rpc("set_reporting_site_mode", { p_site: "au", p_read_mode: null, p_processor_enabled: true })).error).toBeNull();
  }, 300_000);
  afterAll(async () => db?.close());

  /** Expire any held lease (database clock), so each scenario starts or resumes cleanly. */
  const expire = async () => {
    await db.query("update reporting_private.batches set lease_expires_at = now() - interval '1 second' where site = 'au' and state in ('active', 'frozen', 'publishing')");
    await db.query("update reporting_private.site_state set lease_expires_at = now() - interval '1 second' where site = 'au' and active_batch_id is not null");
  };

  /**
   * Runs one invocation. `renew` decides what the FIRST renewal that happens during materialization does:
   * it may move the clock and/or fail transiently. Returns the calls made after that renewal completed.
   */
  async function scenario(renew: (ctx: { t: number; deadline: number; attempt: number }) => { t: number; fail?: boolean }) {
    await expire();
    let t = Date.parse("2026-11-18T06:00:00Z") + Math.floor(Math.random() * 1e6) * 1000;
    const start = t;
    const deadline = start + WORKER_BUDGET_MS;
    const inner = pgRpc(db);
    let materializing = false;
    let target = false; // the targeted renewal has been reached
    let done = false; // the targeted renewal has completed
    let attempt = 0;
    let renewedAt: number | null = null;
    let prev = "";
    const after: Array<{ fn: string; at: number }> = [];
    const client = {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        if (done) after.push({ fn, at: t });
        if (MATERIALIZE.test(fn)) materializing = true;
        const midOwner = prev === "read_reporting_children";
        if (fn !== "renew_reporting_lease") prev = fn;
        if (fn === "renew_reporting_lease" && materializing && midOwner && !done) {
          target = true;
          attempt++;
          const r = renew({ t, deadline, attempt });
          t = r.t;
          if (r.fail) return { data: null, error: { message: "fetch failed", code: null } };
          const out = await inner.rpc(fn, a);
          done = true;
          renewedAt = t;
          return out;
        }
        t += 1000;
        return inner.rpc(fn, fn === "read_reporting_children" ? { ...a, p_limit: 1 } : a);
      },
    };
    const r = await runReportingCycle({ client, now: () => t, sleep: async (ms: number) => void (t += ms) }, { site: "au", mode: "rebuild" });
    return { r, after, target, renewedAt, deadline };
  }

  it("a successful renewal that crosses the deadline: zero frozen reads start afterwards and the cycle returns pending", async () => {
    const { r, after, target, renewedAt, deadline } = await scenario(({ deadline }) => ({ t: deadline + 500 }));
    expect(target).toBe(true);
    expect(renewedAt!).toBeGreaterThan(deadline);
    expect(r.problems).toEqual([]);
    expect(r.state).toBe("pending");
    expect(after.filter((c) => FROZEN.test(c.fn))).toEqual([]);
  }, 300_000);

  it("readers awaiting the same (single-flight) renewal all stop: still zero frozen reads after it", async () => {
    // Concurrent reads in the coalescing view wait on the one in-flight renewal; none may dispatch after it.
    const { r, after } = await scenario(({ deadline }) => ({ t: deadline + 1 }));
    expect(OWNER_GROUP).toBeGreaterThan(1);
    expect(r.state).toBe("pending");
    expect(after.filter((c) => FROZEN.test(c.fn))).toEqual([]);
  }, 300_000);

  it("a renewal retry that crosses the deadline: zero frozen reads after the retried renewal", async () => {
    // attempt 1 fails transiently well before the deadline; the 30 s retry wait plus a slow attempt 2 ends past it
    const { r, after, renewedAt, deadline } = await scenario(({ t, deadline, attempt }) =>
      attempt === 1 ? { t: Math.min(t, deadline - 40_000), fail: true } : { t: deadline + 2_000 });
    expect(renewedAt!).toBeGreaterThan(deadline);
    expect(r.state).toBe("pending");
    expect(after.filter((c) => FROZEN.test(c.fn))).toEqual([]);
  }, 300_000);

  it("a renewal that completes before the deadline lets materialization continue", async () => {
    const { r, after, target } = await scenario(({ t }) => ({ t: t + 500 }));
    expect(target).toBe(true);
    expect(r.problems).toEqual([]);
    expect(after.filter((c) => MATERIALIZE.test(c.fn)).length).toBeGreaterThan(0);
  }, 300_000);
});

describe("T15P-4b one-call page methods and the aggregators rebuilt on them", () => {
  const small = (id: string, parent: string | null = null, order = "O-1") => ({ id, location: "au", staff_id: null, department: "framed", order_number: order, line_sku: null, line_quantity: null, event_type: parent ? "cancelled" : "line_verified", created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: parent, cs_case_id: null });
  const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  /** An in-memory 0040 source that returns at most PER rows per call (a byte-capped short page), recording every call. */
  function source(per: number) {
    const members: Array<{ owner: string; id: string }> = [
      ...["a1", "a2", "a3", "a4", "a5"].map((id) => ({ owner: "order:A", id })),
      ...["b1", "b2"].map((id) => ({ owner: "order:B", id })),
    ];
    const present = new Set(["a", "b", "c", "e"]);
    const kids: Array<{ parent: string; id: string }> = [{ parent: "p1", id: "k1" }, { parent: "p1", id: "k2" }, { parent: "p1", id: "k3" }, { parent: "p2", id: "k4" }];
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const guards = { n: 0 };
    const client = {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        const { p_batch: _b, p_fence: _f, ...args } = a;
        calls.push({ fn, args });
        if (fn === "read_reporting_owner_members") {
          const owners = (a.p_owners as string[][]).map((p) => `${p[0]}:${p[1]}`);
          const ai = a.p_after_index as number | null;
          const aid = a.p_after_event_id as string | null;
          const rows = members
            .map((m) => ({ idx: owners.indexOf(m.owner), id: m.id }))
            .filter((m) => m.idx >= 0)
            .filter((m) => ai === null || m.idx > ai || (m.idx === ai && aid !== null && cmp(m.id, aid) > 0))
            .slice(0, Math.min(per, a.p_limit as number));
          return { data: rows.map((m) => ({ owner_index: m.idx, event_id: m.id, image: small(m.id) })), error: null };
        }
        if (fn === "read_reporting_events_by_id") {
          const rows = (a.p_ids as string[]).filter((id) => present.has(id)).slice(0, per);
          return { data: rows.map((id) => ({ event_id: id, image: small(id) })), error: null };
        }
        if (fn === "read_reporting_children") {
          const ps = a.p_parent_ids as string[];
          const ap = a.p_after_parent_id as string | null;
          const aid = a.p_after_event_id as string | null;
          const rows = kids.filter((k) => ps.includes(k.parent)).filter((k) => ap === null || cmp(k.parent, ap) > 0 || (k.parent === ap && cmp(k.id, aid!) > 0)).slice(0, Math.min(per, a.p_limit as number));
          return { data: rows.map((k) => ({ parent_event_id: k.parent, event_id: k.id, image: small(k.id, k.parent) })), error: null };
        }
        throw new Error(`unexpected ${fn}`);
      },
    };
    const reader = rpcFrozenReader(client, REF, { beforeRead: async () => void guards.n++ });
    return { reader, calls, guards };
  }
  const A = { partitionKind: "order" as const, partitionKey: "A" };
  const B = { partitionKind: "order" as const, partitionKey: "B" };

  it("each page method makes exactly one guarded RPC and returns its keyset", async () => {
    const { reader, calls, guards } = source(2);
    const m = await reader.pages.membersPage([A, B], null);
    expect(m.rows.map((r) => [r.ownerIndex, r.ev.id])).toEqual([[0, "a1"], [0, "a2"]]);
    expect(m).toMatchObject({ next: { index: 0, id: "a2" }, empty: false });
    const m2 = await reader.pages.membersPage([A, B], { index: 0, id: null }, 1);
    expect(m2.rows.map((r) => [r.ownerIndex, r.ev.id])).toEqual([[1, "b1"]]);
    expect(calls[1].args).toMatchObject({ p_after_index: 0, p_after_event_id: null, p_limit: 1 });
    const b = await reader.pages.byIdsPage(["a", "b", "c", "d", "e"]);
    expect(b).toMatchObject({ pending: ["c", "d", "e"], empty: false });
    expect(b.rows.map((e) => e.id)).toEqual(["a", "b"]);
    const none = await reader.pages.byIdsPage(["d"]);
    expect(none).toMatchObject({ rows: [], pending: ["d"], empty: true });
    const c = await reader.pages.childrenPage(["p1", "p2"], { parent: "p1", id: "k2" });
    expect(c.rows.map((e) => e.id)).toEqual(["k3", "k4"]);
    expect(c).toMatchObject({ next: { parent: "p2", id: "k4" }, empty: false });
    const end = await reader.pages.childrenPage(["p1", "p2"], c.next);
    expect(end).toEqual({ rows: [], next: null, empty: true });
    expect(calls).toHaveLength(6);
    expect(guards.n).toBe(6);
    expect(reader.requests()).toBe(6);
  });

  it("rejects bad page arguments before any RPC", async () => {
    const { reader, calls, guards } = source(2);
    await expect(reader.pages.membersPage([], null)).rejects.toThrow(/1\.\.100 owners/);
    await expect(reader.pages.membersPage([A], null, 1001)).rejects.toThrow(/page limit/);
    await expect(reader.pages.byIdsPage(["b", "a"])).rejects.toThrow(/sorted/);
    await expect(reader.pages.byIdsPage(["a", "a"])).rejects.toThrow(/unique/);
    await expect(reader.pages.byIdsPage(Array.from({ length: 501 }, (_, i) => `i${String(i).padStart(4, "0")}`))).rejects.toThrow(/1\.\.500/);
    await expect(reader.pages.childrenPage([], null)).rejects.toThrow(/1\.\.1000/);
    await expect(reader.pages.childrenPage(["p1"], null, 0)).rejects.toThrow(/page limit/);
    expect(calls).toHaveLength(0);
    expect(guards.n).toBe(0);
  });

  it("members (cap+1 overflow skip), byIds (byte-cap continuation) and children (lazy) keep their exact results and RPC sequences", async () => {
    const { reader, calls, guards } = source(2);
    const mem = await reader.members([A, B], 3);
    expect([...mem.values()].map((l) => l.map((e) => e.id))).toEqual([["a1", "a2", "a3", "a4"], ["b1", "b2"]]);
    expect(calls.map((c) => [c.args.p_after_index, c.args.p_after_event_id])).toEqual([[null, null], [0, "a2"], [0, null], [1, "b2"]]);
    calls.length = 0;
    const by = await reader.byIds(["e", "c", "a", "d", "b", "a"]);
    expect([...by.keys()].sort()).toEqual(["a", "b", "c", "e"]);
    expect(calls.map((c) => c.args.p_ids)).toEqual([["a", "b", "c", "d", "e"], ["c", "d", "e"]]); // c,e returned; nothing pending after e
    calls.length = 0;
    const seen: string[] = [];
    for await (const e of reader.children(["p2", "p1", "p1"])) {
      seen.push(e.id);
      if (seen.length === 3) break; // a consumer that stops reads no more pages
    }
    expect(seen).toEqual(["k1", "k2", "k3"]);
    expect(calls.map((c) => [c.args.p_parent_ids, c.args.p_after_parent_id, c.args.p_after_event_id])).toEqual([[["p1", "p2"], null, null], [["p1", "p2"], "p1", "k2"]]);
    calls.length = 0;
    const all: string[] = [];
    for await (const e of reader.children(["p1", "p2"])) all.push(e.id);
    expect(all).toEqual(["k1", "k2", "k3", "k4"]);
    expect(calls).toHaveLength(3); // two pages + the empty end page
    expect(guards.n).toBe(4 + 2 + 2 + 3);
  });
});

describe("T15P-4b compatibility at group rollover (interim Should-fix 1): the rebuilt aggregators vs the pre-4b loops", () => {
  const tiny = (id: string, parent: string | null = null) => ({ id, location: "au", staff_id: null, department: "framed", order_number: "O-1", line_sku: null, line_quantity: null, event_type: parent ? "cancelled" : "line_verified", created_at: "2026-10-01T00:00:00.000000Z", parent_event_id: parent, cs_case_id: null });
  const cmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const p4 = (n: number) => String(n).padStart(4, "0");
  const OWN = Array.from({ length: 101 }, (_, i) => ({ partitionKind: "order" as const, partitionKey: `G${p4(i)}` }));
  const MEMBERS = OWN.flatMap((o, i) => Array.from({ length: i === 99 ? 6 : (i % 4) + 1 }, (_, j) => ({ owner: `order:${o.partitionKey}`, id: `m${p4(i)}-${j}` })));
  const IDS = Array.from({ length: 501 }, (_, i) => `i${p4(i)}`);
  const PRESENT = new Set(IDS.filter((_, i) => i % 7 !== 3));
  const PARENTS = Array.from({ length: 1001 }, (_, i) => `p${p4(i)}`);
  const KIDS = PARENTS.flatMap((p, i) => Array.from({ length: i % 3 }, (_, j) => ({ parent: p, id: `${p}-k${j}` })));
  /** Short pages: members 7, by-id 50, children 40 rows per call (whatever the requested limit). */
  function source(bad?: { fn: string; call: number; row: number }) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const guards = { n: 0 };
    const client = {
      rpc: async (fn: string, a: Record<string, unknown>) => {
        const { p_batch: _b, p_fence: _f, ...args } = a;
        calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
        let data: Array<Record<string, unknown>>;
        if (fn === "read_reporting_owner_members") {
          const owners = (a.p_owners as string[][]).map((p) => `${p[0]}:${p[1]}`);
          const ai = a.p_after_index as number | null;
          const aid = a.p_after_event_id as string | null;
          data = MEMBERS.map((m) => ({ idx: owners.indexOf(m.owner), id: m.id })).filter((m) => m.idx >= 0)
            .filter((m) => ai === null || m.idx > ai || (m.idx === ai && aid !== null && cmp(m.id, aid) > 0)).slice(0, 7)
            .map((m) => ({ owner_index: m.idx, event_id: m.id, image: tiny(m.id) }));
        } else if (fn === "read_reporting_events_by_id") {
          data = (a.p_ids as string[]).filter((id) => PRESENT.has(id)).slice(0, 50).map((id) => ({ event_id: id, image: tiny(id) }));
        } else if (fn === "read_reporting_children") {
          const ps = a.p_parent_ids as string[];
          const ap = a.p_after_parent_id as string | null;
          const aid = a.p_after_event_id as string | null;
          data = KIDS.filter((k) => ps.includes(k.parent)).filter((k) => ap === null || cmp(k.parent, ap) > 0 || (k.parent === ap && cmp(k.id, aid!) > 0)).slice(0, 40)
            .map((k) => ({ parent_event_id: k.parent, event_id: k.id, image: tiny(k.id, k.parent) }));
        } else throw new Error(`unexpected ${fn}`);
        if (bad && bad.fn === fn && calls.filter((c) => c.fn === fn).length === bad.call && data[bad.row]) data[bad.row] = { ...data[bad.row], owner_index: 999, parent_event_id: "zzz" };
        return { data, error: null };
      },
    };
    return { client, calls, guards };
  }
  /** The pre-4b aggregators, verbatim in behaviour (same RPC arguments, same validation per row). */
  function pre4b(client: { rpc: (fn: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> }) {
    const call = async (fn: string, args: Record<string, unknown>) => (await client.rpc(fn, { p_batch: REF.batchId, p_fence: REF.fence, ...args })).data as Array<Record<string, unknown>>;
    return {
      async members(owners: typeof OWN, cap: number) {
        const out = new Map<string, string[]>(owners.map((o) => [`${o.partitionKind}\u0000${o.partitionKey}`, []]));
        for (let g = 0; g < owners.length; g += 100) {
          const group = owners.slice(g, g + 100);
          const pairs = group.map((o) => [o.partitionKind, o.partitionKey]);
          let afterIndex: number | null = null;
          let afterId: string | null = null;
          for (;;) {
            const rows = await call("read_reporting_owner_members", { p_owners: pairs, p_after_index: afterIndex, p_after_event_id: afterId, p_limit: 1000 });
            if (!rows.length) break;
            for (const r of rows) {
              const idx = r.owner_index as number;
              if (idx < 0 || idx >= group.length) throw new Error("bad owner_index");
              const list = out.get(`${group[idx].partitionKind}\u0000${group[idx].partitionKey}`)!;
              list.push(r.event_id as string);
              afterIndex = idx;
              afterId = r.event_id as string;
              if (list.length > cap) {
                afterId = null;
                break;
              }
            }
          }
        }
        return out;
      },
      async byIds(ids: string[]) {
        const out: string[] = [];
        const want = [...new Set(ids)].sort(cmp);
        for (let g = 0; g < want.length; g += 500) {
          let pending = want.slice(g, g + 500);
          while (pending.length) {
            const rows = await call("read_reporting_events_by_id", { p_ids: pending });
            if (!rows.length) break;
            let last = "";
            for (const r of rows) {
              out.push(r.event_id as string);
              last = r.event_id as string;
            }
            pending = pending.filter((id) => cmp(id, last) > 0);
          }
        }
        return out;
      },
      async children(parentIds: string[]) {
        const out: string[] = [];
        const ids = [...new Set(parentIds)].sort(cmp);
        for (let g = 0; g < ids.length; g += 1000) {
          const group = ids.slice(g, g + 1000);
          let afterParent: string | null = null;
          let afterId: string | null = null;
          for (;;) {
            const rows = await call("read_reporting_children", { p_parent_ids: group, p_after_parent_id: afterParent, p_after_event_id: afterId, p_limit: 1000 });
            if (!rows.length) break;
            for (const r of rows) {
              afterParent = r.parent_event_id as string;
              afterId = r.event_id as string;
              out.push(afterId);
            }
          }
        }
        return out;
      },
    };
  }

  it("101 owners (overflow at the group edge), 501 by-id requests with absent ids, 1,001 parents: same results, RPC arguments and guards", async () => {
    const now = source();
    const old = source();
    const reader = rpcFrozenReader(now.client, REF, { beforeRead: async () => void now.guards.n++ });
    const ref = pre4b(old.client);
    const m = await reader.members(OWN, 3);
    const mo = await ref.members(OWN, 3);
    expect([...m.entries()].map(([k, v]) => [k, v.map((e) => e.id)])).toEqual([...mo.entries()]);
    expect([...m.values()][99].length).toBe(4); // cap+1 at the last owner of group 0
    const b = await reader.byIds([...IDS].reverse());
    expect([...b.keys()]).toEqual(await ref.byIds([...IDS].reverse()));
    expect(b.size).toBe(PRESENT.size);
    const kids: string[] = [];
    for await (const e of reader.children([...PARENTS].reverse())) kids.push(e.id);
    expect(kids).toEqual(await ref.children([...PARENTS].reverse()));
    expect(now.calls).toEqual(old.calls);
    expect(now.guards.n).toBe(now.calls.length);
    expect(new Set(now.calls.filter((c) => c.fn === "read_reporting_owner_members").map((c) => (c.args.p_owners as unknown[]).length))).toEqual(new Set([100, 1]));
    expect(new Set(now.calls.filter((c) => c.fn === "read_reporting_children").map((c) => (c.args.p_parent_ids as unknown[]).length))).toEqual(new Set([1000, 1]));
  });

  it("a malformed trailing row fails its whole page before any of its rows is used (members and children)", async () => {
    const m = source({ fn: "read_reporting_owner_members", call: 1, row: 6 });
    await expect(rpcFrozenReader(m.client, REF).members(OWN, 3)).rejects.toThrow(/bad owner_index/);
    const c = source({ fn: "read_reporting_children", call: 1, row: 39 });
    const seen: string[] = [];
    await expect((async () => {
      for await (const e of rpcFrozenReader(c.client, REF).children(PARENTS)) seen.push(e.id);
    })()).rejects.toThrow(/another parent/);
    expect(seen).toEqual([]); // no row of the malformed page was yielded
  });
});
