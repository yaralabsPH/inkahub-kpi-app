/** F11: Make part reports on /api/orders/timeline (no database, no network). */
import { describe, expect, it, vi } from "vitest";
import { createOrderTimelineHandler } from "../../api/orders/timeline";
import { authenticateMake, parseMakeScopes, validateEnvelope } from "../../api/_lib/make-milestones";
import type { AuthDeps } from "../../api/_lib/production-reporting";
import type { RpcClient } from "../../api/_lib/reporting-jobs";

const SHOP = "inka-staging-synthetic.myshopify.com";
const AU_KEY = "a".repeat(40);
const UK_KEY = "u".repeat(40);
const SCOPES = JSON.stringify({ "au-staging": { site: "au", shop: SHOP, secret: AU_KEY }, "uk-staging": { site: "uk", shop: SHOP, secret: UK_KEY } });
const NOW = Date.parse("2026-11-23T12:00:00Z");
const ENVELOPE = {
  schemaVersion: 1, stage: "submitted", occurrenceId: "p1:B1:v1", happenedAt: "2026-11-23T09:00:00+11:00", batchId: "B1", membershipVersion: 1,
  members: [{ memberKey: "m1", orderNumber: "#9001" }, { memberKey: "m2", orderNumber: "9002" }],
};

function setup(opts: { env?: Record<string, string | undefined>; rpc?: () => { data: unknown; error: { message: string } | null }; role?: string } = {}) {
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => (opts.rpc ? opts.rpc() : { data: { result: "accepted", reason: null, members: { attached: 0, pending: 2, resolved: 0, unresolved: 2 } }, error: null }));
  const auth: AuthDeps = { getUser: async () => "11111111-1111-4111-8111-111111111111", profile: async () => ({ role: opts.role ?? "owner", allowed_nav: null }), memberships: async () => ["au"] };
  const audit = vi.fn();
  const handler = createOrderTimelineHandler({ auth: () => auth, rpc: () => ({ rpc } as unknown as RpcClient), env: () => ({ ORDER_TIMELINE_INGEST: "on", MAKE_MILESTONE_SCOPES: SCOPES, ...opts.env }), fetch: vi.fn() as never, now: () => NOW, audit });
  const call = async (req: { method: string; headers: Record<string, string>; body?: unknown; query?: Record<string, string> }) => {
    let status = 0;
    let body: Record<string, unknown> = {};
    const res = { setHeader: () => res, status: (s: number) => ({ json: (b: unknown) => { status = s; body = b as Record<string, unknown>; } }) };
    await handler(req as never, res);
    return { status, body };
  };
  const report = (envelope: unknown, headers: Record<string, string> = {}) => {
    const raw = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
    return call({ method: "POST", body: Buffer.from(raw, "utf8"), headers: { "x-inka-make-scope": "au-staging", "x-inka-make-key": AU_KEY, "content-length": String(Buffer.byteLength(raw)), ...headers } });
  };
  return { call, report, rpc, audit };
}

describe("authentication before any parsing or database work", () => {
  it("missing, wrong or cross-scope keys are 401 with no RPC; malformed bodies are never parsed first", async () => {
    const keys: Array<Record<string, string>> = [{ "x-inka-make-key": "" }, { "x-inka-make-key": "b".repeat(40) }, { "x-inka-make-scope": "nope" },
      { "x-inka-make-scope": "uk-staging" }, // the AU key used against the UK scope: cross-site secret misuse
      { "x-inka-make-scope": "au-staging", "x-inka-make-key": UK_KEY }];
    for (const h of keys) {
      const s = setup();
      expect((await s.report("{not json", h)).status).toBe(401);
      expect(s.rpc).not.toHaveBeenCalled();
    }
  });
  it("unset/invalid scopes fail closed (503 CONFIG); ingestion off is 503 DISABLED; a second auth method is 400; GET is 405", async () => {
    for (const [env, code] of [[{ MAKE_MILESTONE_SCOPES: undefined }, "CONFIG"], [{ MAKE_MILESTONE_SCOPES: "{bad" }, "CONFIG"], [{ ORDER_TIMELINE_INGEST: "off" }, "DISABLED"]] as const) {
      const s = setup({ env });
      const r = await s.report(ENVELOPE);
      expect([r.status, r.body.code]).toEqual([503, code]);
      expect(s.rpc).not.toHaveBeenCalled();
    }
    const s = setup();
    expect((await s.report(ENVELOPE, { authorization: "Bearer aaa.bbb.ccc" })).status).toBe(400);
    expect((await s.report(ENVELOPE, { "x-shopify-hmac-sha256": "abc" })).status).toBe(400);
    expect((await s.call({ method: "GET", headers: { "x-inka-make-scope": "au-staging", "x-inka-make-key": AU_KEY } })).status).toBe(405);
    expect(s.rpc).not.toHaveBeenCalled();
  });
});

describe("bounded, strict envelopes", () => {
  it("oversized is 413; malformed, unknown fields (including site/shop) and stage-shape violations are 400 with no RPC", async () => {
    const s = setup();
    expect((await s.report(ENVELOPE, { "content-length": String(300 * 1024) })).status).toBe(413);
    expect((await s.report({ ...ENVELOPE, pad: "x".repeat(300 * 1024) }, { "content-length": "10" })).status).toBe(413);
    const bad: unknown[] = [
      "{not json", { ...ENVELOPE, schemaVersion: 2 }, { ...ENVELOPE, stage: "printed" }, { ...ENVELOPE, site: "uk" }, { ...ENVELOPE, shop: "other.myshopify.com" },
      { ...ENVELOPE, happenedAt: "2026-11-23T09:00:00" }, { ...ENVELOPE, happenedAt: "2026-11-23T13:00:00Z" }, // local time; future
      { ...ENVELOPE, occurrenceId: "a|b" }, { ...ENVELOPE, membershipVersion: 0 }, { ...ENVELOPE, members: [] },
      { ...ENVELOPE, members: Array.from({ length: 501 }, (_, i) => ({ memberKey: `k${i}`, orderNumber: `${i}` })) },
      { ...ENVELOPE, members: [{ memberKey: "m1", orderNumber: "1" }, { memberKey: "m1", orderNumber: "2" }] },
      { ...ENVELOPE, members: [{ memberKey: "m1", orderNumber: "1", shopifyOrderId: "5" }] },
      { ...ENVELOPE, stage: "files_found", members: [{ memberKey: "m1", shopifyOrderId: "gid://shopify/Order/5" }] },
      { ...ENVELOPE, stage: "planned", members: [{ memberKey: "m1", orderNumber: "1" }] },
    ];
    for (const b of bad) expect((await s.report(b)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect(s.rpc).not.toHaveBeenCalled();
  });
  it("a valid report passes ONLY the authenticated scope's site/shop with normalized aliases and UTC time", async () => {
    const s = setup();
    const r = await s.report(ENVELOPE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: "accepted", stage: "submitted", occurrenceId: "p1:B1:v1", members: { pending: 2 } });
    expect(s.rpc).toHaveBeenCalledWith("ingest_make_milestone", {
      p_site: "au", p_shop: SHOP, p_scope: "au-staging",
      p_envelope: { stage: "submitted", occurrenceId: "p1:B1:v1", happenedAt: "2026-11-22T22:00:00.000Z", batchId: "B1", membershipVersion: 1,
        members: [{ memberKey: "m1", orderNumber: "9001" }, { memberKey: "m2", orderNumber: "9002" }] },
    });
    expect(JSON.stringify(s.rpc.mock.calls)).not.toContain(AU_KEY);
  });
});

describe("durable acceptance before success", () => {
  it("conflicts are 409; a failed or unexpected transaction is 503, never acknowledged; identical retries are 200 duplicate", async () => {
    const c = setup({ rpc: () => ({ data: { result: "conflict", reason: "occurrence already recorded with different content", members: null }, error: null }) });
    expect(await c.report(ENVELOPE)).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
    expect(c.audit).toHaveBeenCalledWith(expect.objectContaining({ event: "make_conflict" }));
    const f = setup({ rpc: () => ({ data: null, error: { message: "could not serialize access" } }) });
    expect((await f.report(ENVELOPE)).status).toBe(503);
    const u = setup({ rpc: () => ({ data: { result: "maybe" }, error: null }) });
    expect((await u.report(ENVELOPE)).status).toBe(503);
    const d = setup({ rpc: () => ({ data: { result: "duplicate", reason: null, members: { attached: 1 } }, error: null }) });
    expect(await d.report(ENVELOPE)).toMatchObject({ status: 200, body: { result: "duplicate" } });
  });
});

describe("scope config and batch status read", () => {
  it("scopes need a normalized shop, a known site and a long secret; auth compares the whole key", () => {
    expect(parseMakeScopes(undefined)).toBeNull();
    for (const bad of ["[]", "{}", JSON.stringify({ x: { site: "nz", shop: SHOP, secret: AU_KEY } }), JSON.stringify({ x: { site: "au", shop: "Inka.myshopify.com", secret: AU_KEY } }),
      JSON.stringify({ x: { site: "au", shop: SHOP, secret: "short" } }), JSON.stringify({ "X Y": { site: "au", shop: SHOP, secret: AU_KEY } })]) {
      expect(() => parseMakeScopes(bad), bad).toThrow();
    }
    const scopes = parseMakeScopes(SCOPES)!;
    expect(authenticateMake({ "x-inka-make-scope": "au-staging", "x-inka-make-key": AU_KEY }, scopes)?.site).toBe("au");
    expect(authenticateMake({ "x-inka-make-scope": "au-staging", "x-inka-make-key": AU_KEY.slice(1) }, scopes)).toBeNull();
    expect(authenticateMake({ "x-inka-make-scope": "au-staging", "X-Inka-Make-Key": AU_KEY, "x-inka-make-key": AU_KEY }, scopes)).toBeNull(); // duplicated header
    expect(validateEnvelope({ ...ENVELOPE }, NOW).members[0].orderNumber).toBe("9001");
  });
  it("make_batch: staff/kiosk denied before any read; owner reads the site's configured shop", async () => {
    for (const role of ["staff", "kiosk"]) {
      const s = setup({ role });
      expect((await s.call({ method: "GET", headers: { authorization: "Bearer aaa.bbb.ccc" }, query: { action: "make_batch", site: "au", batchId: "B1" } })).status).toBe(403);
      expect(s.rpc).not.toHaveBeenCalled();
    }
    const s = setup({ rpc: () => ({ data: { batchId: "B1", members: [{ memberKey: "m2", status: "unresolved" }], occurrences: [] }, error: null }) });
    const r = await s.call({ method: "GET", headers: { authorization: "Bearer aaa.bbb.ccc" }, query: { action: "make_batch", site: "au", batchId: "B1" } });
    expect(r.status).toBe(200);
    expect(s.rpc).toHaveBeenCalledWith("read_make_batch", { p_site: "au", p_shop: SHOP, p_batch_id: "B1", p_limit: 1000 });
    expect(JSON.stringify(r.body)).not.toContain(AU_KEY);
    expect((await s.call({ method: "GET", headers: { authorization: "Bearer aaa.bbb.ccc" }, query: { action: "order", site: "au", orderNumber: "1", batchId: "B1" } })).status).toBe(400);
  });
});
