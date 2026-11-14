/**
 * Task 13 Part B2a: planning, sealing, bounded claims and single/bulk result
 * staging (0038 draft) and api/_lib/reporting-stage.ts.
 *
 * Unit tests prove (1) the byte-exact agreement between the TypeScript
 * builders and the SQL rules (hash input bytes, manifest lines and order),
 * (2) the staging rules on a reference model that mirrors 0038's
 * stage_one/check_staged_rows, and (3) the 0038 SQL text. Real execution is
 * the planner's staging rehearsal after B2b.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../src/lib/domain/productionReporting";
import { splitSqlStatements } from "../staging/sqlStatements";
import {
  buildChunks,
  claimPrefix,
  claimReportingWork,
  claimRowBytes,
  compareUtf8,
  descriptorProblem,
  isCalendarDate,
  manifestLine,
  MAX_BULK_ENTRIES,
  MAX_CLAIM_KEY_JSON_BYTES,
  packStageRequests,
  planReportingWork,
  reportingManifestHash,
  RESULT_COLUMNS,
  RESULT_TABLES,
  resultRowProblem,
  sealReportingWork,
  sortDescriptors,
  stageReportingResult,
  stageReportingResults,
  type ChunkEnvelope,
  type ResultRows,
  type ResultTable,
  type WorkDescriptor,
} from "../../api/_lib/reporting-stage";
import { ReportingJobError, type RpcClient } from "../../api/_lib/reporting-jobs";

const nodeSha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const H = (c: string) => c.repeat(64);
const STAFF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH = "5f0c1a7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";

// ---------------------------------------------------------------------------
// Byte-exact agreement
// ---------------------------------------------------------------------------

describe("cross-language hash agreement", () => {
  const tricky: ResultRows = {
    event_facts: [{ event_id: "é-ünïcode-😀", raw_order: " 5010 ", note: null, sku: "A4 21x30 cm / \"Framed\" \\ Print", staff_id: null, quantity: null, created_at: "2026-01-15T09:00:00.000400Z", ctrl: "\u0001\t\n" }],
    cancel_edges: [],
    order_occurrences: [],
    timing_facts: [],
    source_issue_facts: [{ event_id: "  ", event_type: "started", raw_order: null, staff_id: null, parent_event_id: " ", created_at: "2026-01-15T09:00:00Z", issue_kind: "invalid_event", issue_detail: "missing id or site" }],
  };

  it("chunkHash is SHA-256 of the canonical text's UTF-8 bytes — what SQL's convert_to(text, 'UTF8') hashes", () => {
    const [c] = buildChunks(tricky);
    expect(c.canonicalRows).toBe(canonicalJson(tricky));
    expect(Buffer.from(new TextEncoder().encode(c.canonicalRows)).equals(Buffer.from(c.canonicalRows, "utf8"))).toBe(true);
    expect(c.chunkHash).toBe(nodeSha(c.canonicalRows));
    expect(sha256Hex(c.canonicalRows)).toBe(nodeSha(c.canonicalRows));
    expect(c.resultDigest).toBe(nodeSha(c.chunkHash));
  });

  it("manifest lines escape exactly like PostgreSQL to_json (quotes, backslash, controls lowercase \\u00xx, Unicode raw, null staff)", () => {
    const d: WorkDescriptor = { audienceKind: "site", audienceStaff: null, partitionKind: "event", partitionKey: "ev \"q\" \\ \u0001\u001f\t\n é😀 ", inputHash: H("a") };
    expect(manifestLine(d)).toBe(`["site",null,"event","ev \\"q\\" \\\\ \\u0001\\u001f\\t\\n é😀 ","${H("a")}"]`);
    const self: WorkDescriptor = { audienceKind: "self", audienceStaff: STAFF, partitionKind: "order", partitionKey: "5010", inputHash: H("b") };
    expect(manifestLine(self)).toBe(`["self","${STAFF}","order","5010","${H("b")}"]`);
  });

  it("descriptor order is by UTF-8 bytes (COLLATE \"C\"), not UTF-16 code units; staff NULL first", () => {
    // U+FF5E (EF BD 9E) sorts before U+1F600 (F0 9F 98 80) in UTF-8, but after it in UTF-16.
    expect(compareUtf8("～", "😀")).toBeLessThan(0);
    expect("～" < "😀").toBe(false);
    expect(compareUtf8("Z", "a")).toBeLessThan(0);
    const mk = (kind: "site" | "self", staff: string | null, key: string): WorkDescriptor => ({ audienceKind: kind, audienceStaff: staff, partitionKind: "event", partitionKey: key, inputHash: H("c") });
    const sorted = sortDescriptors([mk("site", null, "😀"), mk("self", STAFF, "x"), mk("site", null, "～"), mk("self", "11111111-1111-4111-8111-111111111111", "x")]);
    expect(sorted.map((d) => `${d.audienceKind}:${d.audienceStaff ?? "-"}:${d.partitionKey}`)).toEqual([
      "self:11111111-1111-4111-8111-111111111111:x",
      `self:${STAFF}:x`,
      "site:-:～",
      "site:-:😀",
    ]);
  });

  it("the manifest hash is order-independent in input, and a zero-work seal hashes the empty string", () => {
    const a: WorkDescriptor = { audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", inputHash: H("1") };
    const b: WorkDescriptor = { audienceKind: "site", audienceStaff: null, partitionKind: "event", partitionKey: "ev-9", inputHash: H("2") };
    expect(reportingManifestHash([a, b])).toBe(reportingManifestHash([b, a]));
    expect(reportingManifestHash([a, b])).toBe(nodeSha([manifestLine(b), manifestLine(a)].join("\n")));
    expect(reportingManifestHash([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(reportingManifestHash([a])).not.toBe(reportingManifestHash([{ ...a, inputHash: H("3") }]));
  });
});

describe("descriptors (same rules as plan_reporting_work)", () => {
  const ok: WorkDescriptor = { audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", inputHash: H("a") };
  it.each([
    ["not an object", null, /not an object/],
    ["extra key", { ...ok, site: "au" }, /unexpected keys/],
    ["site with staff", { ...ok, audienceStaff: STAFF }, /null exactly for the site audience/],
    ["self without staff", { ...ok, audienceKind: "self" }, /null exactly for the site audience/],
    ["bad uuid", { ...ok, audienceKind: "self", audienceStaff: "nope" }, /bad audienceStaff/],
    ["untrimmed order key", { ...ok, partitionKey: " 5001 " }, /trimmed order key/],
    ["empty key", { ...ok, partitionKey: "" }, /bad partitionKey/],
    ["bad kind", { ...ok, partitionKind: "day" }, /bad partitionKind/],
    ["bad hash", { ...ok, inputHash: "ABC" }, /bad inputHash/],
  ])("rejects %s", (_n, d, re) => {
    expect(descriptorProblem(d)).toMatch(re);
  });
  it("accepts a self order and an event key with surrounding spaces (event keys are not trimmed)", () => {
    expect(descriptorProblem({ ...ok, audienceKind: "self", audienceStaff: STAFF })).toBeNull();
    expect(descriptorProblem({ ...ok, partitionKind: "event", partitionKey: " ev 1 " })).toBeNull();
  });
});

describe("chunks and bulk requests", () => {
  const row = (i: number, pad = 0) => ({ event_id: `e${i}`, note: "x".repeat(pad) });
  const rows = (n: number, pad = 0): ResultRows => ({ event_facts: Array.from({ length: n }, (_, i) => row(i, pad)), cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });

  it("an empty replacement is ONE chunk of five empty arrays", () => {
    const c = buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
    expect(c).toHaveLength(1);
    expect(JSON.parse(c[0].canonicalRows)).toEqual({ cancel_edges: [], event_facts: [], order_occurrences: [], source_issue_facts: [], timing_facts: [] });
    expect(c[0]).toMatchObject({ chunkNo: 0, chunkCount: 1 });
  });

  it("at most 1,000 rows per chunk (counted across all five arrays); contiguous numbering; one digest over the ordered chunk hashes", () => {
    const mixed = buildChunks({ ...rows(600), source_issue_facts: Array.from({ length: 600 }, (_, i) => ({ event_id: " ".repeat(i + 1) })) });
    expect(mixed.map((x) => Object.values(JSON.parse(x.canonicalRows) as Record<string, unknown[]>).reduce((n, a) => n + a.length, 0))).toEqual([1000, 200]);
    expect(() => buildChunks({ ...rows(1), extra: [] } as unknown as ResultRows)).toThrow(/unknown result table extra/);
    const c = buildChunks(rows(2500));
    expect(c.map((x) => x.chunkNo)).toEqual([0, 1, 2]);
    expect(c.every((x) => x.chunkCount === 3 && x.resultDigest === c[0].resultDigest)).toBe(true);
    const counts = c.map((x) => Object.values(JSON.parse(x.canonicalRows) as Record<string, unknown[]>).reduce((n, a) => n + a.length, 0));
    expect(counts).toEqual([1000, 1000, 500]);
    expect(c[0].resultDigest).toBe(nodeSha(c.map((x) => x.chunkHash).join("\n")));
  });

  it("chunks stay under the byte cap; a single oversized row fails visibly", () => {
    const c = buildChunks(rows(40, 60_000));
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect(Buffer.byteLength(JSON.stringify(x), "utf8")).toBeLessThan(1024 * 1024);
    expect(() => buildChunks(rows(1, 1_100_000))).toThrow(ReportingJobError);
  });

  it("bulk requests hold at most 100 entries and stay under 1 MiB; an oversized entry fails", () => {
    const small: ChunkEnvelope = buildChunks(rows(1))[0];
    const entries = Array.from({ length: 250 }, (_, i) => ({ partition: String(i + 1), chunk: small }));
    expect(packStageRequests(entries).map((r) => r.length)).toEqual([100, 100, 50]);
    const big = buildChunks(rows(10, 90_000))[0];
    const bigEntries = Array.from({ length: 5 }, (_, i) => ({ partition: String(i + 1), chunk: big }));
    for (const r of packStageRequests(bigEntries)) expect(Buffer.byteLength(JSON.stringify(r), "utf8")).toBeLessThan(1024 * 1024);
    expect(() => packStageRequests([{ partition: "1", chunk: { ...small, canonicalRows: "x".repeat(1_100_000) } }])).toThrow(/exceeds the request limit/);
    expect(MAX_BULK_ENTRIES).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Reference model of 0038 stage_one / check_staged_rows / bulk atomicity
// ---------------------------------------------------------------------------

type Work = { id: string; batch: string; audienceKind: "site" | "self"; audienceStaff: string | null; partitionKind: "order" | "event"; partitionKey: string; state: "pending" | "leased" | "done"; fence: number | null; expCount: number | null; expDigest: string | null };
/** A frozen source image: to_jsonb(production_events row). */
type Img = { id: string; event_type: string; order_number: string | null; staff_id: string | null; created_at: string; parent_event_id: string | null; department: string | null; line_sku: string | null; line_quantity: number | null; cs_case_id: string | null };
const COLS: Record<ResultTable, string[]> = Object.fromEntries(RESULT_TABLES.map((t) => [t, RESULT_COLUMNS[t].map(([c]) => c)])) as Record<ResultTable, string[]>;
const jsTrim = (s: string | null) => (s ?? "").trim();
const COUNT_TYPES = ["line_verified", "completed", "dispatched", "cancelled"];
/** Exact instant in microseconds (Date.parse drops them; timestamptz keeps them). */
const at = (s: unknown): bigint => {
  const t = String(s);
  const frac = /\.(\d{1,6})/.exec(t)?.[1] ?? "";
  return BigInt(Date.parse(t.replace(/\.\d+/, ""))) * 1000n + BigInt(frac.padEnd(6, "0"));
};

class StageRef {
  works = new Map<string, Work>();
  results = new Map<string, Map<number, { hash: string }>>();
  constructor(public frozen: Map<string, Img>, public cutoff: string) {}
  clone(): StageRef {
    const c = new StageRef(this.frozen, this.cutoff);
    for (const [k, w] of this.works) c.works.set(k, { ...w });
    for (const [k, m] of this.results) c.results.set(k, new Map(m));
    return c;
  }
  owner(img: Img): [string, string] {
    const k = jsTrim(img.order_number);
    return k ? ["order", k] : ["event", img.id];
  }
  /** Mirrors check_staged_rows, rule for rule and in the same order. */
  checkRows(w: Work, rows: Record<string, Array<Record<string, unknown>>>): void {
    for (const t of RESULT_TABLES) {
      rows[t].forEach((r, i) => {
        const pre = `${t}[${i + 1}]`;
        if (Object.keys(r).sort().join(",") !== [...COLS[t]].sort().join(",")) throw new Error(`${pre} has unexpected keys`);
        const bad = resultRowProblem(t, r);
        if (bad) throw new Error(`${pre}: ${bad}`);
        const id = String(t === "cancel_edges" ? r.cancel_event_id : t === "order_occurrences" ? r.terminal_event_id : r.event_id);
        const img = this.frozen.get(id);
        if (!img) throw new Error(`${pre} event ${id} is not in the frozen view`);
        const [pk, key] = this.owner(img);
        if (pk !== w.partitionKind || key !== w.partitionKey) throw new Error(`${pre} event ${id} belongs to partition ${pk}/${key}`);
        if (w.audienceKind === "self" && img.staff_id !== w.audienceStaff) throw new Error(`${pre} event ${id} is not the self audience's own row`);
        if ((t === "source_issue_facts") !== (jsTrim(id) === "")) throw new Error(`${pre} event ${id} ${t === "source_issue_facts" ? "has a valid identity" : "has a malformed identity"}`);
        if (at(img.created_at) > at(this.cutoff)) throw new Error(`${pre} is after the batch cutoff`);
        const same = (field: string, a: unknown, b: unknown) => {
          if (a !== b) throw new Error(`${pre} ${field} differs from the frozen source`);
        };
        if (t === "event_facts" || t === "source_issue_facts") {
          same("event_type", r.event_type, img.event_type);
          if (at(r.created_at) !== at(img.created_at)) throw new Error(`${pre} created_at differs from the frozen source`);
          same("staff_id", r.staff_id, img.staff_id);
          same("raw_order", r.raw_order, img.order_number);
          same("parent_event_id", r.parent_event_id, img.parent_event_id);
        }
        if (t === "event_facts") {
          same("department", r.department, img.department);
          same("case_id", r.case_id, img.cs_case_id);
          same("sku", r.sku, img.line_sku);
          same("quantity", r.quantity, img.line_quantity);
          if (r.order_key !== jsTrim(r.raw_order as string | null)) throw new Error(`${pre} order_key is not the trimmed raw order`);
        } else if (t === "cancel_edges") {
          if (img.event_type !== "cancelled") throw new Error(`${pre} event ${id} is not a cancellation in the frozen source`);
          if (r.parent_event_id !== img.parent_event_id) throw new Error(`${pre} parent differs from the frozen cancellation`);
          if (r.is_self !== (img.parent_event_id === id)) throw new Error(`${pre} is_self differs from the frozen cancellation`);
          const pid = String(r.parent_event_id);
          const p = jsTrim(pid) === "" ? undefined : this.frozen.get(pid);
          const visible = !!p && COUNT_TYPES.includes(p.event_type) && at(p.created_at) <= at(this.cutoff) && (w.audienceKind === "site" || p.staff_id === w.audienceStaff);
          if ((r.parent_role !== null) !== visible) throw new Error(`${pre} parent existence differs from the frozen view`);
          if (visible && at(r.parent_created_at) !== at(p!.created_at)) throw new Error(`${pre} parent_created_at differs from the frozen parent`);
        } else if (t === "order_occurrences") {
          if (img.event_type !== "completed" && img.event_type !== "dispatched") throw new Error(`${pre} event ${id} is not a terminal in the frozen source`);
          same("raw_order", r.raw_order, img.order_number);
          if (r.order_key !== jsTrim(r.raw_order as string)) throw new Error(`${pre} order_key is not the trimmed raw order`);
          same("case_id", r.case_id, img.cs_case_id);
          same("staff_id", r.staff_id, img.staff_id);
          if (at(r.occurred_at) !== at(img.created_at)) throw new Error(`${pre} occurred_at differs from the frozen source`);
        } else if (t === "timing_facts") {
          if (img.event_type !== "line_verified") throw new Error(`${pre} event ${id} is not a verification in the frozen source`);
          same("staff_id", r.staff_id, img.staff_id);
          if (at(r.occurred_at) !== at(img.created_at)) throw new Error(`${pre} occurred_at differs from the frozen source`);
          for (const ref of [r.prev_all_event_id, r.prev_same_type_event_id]) {
            if (ref === null) continue;
            const p = jsTrim(String(ref)) === "" ? undefined : this.frozen.get(String(ref));
            if (!p || p.event_type !== "line_verified" || p.staff_id !== img.staff_id || at(p.created_at) > at(img.created_at) || ref === id) {
              throw new Error(`${pre} predecessor ${String(ref)} is not an earlier verification by the same worker in the frozen view`);
            }
          }
        }
      });
    }
  }
  stage(fence: number, partition: string, chunk: unknown): { stored: boolean; done: boolean } {
    if (!/^[1-9][0-9]{0,18}$/.test(partition)) throw new Error("partition must be a positive decimal work id");
    const w = this.works.get(partition);
    if (!w) throw new Error(`work ${partition} does not belong to the batch`);
    const c = chunk as Record<string, unknown>;
    if (Object.keys(c).sort().join(",") !== "canonicalRows,chunkCount,chunkHash,chunkNo,resultDigest") throw new Error("chunk envelope has unexpected keys");
    const no = c.chunkNo as number;
    const count = c.chunkCount as number;
    if (!Number.isInteger(no) || no < 0 || !Number.isInteger(count) || count < 1) throw new Error("chunkNo/chunkCount must be integers");
    if (no >= count) throw new Error(`chunkNo ${no} is outside chunkCount ${count}`);
    if (nodeSha(String(c.canonicalRows)) !== c.chunkHash) throw new Error("chunkHash does not match canonicalRows");
    if (w.expCount !== null && (w.expCount !== count || w.expDigest !== c.resultDigest)) throw new Error("chunkCount/resultDigest differ from its saved ones");
    const saved = this.results.get(partition) ?? new Map();
    const prev = saved.get(no);
    if (prev) {
      if (prev.hash === c.chunkHash) return { stored: false, done: w.state === "done" };
      throw new Error(`chunk ${no} was already saved with different content`);
    }
    if (w.state === "done") throw new Error("work is complete");
    if (w.state !== "leased" || w.fence !== fence) throw new Error(`work ${partition} is not claimed under fence ${fence}`);
    const rows = JSON.parse(String(c.canonicalRows)) as Record<string, Array<Record<string, unknown>>>;
    if (Object.keys(rows).sort().join(",") !== "cancel_edges,event_facts,order_occurrences,source_issue_facts,timing_facts") throw new Error("canonicalRows must hold exactly the five arrays");
    if (Object.values(rows).reduce((n, a) => n + a.length, 0) > 1000) throw new Error("more than 1000 rows");
    this.checkRows(w, rows);
    saved.set(no, { hash: String(c.chunkHash) });
    this.results.set(partition, saved);
    if (w.expCount === null) {
      w.expCount = count;
      w.expDigest = String(c.resultDigest);
    }
    if (saved.size === count) {
      const digest = nodeSha([...saved.entries()].sort(([a], [b]) => a - b).map(([, v]) => v.hash).join("\n"));
      if (digest !== c.resultDigest) throw new Error("resultDigest does not match its chunks");
      w.state = "done";
      return { stored: true, done: true };
    }
    return { stored: true, done: false };
  }
  /** stage_reporting_results: all entries or none. */
  bulk(fence: number, entries: Array<{ partition: string; chunk: unknown }>): void {
    if (entries.length > 100) throw new Error("at most 100 entries");
    const next = this.clone();
    for (const e of entries) next.stage(fence, e.partition, e.chunk);
    this.works = next.works;
    this.results = next.results;
  }
}

const BEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const img = (id: string, p: Partial<Img>): [string, Img] => [
  id,
  { id, event_type: "line_verified", order_number: "5001", staff_id: STAFF, created_at: "2026-01-15T09:00:00Z", parent_event_id: null, department: "framed", line_sku: "INKA-KAN0566-A4-FB", line_quantity: 1, cs_case_id: null, ...p },
];
const imgs = new Map<string, Img>([
  img("v0", { created_at: "2026-01-15T08:50:00Z" }),
  img("v1", {}),
  img("v2", { order_number: " 5001 ", staff_id: BEN, created_at: "2026-01-15T09:05:00Z" }),
  img("c1", { event_type: "cancelled", created_at: "2026-01-15T09:10:00Z", parent_event_id: "v1" }),
  img("c2", { event_type: "cancelled", created_at: "2026-01-15T09:12:00Z", parent_event_id: "st-1" }),
  img("c3", { event_type: "cancelled", created_at: "2026-01-15T09:14:00Z", parent_event_id: "v2" }),
  img("st-1", { event_type: "started", created_at: "2026-01-15T08:00:00Z", line_sku: null, line_quantity: null }),
  img("t1", { event_type: "completed", created_at: "2026-01-15T09:30:00Z", cs_case_id: "case-1", line_sku: null, line_quantity: null }),
  img("x1", { order_number: "  ", created_at: "2026-01-15T09:20:00Z" }),
  img("   ", { event_type: "started", order_number: null, created_at: "2026-01-15T09:40:00Z", line_sku: null, line_quantity: null }),
  img(" \t", { event_type: "completed", order_number: "5001", staff_id: BEN, created_at: "2026-01-15T09:41:00Z", line_sku: null, line_quantity: null }),
  img("f1", { created_at: "2026-02-20T09:00:00Z" }),
]);
const I = (id: string) => imgs.get(id)!;
const ROLE_OF: Record<string, string> = { line_verified: "verification", completed: "terminal", dispatched: "terminal", cancelled: "cancellation" };
/** A structurally valid row bound to its frozen image (derived fields are plausible TypeScript output). */
const fact = (id: string, over: Record<string, unknown> = {}) => {
  const s = I(id);
  const verification = s.event_type === "line_verified";
  return {
    event_id: id, event_type: s.event_type, created_at: s.created_at, staff_id: s.staff_id, department: s.department, raw_order: s.order_number,
    order_key: jsTrim(s.order_number), case_id: s.cs_case_id, parent_event_id: s.parent_event_id, sku: s.line_sku, quantity: s.line_quantity,
    role: ROLE_OF[s.event_type] ?? "invalid", work_type: "framed", invalid_detail: null,
    line_key: verification ? "kan0566" : null, item_status: verification ? "counted" : null, items: verification ? 1 : null, product_kind: verification ? "eligible" : null,
    item_issue_kind: null, item_issue_detail: null, timing_stream: verification ? true : null, timing_weight: verification ? 1 : null, production_date: "2026-01-15",
    ...over,
  };
};
const edge = (id: string, audienceStaff: string | null = null, over: Record<string, unknown> = {}) => {
  const s = I(id);
  const p = imgs.get(String(s.parent_event_id));
  const visible = !!p && COUNT_TYPES.includes(p.event_type) && (audienceStaff === null || p.staff_id === audienceStaff);
  return {
    cancel_event_id: id, parent_event_id: s.parent_event_id, is_self: s.parent_event_id === id,
    parent_role: visible ? ROLE_OF[p!.event_type] : null, parent_created_at: visible ? p!.created_at : null,
    pair: visible && ["verification", "terminal"].includes(ROLE_OF[p!.event_type]) ? "valid" : null, ...over,
  };
};
const occ = (id: string, over: Record<string, unknown> = {}) => {
  const s = I(id);
  return { terminal_event_id: id, order_key: jsTrim(s.order_number), raw_order: s.order_number, case_id: s.cs_case_id, work_type: "framed", staff_id: s.staff_id, occurred_at: s.created_at, ...over };
};
const timing = (id: string, over: Record<string, unknown> = {}) => {
  const s = I(id);
  return { event_id: id, staff_id: s.staff_id, work_type: "framed", occurred_at: s.created_at, weight: 1, prev_all_event_id: null, prev_same_type_event_id: null, ...over };
};
const issue = (id: string, over: Record<string, unknown> = {}) => {
  const s = I(id);
  return { event_id: id, event_type: s.event_type, created_at: s.created_at, staff_id: s.staff_id, raw_order: s.order_number, parent_event_id: s.parent_event_id, issue_kind: "invalid_event", issue_detail: "missing id or site", ...over };
};
const env = (rows: Partial<ResultRows>) => buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [], ...rows } as ResultRows);
function setup() {
  const db = new StageRef(imgs, "2026-02-10T00:00:00Z");
  const add = (id: string, w: Partial<Work>) => db.works.set(id, { id, batch: BATCH, audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", state: "leased", fence: 7, expCount: null, expDigest: null, ...w });
  add("1", {});
  add("2", { partitionKind: "event", partitionKey: "x1" });
  add("3", { audienceKind: "self", audienceStaff: STAFF });
  add("4", { state: "pending", fence: null });
  add("5", { partitionKind: "event", partitionKey: "   " });
  add("6", { audienceKind: "self", audienceStaff: BEN });
  return db;
}
/** Stage one chunk on a fresh model; returns the error message or "ok". */
const tryStage = (work: string, rows: Partial<ResultRows>) => {
  try {
    const db = setup();
    db.stage(7, work, env(rows)[0]);
    expect(db.works.get(work)!.state).toBe("done");
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("staging rules (reference model of 0038)", () => {
  it("all chunks present with the declared digest complete the work; one missing chunk keeps it open", () => {
    const db = setup();
    const chunks = env({ event_facts: Array.from({ length: 1200 }, () => fact("v1")) });
    expect(chunks).toHaveLength(2);
    expect(db.stage(7, "1", chunks[1])).toEqual({ stored: true, done: false });
    expect(db.works.get("1")!.state).toBe("leased");
    expect(db.stage(7, "1", chunks[0])).toEqual({ stored: true, done: true });
  });

  it("identical retries are no-ops (also after completion); different content for a saved chunk fails, also after completion", () => {
    const db = setup();
    const [c] = env({ event_facts: [fact("v1")] });
    db.stage(7, "1", c);
    expect(db.stage(7, "1", c)).toEqual({ stored: false, done: true });
    const [other] = env({ event_facts: [fact("v2")] });
    expect(() => db.stage(7, "1", other)).toThrow(/already saved with different content|differ from its saved ones/);
  });

  it("a contradictory chunkCount or resultDigest for a work fails", () => {
    const db = setup();
    const two = env({ event_facts: Array.from({ length: 1001 }, () => fact("v1")) });
    db.stage(7, "1", two[0]);
    const [single] = env({ event_facts: [fact("v1")] });
    // Chunk 0 of a ONE-chunk result for a work already saved as a TWO-chunk result.
    expect(() => db.stage(7, "1", single)).toThrow(/differ from its saved ones/);
    // Chunk 1 of the same two-chunk set with a forged digest.
    expect(() => db.stage(7, "1", { ...two[1], resultDigest: H("0") })).toThrow(/differ from its saved ones/);
    expect(db.stage(7, "1", two[1])).toEqual({ stored: true, done: true });
  });

  it("a mismatched hash, a forged digest, an out-of-range chunk number and malformed envelopes fail", () => {
    const db = setup();
    const [c] = env({ event_facts: [fact("v1")] });
    expect(() => db.stage(7, "1", { ...c, chunkHash: H("0") })).toThrow(/chunkHash does not match/);
    expect(() => db.stage(7, "1", { ...c, resultDigest: H("0") })).toThrow(/resultDigest does not match/);
    expect(() => db.stage(7, "1", { ...c, chunkNo: 1 })).toThrow(/outside chunkCount/);
    expect(() => db.stage(7, "1", { ...c, extra: 1 })).toThrow(/unexpected keys/);
    expect(() => db.stage(7, "1.0", c)).toThrow(/positive decimal/);
    const four = canonicalJson({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [] });
    expect(() => setup().stage(7, "1", { ...c, canonicalRows: four, chunkHash: nodeSha(four), resultDigest: nodeSha(nodeSha(four)) })).toThrow(/exactly the five arrays/);
    expect(db.works.get("1")!.state).toBe("leased");
  });

  it("every family together: valid rows of all five arrays complete a site work and a self work", () => {
    expect(tryStage("1", { event_facts: [fact("v0"), fact("v1"), fact("v2"), fact("c1"), fact("t1")], cancel_edges: [edge("c1"), edge("c2"), edge("c3")], order_occurrences: [occ("t1")], timing_facts: [timing("v1", { prev_all_event_id: "v0", prev_same_type_event_id: "v0" })] })).toBe("ok");
    expect(tryStage("5", { source_issue_facts: [issue("   ")] })).toBe("ok");
    expect(tryStage("1", { source_issue_facts: [issue(" \t")] })).toBe("ok");
    expect(tryStage("3", { event_facts: [fact("v1"), fact("c3")], cancel_edges: [edge("c3", STAFF)], timing_facts: [timing("v1", { prev_all_event_id: "v0" })] })).toBe("ok");
  });

  it("ownership: rows must belong to the claimed partition (JS-trimmed order), be in the frozen view, and be the self audience's own rows", () => {
    expect(tryStage("1", { event_facts: [fact("v1"), fact("v2")], cancel_edges: [edge("c1")] })).toBe("ok");
    expect(tryStage("2", { event_facts: [fact("v1")] })).toMatch(/belongs to partition order\/5001/);
    expect(tryStage("2", { event_facts: [fact("x1")] })).toBe("ok");
    expect(tryStage("1", { event_facts: [fact("v1", { event_id: "zz" })] })).toMatch(/not in the frozen view/);
    expect(tryStage("3", { event_facts: [fact("v2")] })).toMatch(/not the self audience's own row/);
    expect(tryStage("3", { source_issue_facts: [issue(" \t")] })).toMatch(/not the self audience's own row/);
    expect(tryStage("6", { source_issue_facts: [issue(" \t")] })).toBe("ok");
  });

  it("payload attempts to set trusted metadata (site, audience, partition, rule, validity) are refused in every array", () => {
    const rows: Record<ResultTable, Record<string, unknown>> = { event_facts: fact("v1"), cancel_edges: edge("c1"), order_occurrences: occ("t1"), timing_facts: timing("v1"), source_issue_facts: issue(" \t") };
    for (const t of RESULT_TABLES) {
      for (const k of ["site", "audience_kind", "audience_staff", "partition_key", "rule_version", "valid_from_seq"]) {
        expect(tryStage("1", { [t]: [{ ...rows[t], [k]: "x" }] }), `${t}.${k}`).toMatch(/unexpected keys/);
      }
    }
  });

  it("T13B2a-1: required, null, type, enum, range and relational problems are refused before a chunk is saved or a work completes", () => {
    const cases: Array<[ResultTable, Record<string, unknown>, RegExp]> = [
      ["event_facts", fact("v1", { role: null }), /event_facts\.role must be one of/],
      ["event_facts", fact("v1", { event_type: "started" }), /event_facts\.event_type must be one of line_verified/],
      ["event_facts", fact("v1", { created_at: null }), /event_facts\.created_at must be an ISO-8601 timestamp$/],
      ["event_facts", fact("v1", { order_key: null }), /event_facts\.order_key must be a string$/],
      ["event_facts", fact("v1", { quantity: "1" }), /event_facts\.quantity must be a 32-bit integer or null/],
      ["event_facts", fact("v1", { quantity: 2 ** 31 }), /event_facts\.quantity must be a 32-bit integer or null/],
      ["event_facts", fact("v1", { items: -1 }), /event_facts\.items must be a non-negative safe integer or null/],
      ["event_facts", fact("v1", { items: 1.5 }), /event_facts\.items must be a non-negative safe integer or null/],
      ["event_facts", fact("v1", { items: 2 ** 53 }), /event_facts\.items must be a non-negative safe integer or null/],
      ["event_facts", fact("v1", { timing_weight: -0.5 }), /event_facts\.timing_weight must be a non-negative number or null/],
      ["event_facts", fact("v1", { timing_stream: "true" }), /event_facts\.timing_stream must be a boolean or null/],
      ["event_facts", fact("v1", { work_type: "paint" }), /event_facts\.work_type must be one of a0_framed/],
      ["event_facts", fact("v1", { staff_id: STAFF.toUpperCase() }), /event_facts\.staff_id must be a lowercase uuid or null/],
      ["event_facts", fact("v1", { production_date: "15/01/2026" }), /event_facts\.production_date must be a YYYY-MM-DD date or null/],
      ["event_facts", fact("v1", { items: null }), /role verification needs exactly/],
      ["event_facts", fact("v1", { role: "terminal" }), /role verification needs exactly/],
      ["event_facts", fact("v1", { role: "invalid" }), /role verification needs exactly/],
      ["event_facts", fact("t1", { role: "invalid" }), /invalid_detail is required exactly for role invalid/],
      ["event_facts", fact("t1", { invalid_detail: "x" }), /invalid_detail is required exactly for role invalid/],
      ["cancel_edges", edge("c1", null, { is_self: null }), /cancel_edges\.is_self must be a boolean$/],
      ["cancel_edges", edge("c1", null, { parent_event_id: "" }), /cancel_edges\.parent_event_id must be a non-empty string$/],
      ["cancel_edges", edge("c1", null, { parent_created_at: null }), /parent_role and parent_created_at are both set or both null/],
      ["cancel_edges", edge("c1", null, { pair: null }), /pair is required exactly for a verification or terminal parent/],
      ["cancel_edges", edge("c2", null, { pair: "valid" }), /pair is required exactly for a verification or terminal parent/],
      ["cancel_edges", edge("c1", null, { pair: "maybe" }), /cancel_edges\.pair must be one of valid, mismatch, case_differs or null/],
      ["order_occurrences", occ("t1", { staff_id: null }), /order_occurrences\.staff_id must be a lowercase uuid$/],
      ["order_occurrences", occ("t1", { order_key: "" }), /order_occurrences\.order_key must be a non-empty string$/],
      ["order_occurrences", occ("t1", { work_type: null }), /order_occurrences\.work_type must be one of/],
      ["order_occurrences", occ("t1", { occurred_at: "yesterday" }), /order_occurrences\.occurred_at must be an ISO-8601 timestamp$/],
      ["timing_facts", timing("v1", { weight: null }), /timing_facts\.weight must be a non-negative number$/],
      ["timing_facts", timing("v1", { weight: -1 }), /timing_facts\.weight must be a non-negative number$/],
      ["timing_facts", timing("v1", { prev_all_event_id: "" }), /timing_facts\.prev_all_event_id must be a non-empty string or null/],
      ["source_issue_facts", issue(" \t", { issue_kind: null }), /source_issue_facts\.issue_kind must be one of invalid_event/],
      ["source_issue_facts", issue(" \t", { issue_kind: "other" }), /source_issue_facts\.issue_kind must be one of invalid_event/],
      ["source_issue_facts", issue(" \t", { event_type: null }), /source_issue_facts\.event_type must be a non-empty string$/],
    ];
    for (const [t, row, re] of cases) {
      const db = setup();
      const [c] = env({ [t]: [row] });
      expect(() => db.stage(7, "1", c), `${t} ${JSON.stringify(row).slice(0, 80)}`).toThrow(re);
      expect(db.results.size).toBe(0);
      expect(db.works.get("1")!.state).toBe("leased");
      expect(resultRowProblem(t, row)).toMatch(re);
    }
  });

  it("T13B2a-1 residual: production_date must be a real calendar day (month, day, leap year, years 0001-9999) before the chunk is saved", () => {
    const bad = ["2026-02-30", "2026-99-99", "2026-00-10", "2026-13-01", "2026-01-00", "2026-01-32", "2026-04-31", "2026-06-31", "2026-09-31", "2026-11-31", "2026-02-29", "1900-02-29", "2100-02-29", "2023-02-29", "0000-01-01", "0000-02-29", "10000-01-01", "2026-1-15"];
    const good = ["2024-02-29", "2000-02-29", "2400-02-29", "1600-02-29", "2026-02-28", "2026-01-31", "2026-03-31", "2026-04-30", "2026-12-31", "0001-01-01", "9999-12-31", "2026-01-15"];
    for (const v of bad) {
      expect(isCalendarDate(v), v).toBe(false);
      const row = fact("v1", { production_date: v });
      expect(resultRowProblem("event_facts", row), v).toBe("event_facts.production_date must be a YYYY-MM-DD date or null");
      const db = setup();
      expect(() => db.stage(7, "1", env({ event_facts: [row] })[0]), v).toThrow(/production_date must be a YYYY-MM-DD date or null/);
      expect(db.results.size, v).toBe(0);
      expect(db.works.get("1")!.state, v).toBe("leased");
    }
    for (const v of good) {
      expect(isCalendarDate(v), v).toBe(true);
      expect(resultRowProblem("event_facts", fact("v1", { production_date: v })), v).toBeNull();
      expect(tryStage("1", { event_facts: [fact("v1", { production_date: v })] }), v).toBe("ok");
    }
    // Nullability is unchanged.
    expect(tryStage("1", { event_facts: [fact("v1", { production_date: null })] })).toBe("ok");
  });

  it("T13B2a-2: wrong worker, time, order, case and parent identity are refused for site and self audiences; derived fields stay TypeScript's", () => {
    for (const work of ["1", "3"]) {
      const bad: Array<[Partial<ResultRows>, RegExp]> = [
        [{ event_facts: [fact("v1", { staff_id: BEN })] }, /staff_id differs/],
        [{ event_facts: [fact("v1", { created_at: "2026-01-15T09:00:00.000001Z" })] }, /created_at differs/],
        [{ event_facts: [fact("v1", { raw_order: " 5001", order_key: "5001" })] }, /raw_order differs/],
        [{ event_facts: [fact("v1", { order_key: "5002" })] }, /order_key is not the trimmed raw order/],
        [{ event_facts: [fact("v1", { case_id: "case-9" })] }, /case_id differs/],
        [{ event_facts: [fact("v1", { parent_event_id: "c1" })] }, /parent_event_id differs/],
        [{ event_facts: [fact("v1", { sku: "INKA-AUX-HOOK" })] }, /sku differs/],
        [{ event_facts: [fact("v1", { quantity: 2 })] }, /quantity differs/],
        [{ event_facts: [fact("v1", { department: "unframed" })] }, /department differs/],
        [{ event_facts: [fact("v1", { event_type: "completed", role: "terminal", line_key: null, item_status: null, items: null, product_kind: null, timing_stream: null, timing_weight: null })] }, /event_type differs/],
        [{ order_occurrences: [occ("t1", { staff_id: BEN })] }, /staff_id differs/],
        [{ order_occurrences: [occ("t1", { occurred_at: "2026-01-15T09:31:00Z" })] }, /occurred_at differs/],
        [{ order_occurrences: [occ("t1", { raw_order: "5001 ", order_key: "5001" })] }, /raw_order differs/],
        [{ order_occurrences: [occ("t1", { case_id: null })] }, /case_id differs/],
        [{ order_occurrences: [occ("v1")] }, /is not a terminal in the frozen source/],
        [{ timing_facts: [timing("v1", { staff_id: BEN })] }, /staff_id differs/],
        [{ timing_facts: [timing("v1", { occurred_at: "2026-01-15T08:59:59Z" })] }, /occurred_at differs/],
        [{ timing_facts: [timing("t1")] }, /is not a verification in the frozen source/],
        [{ timing_facts: [timing("v1", { prev_all_event_id: "v2" })] }, /predecessor v2 is not an earlier verification by the same worker/],
        [{ timing_facts: [timing("v0", { prev_same_type_event_id: "v1" })] }, /predecessor v1 is not an earlier/],
        [{ timing_facts: [timing("v1", { prev_all_event_id: "t1" })] }, /predecessor t1 is not an earlier/],
        [{ timing_facts: [timing("v1", { prev_all_event_id: "gone" })] }, /predecessor gone is not an earlier/],
        [{ timing_facts: [timing("v1", { prev_all_event_id: "v1" })] }, /predecessor v1 is not an earlier/],
        [{ cancel_edges: [edge("c1", null, { parent_event_id: "v0" })] }, /parent differs from the frozen cancellation/],
        [{ cancel_edges: [edge("c1", null, { is_self: true })] }, /is_self differs/],
        [{ cancel_edges: [edge("c1", null, { parent_created_at: "2026-01-15T08:00:00Z" })] }, /parent_created_at differs from the frozen parent/],
        // An ignored valid-id `started` parent is NOT a parent (the reducer's "parent not found").
        [{ cancel_edges: [edge("c2", null, { parent_role: "verification", parent_created_at: "2026-01-15T08:00:00Z", pair: "valid" })] }, /parent existence differs/],
        [{ cancel_edges: [edge("v1", null, { parent_event_id: "v0" })] }, /is not a cancellation in the frozen source/],
        [{ source_issue_facts: [issue("v1")] }, /has a valid identity/],
        [{ event_facts: [fact("   ", { event_type: "started" })] }, /event_facts\.event_type must be one of/],
      ];
      for (const [rows, re] of bad) {
        const msg = tryStage(work, rows);
        expect(msg, `${work} ${JSON.stringify(rows).slice(0, 120)}`).toMatch(re);
      }
    }
    expect(tryStage("1", { cancel_edges: [edge("c3")] })).toBe("ok"); // site sees Ben's parent
    expect(tryStage("3", { cancel_edges: [edge("c3", STAFF)] })).toBe("ok"); // Anna's self view does not
    expect(tryStage("3", { cancel_edges: [edge("c3")] })).toMatch(/parent existence differs/);
    expect(tryStage("1", { cancel_edges: [edge("c3", STAFF)] })).toMatch(/parent existence differs/);
    expect(tryStage("5", { event_facts: [fact("   ", { event_type: "started" })] })).toMatch(/event_type must be one of/);
    expect(tryStage("5", { source_issue_facts: [issue("   ", { staff_id: BEN })] })).toMatch(/staff_id differs/);
    expect(tryStage("5", { source_issue_facts: [issue("   ", { raw_order: "5002" })] })).toMatch(/raw_order differs/);
    expect(tryStage("5", { source_issue_facts: [issue("   ", { created_at: "2026-01-15T09:40:01Z" })] })).toMatch(/created_at differs/);
    expect(tryStage("5", { source_issue_facts: [issue("   ", { parent_event_id: "v1" })] })).toMatch(/parent_event_id differs/);
    expect(tryStage("5", { source_issue_facts: [issue("   ", { event_type: "completed" })] })).toMatch(/event_type differs/);
  });

  it("a whitespace-id row is never an ordinary fact, and a valid-id row never a source issue", () => {
    const ws = new Map(imgs);
    ws.set("  ", { ...I("v1"), id: "  ", order_number: "5001" });
    const db = new StageRef(ws, "2026-02-10T00:00:00Z");
    db.works.set("1", { id: "1", batch: BATCH, audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", state: "leased", fence: 7, expCount: null, expDigest: null });
    expect(() => db.stage(7, "1", env({ event_facts: [{ ...fact("v1"), event_id: "  " }] })[0])).toThrow(/has a malformed identity/);
    expect(tryStage("1", { source_issue_facts: [issue("v1")] })).toMatch(/has a valid identity/);
  });

  it("frozen-source drift and rows after the cutoff are refused in every family", () => {
    expect(tryStage("1", { event_facts: [fact("v1", { created_at: "2026-01-15T09:00:01Z" })] })).toMatch(/created_at differs/);
    expect(tryStage("1", { event_facts: [fact("v1", { raw_order: "5002", order_key: "5002" })] })).toMatch(/raw_order differs/);
    expect(tryStage("1", { event_facts: [fact("v2", { order_key: " 5001 " })] })).toMatch(/order_key is not the trimmed raw order/);
    expect(tryStage("1", { event_facts: [fact("f1")] })).toMatch(/after the batch cutoff/);
    expect(tryStage("1", { timing_facts: [timing("f1")] })).toMatch(/after the batch cutoff/);
  });

  it("unclaimed work, another fence, and completed work refuse new chunks", () => {
    const [c] = env({});
    expect(() => setup().stage(7, "4", c)).toThrow(/not claimed under fence 7/);
    expect(() => setup().stage(8, "1", c)).toThrow(/not claimed under fence 8/);
    expect(() => setup().stage(7, "9", c)).toThrow(/does not belong/);
  });

  it("bulk: one invalid entry rolls back the whole request; bulk and single-work staging end in the same state", () => {
    const good1 = env({ event_facts: [fact("v1")] })[0];
    const good2 = env({ event_facts: [fact("x1")] })[0];
    const bad = env({ event_facts: [fact("v1", { role: null })] })[0];
    const db = setup();
    expect(() => db.bulk(7, [{ partition: "1", chunk: good1 }, { partition: "2", chunk: good2 }, { partition: "3", chunk: bad }])).toThrow(/role must be one of/);
    expect(db.results.size).toBe(0);
    expect([db.works.get("1")!.state, db.works.get("2")!.state]).toEqual(["leased", "leased"]);
    const bulk = setup();
    bulk.bulk(7, [{ partition: "1", chunk: good1 }, { partition: "2", chunk: good2 }]);
    const single = setup();
    single.stage(7, "1", good1);
    single.stage(7, "2", good2);
    expect([...bulk.works.values()]).toEqual([...single.works.values()]);
    expect([...bulk.results.entries()].map(([k, m]) => [k, [...m.entries()]])).toEqual([...single.results.entries()].map(([k, m]) => [k, [...m.entries()]]));
    expect(() => setup().bulk(7, Array.from({ length: 101 }, () => ({ partition: "1", chunk: good1 })))).toThrow(/at most 100/);
  });
});

// ---------------------------------------------------------------------------
// Claim size (T13B2a-3)
// ---------------------------------------------------------------------------

describe("T13B2a-3: the claim bound is the serialized response, escaping and framing included", () => {
  /** PostgREST's compact row JSON, list-framed (what the caller actually receives). */
  const compact = (ws: ReadonlyArray<Parameters<typeof claimRowBytes>[0]>) =>
    Buffer.byteLength(JSON.stringify(ws.map((w) => ({ work_id: w.workId, audience_kind: w.audienceKind, audience_staff: w.audienceStaff, partition_kind: w.partitionKind, partition_key: w.partitionKey, input_hash: w.inputHash, expected_chunk_count: w.expectedChunkCount, staged_chunks: w.stagedChunks }))), "utf8");
  // 1,000 unique keys: three digits plus 800 quotes each (the review's reproduction).
  const pending = Array.from({ length: 1000 }, (_, i) => ({
    workId: String(1000 + i), audienceKind: "site" as const, audienceStaff: null, partitionKind: "event" as const,
    partitionKey: String(i).padStart(3, "0") + '"'.repeat(800), inputHash: H("a"), expectedChunkCount: null, stagedChunks: 0,
  }));

  it("reproduces the defect: the old octet_length(partition_key)+200 estimate accepts a response far over 1 MiB", () => {
    const oldEstimate = pending.reduce((n, w) => n + Buffer.byteLength(w.partitionKey, "utf8") + 200, 0);
    expect(oldEstimate).toBe(1_003_000);
    expect(oldEstimate).toBeLessThanOrEqual(1024 * 1024);
    expect(compact(pending)).toBeGreaterThan(1.5 * 1024 * 1024);
    // Every one of these descriptors is individually valid and plannable.
    for (const w of pending.slice(0, 3)) expect(descriptorProblem({ audienceKind: w.audienceKind, audienceStaff: w.audienceStaff, partitionKind: w.partitionKind, partitionKey: w.partitionKey, inputHash: w.inputHash })).toBeNull();
  });

  it("each claim is the longest work-id prefix within 1 MiB of serialized bytes, never truncated; repeated claims return every work (none stranded)", () => {
    let rest = [...pending];
    const seen: string[] = [];
    let calls = 0;
    while (rest.length) {
      const got = claimPrefix(rest);
      calls++;
      expect(got.length).toBeGreaterThan(0);
      expect(got).toEqual(rest.slice(0, got.length)); // a prefix, unaltered
      expect(2 + got.reduce((n, w) => n + claimRowBytes(w), 0)).toBeLessThanOrEqual(1024 * 1024);
      expect(compact(got)).toBeLessThanOrEqual(1024 * 1024);
      if (got.length < rest.length) expect(2 + [...got, rest[got.length]].reduce((n, w) => n + claimRowBytes(w), 0)).toBeGreaterThan(1024 * 1024);
      seen.push(...got.map((w) => w.workId));
      rest = rest.slice(got.length);
    }
    expect(seen).toEqual(pending.map((w) => w.workId));
    expect(calls).toBe(2);
  });

  it("the byte model is json_build_object text: escaped values, quoted keys, ' : ' and ', ' separators, plus the list separator", () => {
    const w = { workId: "12", audienceKind: "self" as const, audienceStaff: STAFF, partitionKind: "order" as const, partitionKey: 'a"\\\u0001é', inputHash: H("b"), expectedChunkCount: 3, stagedChunks: 1 };
    const text = `{"work_id" : "12", "audience_kind" : "self", "audience_staff" : "${STAFF}", "partition_kind" : "order", "partition_key" : "a\\"\\\\\\u0001é", "input_hash" : "${H("b")}", "expected_chunk_count" : 3, "staged_chunks" : 1}`;
    expect(claimRowBytes(w)).toBe(4 + Buffer.byteLength(text, "utf8"));
    expect(claimRowBytes(w)).toBeGreaterThan(compact([w]));
  });

  it("a descriptor that cannot fit one response is refused when planned, and fails visibly if ever claimed", () => {
    const huge = "\u0001".repeat(180_000); // escapes to 1,080,000 bytes
    expect(Buffer.byteLength(JSON.stringify(huge), "utf8")).toBeGreaterThan(MAX_CLAIM_KEY_JSON_BYTES);
    expect(descriptorProblem({ audienceKind: "site", audienceStaff: null, partitionKind: "event", partitionKey: huge, inputHash: H("a") })).toMatch(/too large for one claim response/);
    expect(() => claimPrefix([{ ...pending[0], partitionKey: huge }, pending[1]])).toThrow(/does not fit one 1 MiB claim response/);
  });
});

// ---------------------------------------------------------------------------
// 0038 SQL text (B2a)
// ---------------------------------------------------------------------------

describe("0038 B2a SQL", () => {
  const SQL = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
  const codes = splitSqlStatements(SQL).map((s) => s.text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim());
  const fn = (name: string) => codes.find((c) => c.startsWith(`CREATE FUNCTION ${name}(`)) ?? "";

  it("adds only nullable metadata and a descriptor/seal guard", () => {
    expect(codes).toContain("ALTER TABLE reporting_private.event_facts ADD COLUMN production_date date");
    const batches = codes.find((c) => c.startsWith("ALTER TABLE reporting_private.batches ADD COLUMN sealed_at"))!;
    expect(batches).toMatch(/ADD CONSTRAINT batches_seal_all_or_none CHECK/);
    expect(codes.find((c) => c.startsWith("ALTER TABLE reporting_private.partition_work ADD COLUMN expected_chunk_count"))).toMatch(/partition_work_expected_pair/);
    const g = fn("reporting_private.partition_work_guard");
    expect(g).toMatch(/is sealed; no work can be added/);
    expect(g).toMatch(/descriptor is immutable/);
  });

  it("T11-4: the fifth family is a versioned, service-only private table with the raw selectors and the TypeScript issue", () => {
    const t = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.source_issue_facts"))!;
    for (const col of ["site text NOT NULL CHECK (site IN ('au', 'uk', 'us'))", "audience_kind text NOT NULL", "audience_staff uuid,", "event_id text NOT NULL CHECK (event_id <> '')", "valid_from_seq bigint NOT NULL CHECK (valid_from_seq >= 1)", "valid_to_seq bigint,", "event_type text NOT NULL", "created_at timestamptz NOT NULL", "staff_id uuid,", "raw_order text,", "parent_event_id text,", "issue_kind text NOT NULL CHECK (issue_kind IN ('invalid_event', 'unclassified_sku', 'invalid_quantity', 'unresolved_parent', 'missing_completion_detail', 'ambiguous_repeat'))", "issue_detail text,", "rule_version text NOT NULL"]) {
      expect(t, col).toContain(col);
    }
    expect(t).toMatch(/CHECK \(\(audience_kind = 'site'\) = \(audience_staff IS NULL\)\)/);
    expect(t).toMatch(/CHECK \(valid_to_seq IS NULL OR valid_to_seq > valid_from_seq\)/);
    expect(t).toMatch(/CHECK \(audience_kind = 'site' OR staff_id = audience_staff\)/);
    expect(t).toMatch(/UNIQUE NULLS NOT DISTINCT \(site, audience_kind, audience_staff, event_id, valid_from_seq\)/);
    expect(t).not.toMatch(/REFERENCES/);
    expect(codes).toContain("ALTER TABLE reporting_private.source_issue_facts ENABLE ROW LEVEL SECURITY");
    expect(codes).toContain("REVOKE ALL ON TABLE reporting_private.source_issue_facts FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_issue_facts TO service_role");
    expect(codes.filter((c) => c.startsWith("CREATE INDEX source_issue_facts_"))).toHaveLength(4);
    // 0037 stays byte-identical; the fifth table is new in 0038 only.
    expect(readFileSync("supabase/migrations/0037_reporting_storage.sql", "utf8")).not.toMatch(/source_issue_facts/);
  });

  it("plan: frozen unsealed batch under a live fence; ≤1,000 descriptors and 1 MiB; exact shape; conflicts fail; identical replay is a no-op", () => {
    const f = fn("public.plan_reporting_work");
    expect(f).toMatch(/b := reporting_private\.lock_batch\(p_batch, p_fence, true\);/);
    expect(f).toMatch(/IF b\.state <> 'frozen' THEN/);
    expect(f).toMatch(/IF b\.sealed_at IS NOT NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/jsonb_array_length\(p_items\) > 1000/);
    expect(f).toMatch(/octet_length\(p_items::text\) > 1048576/);
    expect(f).toMatch(/IS DISTINCT FROM 'audienceKind,audienceStaff,inputHash,partitionKey,partitionKind'/);
    expect(f).toMatch(/reporting_private\.order_key\(e\.v ->> 'partitionKey'\) IS DISTINCT FROM e\.v ->> 'partitionKey' THEN 'order partition key is not a trimmed order key'/);
    expect(f).toMatch(/WHEN pg_catalog\.octet_length\(pg_catalog\.to_json\(e\.v ->> 'partitionKey'\)::text\) > 1048576 - 512 THEN 'partitionKey too large for one claim response'/);
    expect(MAX_CLAIM_KEY_JSON_BYTES).toBe(1048576 - 512);
    expect(f).toMatch(/AND j\.h <> i\.h/);
    expect(f).toMatch(/AND w\.input_hash <> i\.h/);
    expect(f).toMatch(/ON CONFLICT \(batch_id, audience_kind, audience_staff, partition_kind, partition_key\) DO NOTHING/);
  });

  it("manifest: the exact line format and byte order the TypeScript builder uses", () => {
    const m = fn("reporting_private.work_manifest");
    expect(m).toMatch(/'\[' \|\| pg_catalog\.to_json\(w\.audience_kind\)::text \|\| ',' \|\| coalesce\(pg_catalog\.to_json\(w\.audience_staff::text\)::text, 'null'\) \|\| ',' \|\| pg_catalog\.to_json\(w\.partition_kind\)::text \|\| ',' \|\| pg_catalog\.to_json\(w\.partition_key\)::text \|\| ',' \|\| pg_catalog\.to_json\(w\.input_hash\)::text \|\| '\]'/);
    expect(m).toMatch(/E'\\n' ORDER BY w\.audience_kind COLLATE "C", w\.audience_staff::text COLLATE "C" NULLS FIRST, w\.partition_kind COLLATE "C", w\.partition_key COLLATE "C"\), ''\), 'UTF8'\)\), 'hex'\)/);
  });

  it("seal: exact count AND manifest; identical re-seal is a no-op; a different one fails; nothing may be added after", () => {
    const f = fn("public.seal_reporting_work");
    expect(f).toMatch(/IF m\.work_count <> p_expected_count THEN RAISE EXCEPTION/);
    expect(f).toMatch(/IF m\.manifest_hash <> p_manifest_hash THEN RAISE EXCEPTION 'seal_reporting_work: manifest hash mismatch'/);
    expect(f).toMatch(/IF b\.sealed_work_count = p_expected_count AND b\.sealed_manifest_hash = p_manifest_hash THEN RETURN QUERY/);
    expect(f).toMatch(/already sealed with a different manifest/);
  });

  it("claim: sealed frozen batch; limit 1..1000; SKIP LOCKED; serialized-response bound (T13B2a-3); work id as text", () => {
    const f = fn("public.claim_reporting_work");
    expect(f).toMatch(/^CREATE FUNCTION public\.claim_reporting_work\(p_batch uuid, p_fence bigint, p_limit integer DEFAULT 100\) RETURNS TABLE \(work_id text,/);
    expect(f).toMatch(/IF b\.state <> 'frozen' OR b\.sealed_at IS NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN/);
    expect(f).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(f).not.toMatch(/octet_length\(w\.partition_key\) \+ 200/);
    // The SQL measures exactly the json_build_object text the TypeScript claimRowBytes models, in the returned column order.
    expect(f).toMatch(/2 \+ sum\(4 \+ pg_catalog\.octet_length\(pg_catalog\.json_build_object\( 'work_id', w\.work_id::text, 'audience_kind', w\.audience_kind, 'audience_staff', w\.audience_staff, 'partition_kind', w\.partition_kind, 'partition_key', w\.partition_key, 'input_hash', w\.input_hash, 'expected_chunk_count', w\.expected_chunk_count, 'staged_chunks', \(SELECT count\(\*\)::integer FROM reporting_private\.partition_results r WHERE r\.work_id = w\.work_id\)\)::text\)\) OVER \(ORDER BY w\.work_id ROWS UNBOUNDED PRECEDING\) AS run/);
    expect(f).toMatch(/FILTER \(WHERE z\.run <= 1048576\)/);
    expect(f).toMatch(/IF v_picked > 0 AND pg_catalog\.cardinality\(v_ids\) = 0 THEN RAISE EXCEPTION 'claim_reporting_work: work % does not fit one 1 MiB claim response', v_first;/);
    // Only the returned prefix is leased; the returned rows are exactly the leased ones.
    expect(f).toMatch(/UPDATE reporting_private\.partition_work w SET state = 'leased', lease_fence = p_fence WHERE w\.work_id = ANY \(v_ids\);/);
    expect(f).toMatch(/SELECT w\.work_id::text, .* FROM reporting_private\.partition_work w WHERE w\.work_id = ANY \(v_ids\) ORDER BY w\.work_id;/);
  });

  it("stage: hash of the exact UTF-8 bytes BEFORE parsing; exactly five arrays; replay/conflict; claimed under the fence; ≤1,000 rows across all five; completion digest", () => {
    const f = fn("reporting_private.stage_one");
    const hashAt = f.indexOf("pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') <> v_hash");
    expect(hashAt).toBeGreaterThan(0);
    expect(hashAt).toBeLessThan(f.indexOf("v_rows := v_text::jsonb;"));
    expect(f).not.toMatch(/sha256\([^)]*::text/); // never hashes jsonb::text
    expect(f).toMatch(/p_partition !~ '\^\[1-9\]\[0-9\]\{0,18\}\$'/);
    expect(f).toMatch(/IS DISTINCT FROM 'canonicalRows,chunkCount,chunkHash,chunkNo,resultDigest'/);
    expect(f).toMatch(/IS DISTINCT FROM 'cancel_edges,event_facts,order_occurrences,source_issue_facts,timing_facts'/);
    expect([...RESULT_TABLES].sort().join(",")).toBe("cancel_edges,event_facts,order_occurrences,source_issue_facts,timing_facts");
    for (const t of RESULT_TABLES) {
      expect(f).toContain(`pg_catalog.jsonb_typeof(v_rows -> '${t}') <> 'array'`);
      expect(f).toContain(`pg_catalog.jsonb_array_length(v_rows -> '${t}')`);
    }
    expect(f).toMatch(/octet_length\(p_chunk::text\) > 1048576/);
    expect(f).toMatch(/> 1000 THEN RAISE EXCEPTION 'stage: more than 1000 rows in one chunk'/);
    expect(f).toMatch(/IF v_prev = v_hash THEN RETURN QUERY SELECT p_partition, v_no, false, w\.state = 'done';/);
    expect(f).toMatch(/was already saved with different content/);
    expect(f).toMatch(/IF w\.state <> 'leased' OR w\.lease_fence IS DISTINCT FROM p_fence THEN/);
    // Rows are fully validated before the chunk is saved, and the chunk before the work completes.
    expect(f.indexOf("v_bad := reporting_private.check_staged_rows(p_batch, w, v_rows);")).toBeLessThan(f.indexOf("INSERT INTO reporting_private.partition_results"));
    expect(f.indexOf("INSERT INTO reporting_private.partition_results")).toBeLessThan(f.indexOf("SET state = 'done'"));
    expect(f).toMatch(/string_agg\(r\.chunk_hash, E'\\n' ORDER BY r\.chunk_no\)/);
    expect(f).toMatch(/IF v_all <> v_dig THEN RAISE EXCEPTION/);
    expect(f).toMatch(/SET state = 'done', chunk_count = v_count, result_digest = v_dig, completed_at = now\(\)/);
  });

  it("T13B2a-1: staged_row_problem checks every column of every array, with the TypeScript validator's messages, in the same order", () => {
    const f = fn("reporting_private.staged_row_problem");
    expect(f).toMatch(/^CREATE FUNCTION reporting_private\.staged_row_problem\(p_table text, v jsonb\) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = ''/);
    for (const t of RESULT_TABLES) {
      const from = f.slice(f.indexOf(`WHEN '${t}' THEN CASE`));
      const next = RESULT_TABLES.map((x) => from.indexOf(`WHEN '${x}' THEN CASE`)).filter((i) => i > 0);
      const body = from.slice(0, Math.min(...next, from.indexOf("ELSE 'unknown result table"))); // this table's block only
      const sqlMsgs = [...body.matchAll(/THEN '([^']+)'/g)].map((m) => m[1]);
      // TypeScript's message for each column, obtained by making ONLY that column wrong (an object is never valid).
      const sample = { id: "x", str: "s", uuid: STAFF, ts: "2026-01-15T09:00:00Z", date: "2026-01-15", int4: 1, int53: 1, num: 1, bool: true } as Record<string, unknown>;
      const base = Object.fromEntries(RESULT_COLUMNS[t].map(([k, kind, , values]) => [k, kind === "enum" ? values![0] : sample[kind]]));
      const tsMsgs = RESULT_COLUMNS[t].map(([c]) => resultRowProblem(t, { ...base, [c]: {} }));
      expect(new Set(tsMsgs).size, t).toBe(tsMsgs.length);
      expect(sqlMsgs.slice(0, tsMsgs.length), t).toEqual(tsMsgs);
      for (const [c, kind, nullable] of RESULT_COLUMNS[t]) {
        const numeric = ["int4", "int53", "num"].includes(kind);
        const shape = `${numeric || kind === "date" ? "CASE WHEN " : ""}coalesce(pg_catalog.jsonb_typeof(v -> '${c}'), 'missing') <> '${kind === "bool" ? "boolean" : numeric ? "number" : "string"}'`;
        expect(body, `${t}.${c}`).toContain(nullable ? `coalesce(pg_catalog.jsonb_typeof(v -> '${c}'), 'missing') <> 'null' AND (${shape}` : `WHEN (${shape}`);
      }
    }
    // Relational rules, also in TypeScript.
    expect(f).toContain("THEN 'event_facts: role verification needs exactly item_status, items, product_kind, line_key, timing_stream and timing_weight'");
    expect(f).toContain("THEN 'event_facts: invalid_detail is required exactly for role invalid'");
    expect(f).toContain("THEN 'cancel_edges: parent_role and parent_created_at are both set or both null'");
    expect(f).toContain("THEN 'cancel_edges: pair is required exactly for a verification or terminal parent'");
    // Numeric casts only after the shape is known (CASE fixes evaluation order).
    expect(f).toMatch(/CASE WHEN coalesce\(pg_catalog\.jsonb_typeof\(v -> 'quantity'\), 'missing'\) <> 'number' OR \(v ->> 'quantity'\) !~ '\^-\?\[0-9\]\{1,10\}\$' THEN true ELSE \(v ->> 'quantity'\)::bigint NOT BETWEEN -2147483648 AND 2147483647 END/);
    expect(f).toMatch(/ELSE \(v ->> 'items'\)::bigint > 9007199254740991 END/);
    // T13B2a-1 residual: production_date is a real calendar day; the native make_date only runs once the arithmetic proved it valid.
    const pd = f.slice(f.indexOf("WHEN coalesce(pg_catalog.jsonb_typeof(v -> 'production_date')"), f.indexOf("THEN 'event_facts.production_date must be"));
    const Y = "pg_catalog.substr((v ->> 'production_date'), 1, 4)::integer";
    const M = "pg_catalog.substr((v ->> 'production_date'), 6, 2)::integer";
    const D = "pg_catalog.substr((v ->> 'production_date'), 9, 2)::integer";
    for (const part of [
      "<> 'null' AND (CASE WHEN",
      "!~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true",
      `WHEN ${Y} < 1 OR ${M} NOT BETWEEN 1 AND 12 OR ${D} < 1`,
      `OR ${D} > CASE WHEN ${M} = 2 THEN CASE WHEN (${Y} % 4 = 0 AND ${Y} % 100 <> 0) OR ${Y} % 400 = 0 THEN 29 ELSE 28 END WHEN ${M} IN (4, 6, 9, 11) THEN 30 ELSE 31 END THEN true`,
      `ELSE pg_catalog.make_date(${Y}, ${M}, ${D}) IS NULL END)`,
    ]) expect(pd, part).toContain(part);
    expect(pd.indexOf("% 400 = 0")).toBeLessThan(pd.indexOf("make_date"));
  });

  it("rows: exact keys per array (no trusted metadata), structural check BEFORE any cast or lookup, frozen-view ownership, self rows, identity family, cutoff", () => {
    const f = fn("reporting_private.check_staged_rows");
    expect(f).not.toMatch(/jsonb_populate_record/);
    expect(f).toMatch(/has unexpected keys \(site, audience, partition, rule and validity are set by the server\)/);
    expect(f).toMatch(/FROM \(VALUES \('event_facts'\), \('cancel_edges'\), \('order_occurrences'\), \('timing_facts'\), \('source_issue_facts'\)\) AS t\(tbl\)/);
    for (const t of RESULT_TABLES) {
      const keys = t === "source_issue_facts" ? f.match(/ELSE '([^']+)' END, ','\)\)/)?.[1] : f.match(new RegExp(`WHEN '${t}' THEN '([^']+)'`))?.[1];
      expect(keys?.split(","), t).toEqual([...COLS[t]].sort());
      for (const k of ["site", "audience_kind", "audience_staff", "valid_from_seq", "valid_to_seq", "rule_version", "partition_kind", "partition_key"]) expect(keys?.split(","), `${t}.${k}`).not.toContain(k);
    }
    const structural = f.indexOf("v_bad := reporting_private.staged_row_problem(r.tbl, r.v);");
    expect(structural).toBeGreaterThan(0);
    expect(structural).toBeLessThan(f.indexOf("img := reporting_private.frozen_image(p_batch, v_id);"));
    expect(structural).toBeLessThan(f.indexOf("::timestamptz"));
    expect(f).toMatch(/own\.partition_kind <> p_work\.partition_kind OR own\.partition_key <> p_work\.partition_key/);
    expect(f).toMatch(/p_work\.audience_kind = 'self' AND \(img ->> 'staff_id'\) IS DISTINCT FROM p_work\.audience_staff::text/);
    expect(f).toMatch(/IF \(r\.tbl = 'source_issue_facts'\) <> \(coalesce\(reporting_private\.order_key\(v_id\), ''\) = ''\) THEN/);
    expect(f).toMatch(/IF \(img ->> 'created_at'\)::timestamptz > b\.source_cutoff THEN RETURN v_pre \|\| ' is after the batch cutoff'; END IF;/);
    const fi = fn("reporting_private.frozen_image");
    expect(fi).toMatch(/IF b\.kind = 'rebuild' THEN SELECT sc\.image INTO img FROM reporting_private\.source_candidate sc/);
    expect(fi).toMatch(/FROM reporting_private\.batch_events be .* IF FOUND THEN RETURN img; END IF; SELECT s\.image INTO img FROM reporting_private\.source_current s/);
    expect(fn("reporting_private.owner_partition")).toMatch(/coalesce\(reporting_private\.order_key\(p_image ->> 'order_number'\), ''\) <> '' THEN 'order' ELSE 'event'/);
  });

  it("T13B2a-2: every raw field of every array is bound to its primary frozen source; parents and predecessors to the frozen view as the audience sees it", () => {
    const f = fn("reporting_private.check_staged_rows");
    const bound: Array<[string, string]> = [
      ["(r.v ->> 'event_type') IS DISTINCT FROM (img ->> 'event_type')", "event_type"],
      ["(r.v ->> 'created_at')::timestamptz IS DISTINCT FROM (img ->> 'created_at')::timestamptz", "created_at"],
      ["(r.v ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id')", "staff_id"],
      ["(r.v ->> 'raw_order') IS DISTINCT FROM (img ->> 'order_number')", "raw_order"],
      ["(r.v ->> 'parent_event_id') IS DISTINCT FROM (img ->> 'parent_event_id')", "parent_event_id"],
      ["(r.v ->> 'department') IS DISTINCT FROM (img ->> 'department')", "department"],
      ["(r.v ->> 'case_id') IS DISTINCT FROM (img ->> 'cs_case_id')", "case_id"],
      ["(r.v ->> 'sku') IS DISTINCT FROM (img ->> 'line_sku')", "sku"],
      ["(r.v -> 'quantity') IS DISTINCT FROM coalesce(img -> 'line_quantity', 'null'::jsonb)", "quantity"],
      ["v_at::timestamptz IS DISTINCT FROM (img ->> 'created_at')::timestamptz", "occurred_at"],
    ];
    const between = (a: string, b: string) => {
      const i = f.indexOf(a);
      expect(i, a).toBeGreaterThan(0);
      return f.slice(i, f.indexOf(b, i + a.length));
    };
    // Each array's own branch binds its own raw fields (a line in another branch does not count).
    const branches: Array<[string, string, string[]]> = [
      ["IF r.tbl IN ('event_facts', 'source_issue_facts') THEN", "END IF; IF r.tbl = 'event_facts' THEN", ["event_type", "created_at", "staff_id", "raw_order", "parent_event_id"]],
      ["IF r.tbl = 'event_facts' THEN", "ELSIF r.tbl = 'cancel_edges' THEN", ["department", "case_id", "sku", "quantity"]],
      ["ELSIF r.tbl = 'order_occurrences' THEN", "ELSIF r.tbl = 'timing_facts' THEN", ["raw_order", "case_id", "staff_id", "occurred_at"]],
      ["ELSIF r.tbl = 'timing_facts' THEN", "END LOOP; END IF; END LOOP;", ["staff_id", "occurred_at"]],
    ];
    for (const [a, b, fields] of branches) {
      const br = between(a, b);
      for (const field of fields) {
        const [cond] = bound.find(([, x]) => x === field)!;
        expect(br, `${a} ${field}`).toContain(`IF ${cond} THEN RETURN v_pre || ' ${field} differs from the frozen source'`);
      }
    }
    expect(between("IF r.tbl = 'event_facts' THEN", "ELSIF r.tbl = 'cancel_edges' THEN")).toContain("order_key is not the trimmed raw order");
    expect(between("ELSIF r.tbl = 'order_occurrences' THEN", "ELSIF r.tbl = 'timing_facts' THEN")).toContain("order_key is not the trimmed raw order");
    expect(f).toContain("IF r.tbl IN ('event_facts', 'source_issue_facts') THEN");
    expect(f).toContain("(img ->> 'event_type') IS DISTINCT FROM 'cancelled'");
    expect(f).toContain("(img ->> 'event_type') NOT IN ('completed', 'dispatched')");
    expect(f).toContain("(img ->> 'event_type') IS DISTINCT FROM 'line_verified'");
    expect(f).toContain("(r.v -> 'is_self') IS DISTINCT FROM pg_catalog.to_jsonb((img ->> 'parent_event_id') = v_id)");
    expect(f).toMatch(/v_vis := ref IS NOT NULL AND \(ref ->> 'event_type'\) IN \('line_verified', 'completed', 'dispatched', 'cancelled'\) AND \(ref ->> 'created_at'\)::timestamptz <= b\.source_cutoff AND \(p_work\.audience_kind = 'site' OR \(ref ->> 'staff_id'\) IS NOT DISTINCT FROM p_work\.audience_staff::text\);/);
    expect(f).toContain("IF (pg_catalog.jsonb_typeof(r.v -> 'parent_role') <> 'null') <> v_vis THEN RETURN v_pre || ' parent existence differs from the frozen view'");
    expect(f).toContain("IF v_vis AND (r.v ->> 'parent_created_at')::timestamptz IS DISTINCT FROM (ref ->> 'created_at')::timestamptz THEN");
    expect(f).toMatch(/FOREACH v_ref IN ARRAY ARRAY\[r\.v ->> 'prev_all_event_id', r\.v ->> 'prev_same_type_event_id'\] LOOP/);
    expect(f).toContain("(ref ->> 'staff_id') IS DISTINCT FROM (img ->> 'staff_id') OR (ref ->> 'created_at')::timestamptz > (img ->> 'created_at')::timestamptz OR v_ref = v_id");
    // No second counting implementation: derived fields are never recomputed in SQL.
    for (const derived of ["'items'", "'item_status'", "'product_kind'", "'line_key'", "'timing_weight'", "'work_type'", "'role'", "'pair'", "'weight'"]) {
      expect(f, derived).not.toContain(`r.v ->> ${derived}`);
    }
  });

  it("bulk: ≤100 entries and 1 MiB; exact {partition, chunk}; one function body, no exception handler, so any failure rolls back every entry", () => {
    const f = fn("public.stage_reporting_results");
    expect(f).toMatch(/jsonb_array_length\(p_results\) > 100/);
    expect(f).toMatch(/octet_length\(p_results::text\) > 1048576/);
    expect(f).toMatch(/IS DISTINCT FROM 'chunk,partition'/);
    expect(f).toMatch(/RETURN QUERY SELECT \* FROM reporting_private\.stage_one\(p_batch, p_fence, e\.v ->> 'partition', e\.v -> 'chunk'\);/);
    expect(f).not.toMatch(/EXCEPTION WHEN/);
    expect(fn("public.stage_reporting_result")).toMatch(/RETURN QUERY SELECT \* FROM reporting_private\.stage_one\(p_batch, p_fence, p_partition, p_chunk\);/);
    expect(fn("reporting_private.check_staged_rows")).not.toMatch(/EXCEPTION WHEN/);
  });

  it("every B2a function: invoker, empty search path, no dynamic SQL; RPCs service-only", () => {
    for (const n of ["public.plan_reporting_work", "public.seal_reporting_work", "public.claim_reporting_work", "public.stage_reporting_result", "public.stage_reporting_results", "reporting_private.stage_one", "reporting_private.check_staged_rows", "reporting_private.staged_row_problem", "reporting_private.frozen_image", "reporting_private.owner_partition", "reporting_private.work_manifest", "reporting_private.partition_work_guard"]) {
      const f = fn(n);
      expect(f, n).toMatch(/SECURITY INVOKER SET search_path = ''/);
      expect(f, n).not.toMatch(/\bEXECUTE\b|\bformat\b/i);
    }
    for (const sig of ["public.plan_reporting_work(uuid, bigint, jsonb)", "public.seal_reporting_work(uuid, bigint, integer, text)", "public.claim_reporting_work(uuid, bigint, integer)", "public.stage_reporting_result(uuid, bigint, text, jsonb)", "public.stage_reporting_results(uuid, bigint, jsonb)"]) {
      expect(codes).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated`);
      expect(codes).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
    }
    expect(codes).toContain("REVOKE ALL ON FUNCTION reporting_private.staged_row_problem(text, jsonb) FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT EXECUTE ON FUNCTION reporting_private.staged_row_problem(text, jsonb) TO service_role");
    expect(codes).toContain("REVOKE ALL ON FUNCTION reporting_private.partition_work_guard() FROM PUBLIC, anon, authenticated, service_role");
  });
});

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

describe("B2a wrappers", () => {
  function fake(data: unknown, error: { message: string; code?: string } | null = null) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: RpcClient = { rpc: async (f, a) => (calls.push([f, a]), { data, error }) };
    return { client, calls };
  }
  const d: WorkDescriptor = { audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", inputHash: H("a") };

  it("plan validates every descriptor and the size before calling", async () => {
    const { client, calls } = fake([{ inserted: 1, replayed: 0, planned_total: 1 }]);
    await expect(planReportingWork(client, BATCH, 7, [{ ...d, partitionKey: " 5001" }])).rejects.toThrow(/descriptor 1: order partition key/);
    await expect(planReportingWork(client, BATCH, 7, Array.from({ length: 1001 }, () => d))).rejects.toThrow(/at most 1000/);
    expect(calls).toEqual([]);
    expect(await planReportingWork(client, BATCH, 7, [d])).toEqual({ inserted: 1, replayed: 0, plannedTotal: 1 });
  });

  it("seal sends the count and the manifest computed from the planned descriptors", async () => {
    const hash = reportingManifestHash([d]);
    const { client, calls } = fake([{ batch_id: BATCH, work_count: 1, manifest_hash: hash, sealed_at: "t", replay: false }]);
    expect(await sealReportingWork(client, BATCH, 7, [d])).toEqual({ workCount: 1, manifestHash: hash, replay: false });
    expect(calls[0][1]).toEqual({ p_batch: BATCH, p_fence: 7, p_expected_count: 1, p_manifest_hash: hash });
    await expect(sealReportingWork(fake([{ batch_id: BATCH, work_count: 1, manifest_hash: H("0"), sealed_at: "t", replay: false }]).client, BATCH, 7, [d])).rejects.toThrow(/different manifest/);
  });

  it("claim keeps work ids as decimal strings and validates every descriptor", async () => {
    const row = { work_id: "9007199254740993", audience_kind: "site", audience_staff: null, partition_kind: "order", partition_key: "5001", input_hash: H("a"), expected_chunk_count: null, staged_chunks: 0 };
    const [w] = await claimReportingWork(fake([row]).client, BATCH, 7, 10);
    expect(w.workId).toBe("9007199254740993");
    await expect(claimReportingWork(fake([{ ...row, work_id: 12 }]).client, BATCH, 7)).rejects.toThrow(/decimal string/);
    await expect(claimReportingWork(fake([{ ...row, partition_key: " 5001" }]).client, BATCH, 7)).rejects.toThrow(/claimed work/);
    await expect(claimReportingWork(fake([]).client, BATCH, 7, 1001)).rejects.toThrow(/limit/);
  });

  it("T13B2a-3: claim refuses a response over 1 MiB and accepts the bounded prefix of the escaping-heavy case", async () => {
    const mk = (i: number) => ({ work_id: String(1000 + i), audience_kind: "site", audience_staff: null, partition_kind: "event", partition_key: String(i).padStart(3, "0") + '"'.repeat(800), input_hash: H("a"), expected_chunk_count: null, staged_chunks: 0 });
    const all = Array.from({ length: 1000 }, (_, i) => mk(i));
    await expect(claimReportingWork(fake(all).client, BATCH, 7, 1000)).rejects.toThrow(/claim response over 1 MiB/);
    const prefix = claimPrefix(all.map((r) => ({ workId: r.work_id, audienceKind: "site" as const, audienceStaff: null, partitionKind: "event" as const, partitionKey: r.partition_key, inputHash: r.input_hash, expectedChunkCount: null, stagedChunks: 0 })));
    const got = await claimReportingWork(fake(all.slice(0, prefix.length)).client, BATCH, 7, 1000);
    expect(got.map((w) => w.workId)).toEqual(prefix.map((w) => w.workId));
  });

  it("stage validates the work id; bulk enforces 1..100 entries and the result count; database errors keep their code", async () => {
    const [c] = buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
    await expect(stageReportingResult(fake([]).client, BATCH, 7, { partition: "0", chunk: c })).rejects.toThrow(/positive decimal/);
    await expect(stageReportingResults(fake([]).client, BATCH, 7, [])).rejects.toThrow(/1\.\.100/);
    await expect(stageReportingResults(fake([{ work_id: "1", chunk_no: 0, stored: true, done: true }]).client, BATCH, 7, [{ partition: "1", chunk: c }, { partition: "2", chunk: c }])).rejects.toThrow(/different number/);
    const err = await stageReportingResult(fake(null, { message: "reporting batch is no longer valid: capture epoch changed", code: "P0001" }).client, BATCH, 7, { partition: "1", chunk: c }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportingJobError);
    expect(err.code).toBe("P0001");
  });
});
