/**
 * Handler tests for api/reports/daily-digest.ts.
 *
 * Supabase, XLSX and global fetch are mocked; no real database, email
 * service or credentials are used. All secrets/addresses are synthetic.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------
 * Mocks (hoisted above the handler import)
 * ------------------------------------------------------------------ */
type Row = Record<string, unknown>;
type Op = [string, unknown[]];
interface QueryRecord { table: string; ops: Op[] }

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Row[]>,
    tableErrors: {} as Record<string, { message: string }>,
    queries: [] as QueryRecord[],
  };

  function applyFilters(rows: Row[], ops: Op[]): Row[] {
    return rows.filter((row) =>
      ops.every(([op, args]) => {
        const field = String(args[0]);
        const v = row[field];
        switch (op) {
          case "eq": return v === args[1];
          case "gte": return String(v) >= String(args[1]);
          case "lt": return typeof args[1] === "number" ? Number(v) < args[1] : String(v) < String(args[1]);
          case "in": return (args[1] as unknown[]).includes(v);
          default: return true;
        }
      }),
    );
  }

  function makeQuery(table: string) {
    const rec: QueryRecord = { table, ops: [] };
    state.queries.push(rec);
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt", "in"]) {
      q[m] = (...args: unknown[]) => {
        if (m !== "select") rec.ops.push([m, args]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const err = state.tableErrors[table];
      const result = err
        ? { data: null, error: err }
        : { data: applyFilters(state.tables[table] ?? [], rec.ops), error: null };
      return Promise.resolve(result).then(resolve, reject);
    };
    return q;
  }

  const createClient = vi.fn((_url: string, _key: string) => ({
    from: vi.fn((table: string) => makeQuery(table)),
  }));

  const utils = {
    aoa_to_sheet: vi.fn((rows: unknown[][]) => ({ __rows: rows })),
    book_new: vi.fn(() => ({ sheets: [] as Array<{ name: string; sheet: unknown }> })),
    book_append_sheet: vi.fn((wb: { sheets: Array<{ name: string; sheet: unknown }> }, sheet: unknown, name: string) => {
      wb.sheets.push({ name, sheet });
    }),
  };
  const write = vi.fn(() => new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer);

  return { state, createClient, utils, write };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: h.createClient }));
vi.mock("xlsx", () => ({ utils: h.utils, write: h.write }));

import handler from "../../api/reports/daily-digest";

/* ------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------ */
type Req = Parameters<typeof handler>[0];
type Res = Parameters<typeof handler>[1];

interface Recorded {
  status: number | null;
  headers: Record<string, string>;
  json: unknown;
  sent: unknown;
}

function makeRes(): { res: Res; out: Recorded } {
  const out: Recorded = { status: null, headers: {}, json: undefined, sent: undefined };
  const res: Res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.json = body; },
    send(body: string | Buffer) { out.sent = body; },
    setHeader(name: string, value: string) { out.headers[name.toLowerCase()] = value; },
  };
  return { res, out };
}

async function call(
  opts: { method?: string; headers?: Req["headers"]; query?: Req["query"]; extra?: Record<string, unknown> } = {},
): Promise<Recorded> {
  const req: Req & Record<string, unknown> = {
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    ...(opts.extra ?? {}),
  };
  const { res, out } = makeRes();
  await handler(req, res);
  return out;
}

const SECRET = "test-cron-secret-0123456789abcdef";
const AUTH = { authorization: `Bearer ${SECRET}` };

const ENV_KEYS = [
  "CRON_SECRET", "REPORT_RECIPIENT", "REPORT_RECIPIENT_ALLOWLIST", "RESEND_API_KEY", "FROM_EMAIL",
  "VITE_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "VITE_SUPABASE_ANON_KEY",
] as const;
type EnvKey = typeof ENV_KEYS[number];
let envSnapshot: Partial<Record<EnvKey, string | undefined>> = {};

function setEnv(values: Partial<Record<EnvKey, string | undefined>>) {
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const BASE_ENV: Partial<Record<EnvKey, string>> = {
  CRON_SECRET: SECRET,
  REPORT_RECIPIENT: "default-inbox@example.test",
  RESEND_API_KEY: "re_test_key",
  FROM_EMAIL: "reports@example.test",
  SUPABASE_URL: "https://staging.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig",
};

const fetchMock = vi.fn(async (_input: unknown, _init?: unknown): Promise<unknown> => {
  throw new Error("unexpected network call");
});

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) { envSnapshot[k] = process.env[k]; delete process.env[k]; }
  setEnv(BASE_ENV);
  h.state.tables = {};
  h.state.tableErrors = {};
  h.state.queries = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  setEnv(envSnapshot);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => { throw new Error("unexpected network call"); });
});

/** Asserts that the request reached no database, network or workbook code. */
function expectNoWork() {
  expect(h.createClient).not.toHaveBeenCalled();
  expect(h.state.queries).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(h.utils.aoa_to_sheet).not.toHaveBeenCalled();
  expect(h.utils.book_new).not.toHaveBeenCalled();
  expect(h.utils.book_append_sheet).not.toHaveBeenCalled();
  expect(h.write).not.toHaveBeenCalled();
}

function expectUnauthorized(out: Recorded) {
  expect(out.status).toBe(401);
  expect(out.json).toEqual({ error: "Unauthorized" });
  expect(out.headers["cache-control"]).toBe("no-store");
  expect(out.sent).toBeUndefined();
  expectNoWork();
}

/* ------------------------------------------------------------------
 * Task 1: authentication and method guard
 * ------------------------------------------------------------------ */
const QUERY_VARIANTS: Array<[string, Req["query"]]> = [
  ["ordinary", { location: "au" }],
  ["force", { location: "au", force: "1" }],
  ["dry", { location: "uk", dry: "1" }],
  ["envcheck", { envcheck: "1" }],
  ["rolecheck", { rolecheck: "1" }],
  ["recipient", { location: "us", recipient: "someone@example.test" }],
  ["combined", { location: "au", date: "2026-11-10", force: "1", dry: "1", envcheck: "1", rolecheck: "1", recipient: "x@example.test" }],
  ["invalid location", { location: "zz" }],
  ["invalid recipient", { location: "au", recipient: "not-an-email" }],
];

const BAD_HEADERS: Array<[string, Req["headers"]]> = [
  ["missing header", {}],
  ["wrong secret", { authorization: "Bearer wrong-secret" }],
  ["array header", { authorization: [`Bearer ${SECRET}`, `Bearer ${SECRET}`] }],
  ["one-element array", { authorization: [`Bearer ${SECRET}`] }],
  ["duplicate case-variant fields", { authorization: `Bearer ${SECRET}`, Authorization: `Bearer ${SECRET}` }],
  ["comma-joined credentials", { authorization: `Bearer ${SECRET}, Bearer ${SECRET}` }],
  ["token prefix", { authorization: `Bearer ${SECRET.slice(0, -1)}` }],
  ["token suffix", { authorization: `Bearer ${SECRET}x` }],
  ["trailing space", { authorization: `Bearer ${SECRET} ` }],
  ["wrong scheme", { authorization: `Basic ${SECRET}` }],
  ["lowercase scheme", { authorization: `bearer ${SECRET}` }],
  ["no scheme", { authorization: SECRET }],
  ["empty credential", { authorization: "Bearer " }],
  ["empty header", { authorization: "" }],
  ["literal undefined", { authorization: "Bearer undefined" }],
  ["spoofed cron header", { "x-vercel-cron": "1", "user-agent": "vercel-cron/1.0" }],
  ["secret in other header", { "x-cron-secret": SECRET, cookie: `cron_secret=${SECRET}` }],
  ...(["owner", "manager", "staff", "kiosk", "cs"] as const).map(
    (role): [string, Req["headers"]] => [`app token (${role})`, { authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "authenticated", app_role: role })).toString("base64url")}.sig` }],
  ),
];

describe("daily-digest authentication", () => {
  for (const [label, headers] of BAD_HEADERS) {
    for (const [qlabel, query] of QUERY_VARIANTS) {
      it(`rejects ${label} (${qlabel})`, async () => {
        expectUnauthorized(await call({ headers, query }));
      });
    }
  }

  for (const secret of [undefined, "", "   ", "\t\n"]) {
    for (const [hlabel, headers] of [
      ["no header", {}],
      ["Bearer undefined", { authorization: "Bearer undefined" }],
      ["Bearer (empty)", { authorization: "Bearer " }],
      ["Bearer + same blank value", { authorization: `Bearer ${secret ?? ""}` }],
      ["previous real secret", AUTH],
    ] as Array<[string, Req["headers"]]>) {
      it(`rejects everything when CRON_SECRET is ${JSON.stringify(secret)} (${hlabel})`, async () => {
        setEnv({ CRON_SECRET: secret });
        for (const [, query] of QUERY_VARIANTS) {
          expectUnauthorized(await call({ headers, query }));
        }
      });
    }
  }

  it("rejects a secret supplied in the query string, body or cookies", async () => {
    expectUnauthorized(await call({ query: { location: "au", secret: SECRET, cron_secret: SECRET, token: SECRET } }));
    expectUnauthorized(await call({ query: { location: "au" }, extra: { body: { secret: SECRET }, cookies: { cron_secret: SECRET } } }));
  });

  it("does not trim the configured secret for comparison", async () => {
    setEnv({ CRON_SECRET: ` ${SECRET} ` });
    expectUnauthorized(await call({ headers: AUTH, query: { envcheck: "1" } }));
    const ok = await call({ headers: { authorization: `Bearer  ${SECRET} ` }, query: { envcheck: "1" } });
    expect(ok.status).toBe(200);
  });

  it("accepts the header name in any casing", async () => {
    for (const name of ["authorization", "Authorization", "AUTHORIZATION"]) {
      const out = await call({ headers: { [name]: `Bearer ${SECRET}` }, query: { envcheck: "1" } });
      expect(out.status).toBe(200);
    }
  });

  for (const method of ["POST", "HEAD", "PUT", "DELETE", "PATCH"]) {
    it(`rejects unauthenticated ${method} with 401 (not 405)`, async () => {
      expectUnauthorized(await call({ method, query: { location: "au" } }));
      expectUnauthorized(await call({ method, headers: { authorization: "Bearer nope" }, query: { location: "zz", recipient: "bad" } }));
    });

    it(`rejects authenticated ${method} with 405 and no work`, async () => {
      const out = await call({ method, headers: AUTH, query: { location: "au", dry: "1", envcheck: "1", recipient: "bad" } });
      expect(out.status).toBe(405);
      expect(out.headers.allow).toBe("GET");
      expect(out.headers["cache-control"]).toBe("no-store");
      expect(out.json).toEqual({ error: "Method not allowed" });
      expectNoWork();
    });
  }
});

describe("daily-digest diagnostics behind the guard", () => {
  it("envcheck works with the secret and never exposes it", async () => {
    const out = await call({ headers: AUTH, query: { envcheck: "1" } });
    expect(out.status).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.json).toMatchObject({ RESEND_API_KEY: expect.any(String), SUPABASE_URL: "PRESENT" });
    const text = JSON.stringify(out.json);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(SECRET.slice(0, 5));
    expect(text).not.toContain("CRON_SECRET");
    expect(text.toLowerCase()).not.toContain("authorization");
    expectNoWork();
  });

  it("rolecheck works with the secret using only its mocked REST call", async () => {
    fetchMock.mockImplementationOnce(async () => ({ status: 200, text: async () => "[]" }));
    const out = await call({ headers: AUTH, query: { rolecheck: "1" } });
    expect(out.status).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.json).toMatchObject({ raw_fetch_status: 200, raw_fetch_body: "[]", jwt_payload: { role: "service_role" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://staging.example.test/rest/v1/production_events?select=id&limit=1");
    const text = JSON.stringify(out.json);
    expect(text).not.toContain(SECRET);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it("does not log the authorization header or secret", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await call({ headers: AUTH, query: { envcheck: "1" } });
    await call({ headers: { authorization: "Bearer wrong" }, query: { location: "au" } });
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
      s.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------
 * Fixtures shared by the authorized-path tests
 * ------------------------------------------------------------------ */
const RESEND_URL = "https://api.resend.com/emails";

/**
 * A UTC instant on local day `ymd` that also falls inside the window the
 * handler currently queries. NOTE: the existing localDayRangeUtc returns
 * the UTC calendar day for AU/UK and the *next* UTC day for US (pre-existing
 * behaviour, out of scope for digest-auth; see the plan's Open questions),
 * so these instants are chosen to sit in both windows and not codify it.
 */
function middayUtc(location: string, ymd: string): string {
  if (location === "au") return `${ymd}T01:00:00.000Z`; // ~12:00 Sydney
  if (location === "uk") return `${ymd}T12:00:00.000Z`; // ~12:00 London
  return `${shiftYmd(ymd, 1)}T02:00:00.000Z`;           // ~20:00 Chicago on ymd
}

function seedActivity(location: string, ymd: string, staffId = "staff-0001-aaaa") {
  const ts = middayUtc(location, ymd);
  const rows: Row[] = [
    { id: `${location}-${ymd}-d`, staff_id: staffId, department: "dispatch", order_number: `#${ymd}-1`, line_sku: null, line_quantity: null, event_type: "dispatched", parent_event_id: null, created_at: ts, location },
    { id: `${location}-${ymd}-v`, staff_id: staffId, department: "dispatch", order_number: `#${ymd}-1`, line_sku: "INKA-AB1234-A3-FN", line_quantity: 2, event_type: "line_verified", parent_event_id: null, created_at: ts, location },
  ];
  h.state.tables.production_events = [...(h.state.tables.production_events ?? []), ...rows];
  h.state.tables.staff_barcodes = [
    ...(h.state.tables.staff_barcodes ?? []),
    { user_id: staffId, display_name: "Test Staffer", location },
  ];
}

function mockResendOk() {
  fetchMock.mockImplementation(async (input: unknown) => {
    if (String(input) === RESEND_URL) return { ok: true, status: 200, text: async () => "{}" };
    throw new Error(`unexpected network call to ${String(input)}`);
  });
}

interface ResendBody { from: string; to: string[]; subject: string; attachments: Array<{ filename: string; content: string }> }
function resendCalls(): ResendBody[] {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]) === RESEND_URL)
    .map((c) => JSON.parse(String((c[1] as { body: string }).body)) as ResendBody);
}

/** Asserts that a rejected request touched no database, network or workbook code. */
function expectRejected(out: Recorded, status: number, error: string) {
  expect(out.status).toBe(status);
  expect(out.json).toEqual({ error });
  expect(out.headers["cache-control"]).toBe("no-store");
  expect(out.sent).toBeUndefined();
  expectNoWork();
}

/* ------------------------------------------------------------------
 * Task 2: recipient policy
 * ------------------------------------------------------------------ */
const DAY = "2026-11-10";
const ALLOW = "ops-test@example.test, second+tag@example.test";

describe("daily-digest recipient overrides", () => {
  beforeEach(() => {
    setEnv({ REPORT_RECIPIENT_ALLOWLIST: ALLOW });
    seedActivity("au", DAY);
    mockResendOk();
  });

  it.each([
    ["ops-test@example.test", "ops-test@example.test"],
    ["  OPS-Test@Example.TEST  ", "ops-test@example.test"],
    ["Second+Tag@example.test", "second+tag@example.test"],
  ])("sends an allowlisted override %j to the normalized address", async (raw, expected) => {
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: raw } });
    expect(out.status).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    const sent = resendCalls();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([expected]);
  });

  it("works with an allowlisted override even without a default recipient", async () => {
    setEnv({ REPORT_RECIPIENT: undefined });
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "ops-test@example.test" } });
    expect(out.status).toBe(200);
    expect(resendCalls()[0].to).toEqual(["ops-test@example.test"]);
  });

  it.each([
    ["not on the list", "stranger@example.test"],
    ["plus-address of a listed address", "ops-test+x@example.test"],
    ["suffix lookalike", "ops-test@example.test.evil.test"],
    ["prefix lookalike", "xops-test@example.test"],
    ["same domain", "anyone@example.test"],
    ["the default address itself", "default-inbox@example.test"],
  ])("rejects an override (%s) with 403", async (_label, raw) => {
    expectRejected(await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: raw } }), 403, "Recipient not allowed");
  });

  const INVALID: Array<[string, string | string[]]> = [
    ["empty", ""],
    ["whitespace", "   "],
    ["no at-sign", "not-an-email"],
    ["missing domain", "a@"],
    ["display name", "Ops <ops-test@example.test>"],
    ["quoted", '"ops-test@example.test"'],
    ["comma list", "ops-test@example.test,second+tag@example.test"],
    ["semicolon list", "ops-test@example.test;second+tag@example.test"],
    ["space list", "ops-test@example.test second+tag@example.test"],
    ["newline injection", "ops-test@example.test\nBcc: x@example.test"],
    ["embedded CR", "ops-test@example.test\rBcc: x@example.test"],
    ["embedded tab", "ops-test\t@example.test"],
    ["control character", "ops-test\u0000@example.test"],
    ["repeated parameter", ["ops-test@example.test", "ops-test@example.test"]],
    ["single-element array", ["ops-test@example.test"]],
  ];
  for (const [label, raw] of INVALID) {
    it(`rejects an invalid override (${label}) with 400`, async () => {
      expectRejected(await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: raw } }), 400, "Invalid recipient");
    });
  }

  it("ignores blank allowlist entries", async () => {
    setEnv({ REPORT_RECIPIENT_ALLOWLIST: " , ops-test@example.test ,, " });
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "ops-test@example.test" } });
    expect(out.status).toBe(200);
  });

  for (const list of [undefined, "", " , , "]) {
    it(`denies all overrides when the allowlist is ${JSON.stringify(list)}`, async () => {
      setEnv({ REPORT_RECIPIENT_ALLOWLIST: list });
      expectRejected(await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "ops-test@example.test" } }), 403, "Recipient not allowed");
    });
  }

  for (const list of ["ops-test@example.test, not-an-email", "*@example.test", "@example.test", "Ops <ops-test@example.test>", "ops-test@example.test; second+tag@example.test"]) {
    it(`fails overrides closed with 500 for malformed allowlist ${JSON.stringify(list)}`, async () => {
      setEnv({ REPORT_RECIPIENT_ALLOWLIST: list });
      const out = await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "ops-test@example.test" } });
      expectRejected(out, 500, "Recipient configuration error");
    });
  }

  const OPERATIONS: Array<[string, Req["query"]]> = [
    ["dry", { location: "au", date: DAY, dry: "1" }],
    ["envcheck", { envcheck: "1" }],
    ["rolecheck", { rolecheck: "1" }],
    ["force", { location: "au", date: DAY, force: "1" }],
    ["no-activity day", { location: "au", date: "2026-01-01" }],
    ["invalid location", { location: "zz" }],
  ];
  for (const [olabel, query] of OPERATIONS) {
    it(`validates the override before ${olabel}`, async () => {
      expectRejected(await call({ headers: AUTH, query: { ...query, recipient: "stranger@example.test" } }), 403, "Recipient not allowed");
      expectRejected(await call({ headers: AUTH, query: { ...query, recipient: "bad" } }), 400, "Invalid recipient");
      setEnv({ REPORT_RECIPIENT_ALLOWLIST: "broken" });
      expectRejected(await call({ headers: AUTH, query: { ...query, recipient: "ops-test@example.test" } }), 500, "Recipient configuration error");
    });
  }

  it("keeps auth (401) and method (405) ahead of recipient validation", async () => {
    setEnv({ REPORT_RECIPIENT_ALLOWLIST: "broken" });
    expectUnauthorized(await call({ query: { location: "au", recipient: "bad" } }));
    const out = await call({ method: "POST", headers: AUTH, query: { location: "au", recipient: "bad" } });
    expect(out.status).toBe(405);
    expectNoWork();
  });

  it("error bodies never echo the submitted address or the allowlist", async () => {
    for (const recipient of ["stranger@example.test", "bad", ""]) {
      const out = await call({ headers: AUTH, query: { location: "au", date: DAY, recipient } });
      const text = JSON.stringify(out.json);
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("ops-test");
    }
  });
});

describe("daily-digest default recipient", () => {
  beforeEach(() => {
    seedActivity("au", DAY);
    mockResendOk();
  });

  for (const list of [undefined, "", "broken, also-broken"]) {
    it(`sends to REPORT_RECIPIENT regardless of allowlist ${JSON.stringify(list)}`, async () => {
      setEnv({ REPORT_RECIPIENT_ALLOWLIST: list, REPORT_RECIPIENT: "  default-inbox@example.test " });
      const out = await call({ headers: AUTH, query: { location: "au", date: DAY } });
      expect(out.status).toBe(200);
      expect(resendCalls().map((c) => c.to)).toEqual([["default-inbox@example.test"]]);
    });
  }

  for (const value of [undefined, "", "   ", "not-an-email", "a@example.test, b@example.test", "Ops <a@example.test>"]) {
    it(`refuses to email when REPORT_RECIPIENT is ${JSON.stringify(value)}`, async () => {
      setEnv({ REPORT_RECIPIENT: value });
      for (const query of [{ location: "au", date: DAY }, { location: "au", date: DAY, force: "1" }]) {
        const out = await call({ headers: AUTH, query });
        expect(out.status).toBe(500);
        expect(out.json).toEqual({ error: "Recipient configuration error" });
        expect(out.headers["cache-control"]).toBe("no-store");
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(`still serves downloads, diagnostics and skips when REPORT_RECIPIENT is ${JSON.stringify(value)}`, async () => {
      setEnv({ REPORT_RECIPIENT: value });
      const dry = await call({ headers: AUTH, query: { location: "au", date: DAY, dry: "1" } });
      expect(dry.status).toBe(200);
      expect(dry.sent).toBeInstanceOf(Buffer);
      const env = await call({ headers: AUTH, query: { envcheck: "1" } });
      expect(env.status).toBe(200);
      const skip = await call({ headers: AUTH, query: { location: "au", date: "2026-01-01" } });
      expect(skip.status).toBe(200);
      expect(skip.json).toMatchObject({ skipped: "no activity" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});

/* ------------------------------------------------------------------
 * Task 3: authorized compatibility
 * ------------------------------------------------------------------ */
const LOCS = [
  // Scheduled UTC fire time (from vercel.json) and the local day it closes,
  // plus a time after the 04:00 local cutoff and the day it selects.
  { loc: "au", label: "AU", cronNow: "2026-11-10T13:55:00Z", cronYmd: "2026-11-10", afterNow: "2026-11-10T20:00:00Z", afterYmd: "2026-11-11" },
  { loc: "uk", label: "UK", cronNow: "2026-11-10T22:55:00Z", cronYmd: "2026-11-10", afterNow: "2026-11-11T02:30:00Z", afterYmd: "2026-11-10" },
  { loc: "us", label: "US", cronNow: "2026-11-10T04:55:00Z", cronYmd: "2026-11-09", afterNow: "2026-11-10T08:30:00Z", afterYmd: "2026-11-09" },
] as const;

function ddmmyy(ymd: string) { return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(2, 4)}`; }

function shiftYmd(ymd: string, days: number) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function expectLocationFilters(loc: string) {
  expect(h.state.queries.length).toBeGreaterThan(0);
  for (const q of h.state.queries) {
    expect(q.ops).toContainEqual(["eq", ["location", loc]]);
  }
}

function sheetNames(): string[] {
  return h.utils.book_append_sheet.mock.calls.map((c) => String(c[2]));
}

/** Rows passed to aoa_to_sheet, in the order Summary, Departments, Staff, Notes. */
function sheetRows(index: number): unknown[][] {
  return h.utils.aoa_to_sheet.mock.calls[index][0];
}

describe("daily-digest authorized reports (compatibility)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockResendOk();
  });
  afterEach(() => { vi.useRealTimers(); });

  for (const L of LOCS) {
    it(`${L.label}: scheduled-style request (bearer + location only) closes the right day`, async () => {
      vi.setSystemTime(new Date(L.cronNow));
      seedActivity(L.loc, L.cronYmd);
      seedActivity(L.loc, shiftYmd(L.cronYmd, -1), "staff-0002-bbbb");
      const out = await call({ headers: AUTH, query: { location: L.loc } });
      expect(out.status).toBe(200);
      expect(out.headers["cache-control"]).toBe("no-store");
      expect(out.json).toMatchObject({
        ok: true,
        subject: `${L.label}-${ddmmyy(L.cronYmd)}-Daily KPI Report`,
        recipient: "default-inbox@example.test",
        ymd: L.cronYmd,
        location: L.loc,
        counts: { orders_today: 1, items_today: 2, staff_today: 1 },
      });
      const sent = resendCalls();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        from: "reports@example.test",
        to: ["default-inbox@example.test"],
        subject: `${L.label}-${ddmmyy(L.cronYmd)}-Daily KPI Report`,
      });
      expect(sent[0].attachments.map((a) => a.filename)).toEqual([`${L.label}-KPI-${L.cronYmd}.xlsx`]);
      expect(sent[0].attachments[0].content).toBe(Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64"));
      expectLocationFilters(L.loc);

      expect(sheetNames()).toEqual(["Summary", "Departments", "Staff", "Notes"]);
      const summary = sheetRows(0);
      expect(summary[1].slice(0, 8)).toEqual([L.cronYmd, L.label, 1, 2, 1, 2, 1, 1]);
      const staff = sheetRows(2);
      expect(staff.some((r) => r.includes("Test Staffer"))).toBe(true);
    });

    it(`${L.label}: default date after the 04:00 local cutoff`, async () => {
      vi.setSystemTime(new Date(L.afterNow));
      seedActivity(L.loc, L.afterYmd);
      const out = await call({ headers: AUTH, query: { location: L.loc } });
      expect(out.status).toBe(200);
      expect(out.json).toMatchObject({ ymd: L.afterYmd });
    });

    it(`${L.label}: manual dated rerun`, async () => {
      vi.setSystemTime(new Date("2026-11-11T09:00:00Z"));
      seedActivity(L.loc, "2026-10-05");
      const out = await call({ headers: AUTH, query: { location: L.loc, date: "2026-10-05" } });
      expect(out.status).toBe(200);
      expect(out.json).toMatchObject({ ymd: "2026-10-05", location: L.loc, counts: { orders_today: 1, items_today: 2 } });
      expect(resendCalls()[0].attachments[0].filename).toBe(`${L.label}-KPI-2026-10-05.xlsx`);
      expectLocationFilters(L.loc);
    });

    it(`${L.label}: dry=1 downloads the xlsx and never emails`, async () => {
      seedActivity(L.loc, DAY);
      const out = await call({ headers: AUTH, query: { location: L.loc, date: DAY, dry: "1" } });
      expect(out.status).toBe(200);
      expect(out.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      expect(out.headers["content-disposition"]).toBe(`attachment; filename="${L.label}-KPI-${DAY}.xlsx"`);
      expect(out.headers["cache-control"]).toBe("no-store");
      expect(Buffer.isBuffer(out.sent)).toBe(true);
      expect([...(out.sent as Buffer)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }

  it("skips a zero-activity day without building a workbook or emailing", async () => {
    const out = await call({ headers: AUTH, query: { location: "uk", date: DAY } });
    expect(out.status).toBe(200);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(out.json).toEqual({
      ok: true,
      skipped: "no activity",
      location: "uk",
      ymd: DAY,
      note: "Zero orders and zero items across all departments; email suppressed. Pass ?force=1 to send anyway.",
    });
    expect(h.utils.book_new).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  for (const force of ["1", "true"]) {
    it(`force=${force} still sends on a zero-activity day`, async () => {
      const out = await call({ headers: AUTH, query: { location: "uk", date: DAY, force } });
      expect(out.status).toBe(200);
      expect(out.json).toMatchObject({ ok: true, counts: { orders_today: 0, items_today: 0 } });
      expect(resendCalls()).toHaveLength(1);
    });
  }

  it("dry still downloads on a zero-activity day", async () => {
    const out = await call({ headers: AUTH, query: { location: "uk", date: DAY, dry: "1" } });
    expect(out.status).toBe(200);
    expect(Buffer.isBuffer(out.sent)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps diagnostic precedence (rolecheck before envcheck before report) and never emails", async () => {
    fetchMock.mockImplementation(async () => ({ status: 200, text: async () => "[]" }));
    const both = await call({ headers: AUTH, query: { rolecheck: "1", envcheck: "1", location: "au", force: "1" } });
    expect(both.json).toHaveProperty("raw_fetch_status", 200);
    const env = await call({ headers: AUTH, query: { envcheck: "1", location: "au", force: "1" } });
    expect(env.json).toHaveProperty("RESEND_API_KEY");
    expect(resendCalls()).toHaveLength(0);
    expect(h.createClient).not.toHaveBeenCalled();
  });
});

describe("daily-digest error branches keep no-store and stay generic", () => {
  beforeEach(() => { mockResendOk(); seedActivity("au", DAY); });

  it("400 for an unknown location", async () => {
    const out = await call({ headers: AUTH, query: { location: "zz" } });
    expect(out.status).toBe(400);
    expect(out.headers["cache-control"]).toBe("no-store");
    expectNoWork();
  });

  it("500 when Supabase configuration is missing", async () => {
    setEnv({ SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined });
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY } });
    expect(out.status).toBe(500);
    expect(out.headers["cache-control"]).toBe("no-store");
    expectNoWork();
  });

  it("500 when the database query fails", async () => {
    h.state.tableErrors.production_events = { message: "boom" };
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY } });
    expect(out.status).toBe(500);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(out.json)).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("500 when RESEND_API_KEY is missing", async () => {
    setEnv({ RESEND_API_KEY: undefined });
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY } });
    expect(out.status).toBe(500);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("502 when Resend rejects the send", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 422, text: async () => "bad request" }));
    const out = await call({ headers: AUTH, query: { location: "au", date: DAY } });
    expect(out.status).toBe(502);
    expect(out.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(out.json)).not.toContain(SECRET);
  });

  it("logs nothing containing the secret or allowlist during a full send", async () => {
    setEnv({ REPORT_RECIPIENT_ALLOWLIST: ALLOW });
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "ops-test@example.test" } });
    await call({ headers: AUTH, query: { location: "au", date: DAY, recipient: "stranger@example.test" } });
    for (const s of spies) {
      const logged = JSON.stringify(s.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain("second+tag");
      s.mockRestore();
    }
  });
});

describe("vercel.json schedules are unchanged", () => {
  it("keeps the AU, UK and US cron entries exactly, with no secret in any path", () => {
    const raw = readFileSync(new URL("../../vercel.json", import.meta.url), "utf-8");
    const cfg = JSON.parse(raw) as { crons: Array<{ path: string; schedule: string }> };
    expect(cfg.crons).toEqual([
      { path: "/api/reports/daily-digest?location=au", schedule: "55 13 * * *" },
      { path: "/api/reports/daily-digest?location=uk", schedule: "55 22 * * *" },
      { path: "/api/reports/daily-digest?location=us", schedule: "55 4 * * *" },
    ]);
    expect(raw.toLowerCase()).not.toMatch(/secret|bearer|authorization|token/);
  });
});
