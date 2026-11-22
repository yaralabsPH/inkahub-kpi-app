/**
 * F6: /api/shopify/order completeness flags. Supabase auth and Shopify are
 * mocked; no network. Existing response fields must stay as they were.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) } }),
}));

import handler from "../../api/shopify/order";

interface Captured { status: number; body: Record<string, unknown> }

function call(orderNumber: string): Promise<Captured> {
  return new Promise((resolve) => {
    const out: Captured = { status: 0, body: {} };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body as Record<string, unknown>; resolve(out); },
      setHeader() {},
    };
    void handler({ method: "GET", headers: { authorization: "Bearer t" }, query: { order_number: orderNumber } }, res);
  });
}

const line = (sku: string, q = 1) => ({ node: { sku, title: "T", quantity: q, currentQuantity: q, variantTitle: null } });

function gqlOrder(over: { name?: string; hasNextPage?: boolean | null; lines?: unknown[] } = {}) {
  const lineItems: Record<string, unknown> = { edges: over.lines ?? [line("INKA-ABC0001-A2-FB", 2)] };
  if (over.hasNextPage !== null) lineItems.pageInfo = { hasNextPage: over.hasNextPage ?? false };
  return {
    data: { orders: { edges: [{ node: {
      id: "gid://1", name: over.name ?? "#10190203", legacyResourceId: "1", createdAt: "2026-11-20T00:00:00Z",
      cancelledAt: null, cancelReason: null, tags: ["A"], customer: null, fulfillments: [], lineItems,
    } }] } },
  };
}

let responses: unknown[] = [];
const fetchMock = vi.fn(async () => {
  const body = responses.shift();
  return new Response(JSON.stringify(body ?? {}), { status: 200 });
});

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://example.invalid";
  process.env.VITE_SUPABASE_ANON_KEY = "anon";
  process.env.SHOPIFY_SHOP_DOMAIN = "shop.example.invalid";
  process.env.SHOPIFY_ADMIN_TOKEN = "token";
  vi.stubGlobal("fetch", fetchMock);
  responses = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe("/api/shopify/order completeness", () => {
  it("a whole, exactly matching GraphQL order is complete; existing fields unchanged", async () => {
    responses = [gqlOrder()];
    const r = await call("10190203");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      found: true, complete: true, truncated: false, exact_match: true, lookup_source: "graphql",
      order_name: "#10190203", cancelled_at: null, tags: ["A"],
      line_items: [{ sku: "INKA-ABC0001-A2-FB", title: "T", quantity: 2, variant_title: null }],
    });
    // The query asks Shopify whether more line items exist.
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body));
    expect(sent.query).toMatch(/pageInfo \{ hasNextPage \}/);
  });

  it("more line items than returned: truncated, not complete", async () => {
    responses = [gqlOrder({ hasNextPage: true })];
    expect((await call("10190203")).body).toMatchObject({ found: true, truncated: true, complete: false });
  });

  it("no page info at all is treated as truncated", async () => {
    responses = [gqlOrder({ hasNextPage: null })];
    expect((await call("10190203")).body).toMatchObject({ truncated: true, complete: false });
  });

  it("a different order returned by the search is not complete", async () => {
    responses = [gqlOrder({ name: "#101902030" })];
    expect((await call("10190203")).body).toMatchObject({ found: true, exact_match: false, complete: false });
  });

  it("the REST fallback is complete only for the exact order", async () => {
    const rest = (name: string) => ({ orders: [{ id: 9, name, created_at: "2026-01-01T00:00:00Z", cancelled_at: null, cancel_reason: null,
      tags: "", customer: null, fulfillments: [], line_items: [{ sku: "INKA-ABC0001-A2-FB", title: "T", quantity: 1, variant_title: null }] }] });
    responses = [{ data: { orders: { edges: [] } } }, rest("#10190203")];
    expect((await call("10190203")).body).toMatchObject({ found: true, complete: true, lookup_source: "rest" });
    responses = [{ data: { orders: { edges: [] } } }, rest("#10190999")];
    expect((await call("10190203")).body).toMatchObject({ found: true, complete: false, exact_match: false });
  });
});
