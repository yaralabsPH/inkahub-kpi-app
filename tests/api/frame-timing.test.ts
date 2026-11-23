/** F9: GET /api/reports/timing handler (no database). */
import { describe, expect, it, vi } from "vitest";
import { createTimingHandler } from "../../api/reports/timing";
import { parseTimingRows } from "../../api/_lib/frame-timing";
import type { AuthDeps, GenerationMeta, PublishedReader } from "../../api/_lib/production-reporting";
import type { RpcClient } from "../../api/_lib/reporting-jobs";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const GEN = "99999999-9999-4999-8999-999999999999";
const gen: GenerationMeta = { generationId: GEN, site: "au", state: "published", complete: true, ruleVersion: "r1", sourceCutoffUtc: "2026-11-22T23:00:00Z", verifiedAtUtc: "2026-11-22T23:01:00Z", publishedAtUtc: "2026-11-22T23:02:00Z", expiresAtUtc: null, readMode: "summary" };
const ROW = (id: string, at: string, pieces: number | string) => [id, U1, at, "2026-11-22", "verify", "framed", "INKA-ABC0003-A3-FN", pieces, true, false, null];

function setup(role: string, opts: { nav?: unknown; rows?: unknown[]; rpcError?: string; generation?: GenerationMeta | null } = {}) {
  const rpc = vi.fn(async () => (opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: { rows: opts.rows ?? [], weights: { version: 2, weights: { A3: 1 } } }, error: null }));
  const generation = vi.fn(async () => (opts.generation === undefined ? gen : opts.generation));
  const reader = { generation } as unknown as PublishedReader;
  const auth: AuthDeps = { getUser: async () => U1, profile: async () => ({ role, allowed_nav: opts.nav ?? null }), memberships: async () => ["au"] };
  const handler = createTimingHandler({ auth: () => auth, service: () => ({ reader, rpc: { rpc } as unknown as RpcClient }), now: () => Date.parse("2026-11-23T00:00:00Z") });
  const call = async (query: Record<string, string>, method = "GET", headers: Record<string, string> = { authorization: "Bearer aaa.bbb.ccc" }) => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const res = { setHeader: () => res, status: (s: number) => ({ json: (b: unknown) => { status = s; body = b as Record<string, unknown>; } }) };
    await handler({ method, headers, query }, res);
    return { status, body };
  };
  return { call, rpc, generation };
}
const Q = { site: "au", firstDate: "2026-11-22", lastDate: "2026-11-22", generationId: GEN };

describe("GET /api/reports/timing", () => {
  it("401 first, 405, 400 without the pinned generation or with unknown parameters", async () => {
    const s = setup("owner");
    expect((await s.call(Q, "GET", {})).status).toBe(401);
    expect((await s.call(Q, "POST")).status).toBe(405);
    const { generationId: _g, ...noGen } = Q;
    expect((await s.call(noGen)).status).toBe(400);
    expect((await s.call({ ...Q, generationId: "latest" })).status).toBe(400);
    expect((await s.call({ ...Q, rate: "1" })).status).toBe(400);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("reads exactly the pinned generation (never latest) and returns aggregates only", async () => {
    const s = setup("owner", { rows: [ROW("a", "2026-11-22T09:00:00.000000Z", 1), ROW("b", "2026-11-22T09:04:00.000000Z", 1)] });
    const r = await s.call(Q);
    expect(r.status).toBe(200);
    expect(s.generation).toHaveBeenCalledWith("au", GEN);
    expect(s.rpc).toHaveBeenCalledWith("read_frame_timing_rows", expect.objectContaining({ p_generation: GEN, p_audience_kind: "site", p_row_limit: 50000 }));
    const groups = r.body.groups as Array<Record<string, unknown>>;
    expect(groups[0]).toMatchObject({ key: "A3-FN", timedPieces: 1, measuredMinutes: 4 });
    expect(JSON.stringify(r.body)).not.toContain('"rows"');
    expect(r.body.weights).toEqual({ version: 2, weights: { A3: 1 } });
  });
  it("an expired pin is 410; staff forced to self, forged person 403; kiosk 403; too many rows TOO_LARGE", async () => {
    expect((await setup("owner", { generation: null }).call(Q)).status).toBe(410);
    const staff = setup("staff");
    expect((await staff.call(Q)).status).toBe(200);
    expect(staff.rpc).toHaveBeenCalledWith("read_frame_timing_rows", expect.objectContaining({ p_audience_kind: "self", p_audience_staff: U1 }));
    expect((await setup("staff").call({ ...Q, staffId: U2 })).status).toBe(403);
    expect((await setup("kiosk", { nav: ["order_submission", "reports"] }).call(Q)).status).toBe(403);
    const big = await setup("owner", { rpcError: "read_frame_timing_rows: 60000 rows exceed the limit 50000" }).call(Q);
    expect([big.status, big.body.code]).toEqual([503, "TOO_LARGE"]);
  });
  it("row parsing refuses malformed rows and stored weights", () => {
    expect(() => parseTimingRows({ rows: [["x"]], weights: null })).toThrow();
    expect(() => parseTimingRows({ rows: [], weights: { version: 1, weights: { A9: 1 } } })).toThrow();
    expect(parseTimingRows({ rows: [ROW("a", "2026-11-22T09:00:00Z", "2")], weights: null }).rows[0].pieces).toBe(2); // numeric text from jsonb
  });
});
