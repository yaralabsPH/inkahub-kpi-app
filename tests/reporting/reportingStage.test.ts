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
  claimReportingWork,
  compareUtf8,
  descriptorProblem,
  manifestLine,
  MAX_BULK_ENTRIES,
  packStageRequests,
  planReportingWork,
  reportingManifestHash,
  sealReportingWork,
  sortDescriptors,
  stageReportingResult,
  stageReportingResults,
  type ChunkEnvelope,
  type ResultRows,
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
  const rows = (n: number, pad = 0): ResultRows => ({ event_facts: Array.from({ length: n }, (_, i) => row(i, pad)), cancel_edges: [], order_occurrences: [], timing_facts: [] });

  it("an empty replacement is ONE chunk of four empty arrays", () => {
    const c = buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [] });
    expect(c).toHaveLength(1);
    expect(JSON.parse(c[0].canonicalRows)).toEqual({ cancel_edges: [], event_facts: [], order_occurrences: [], timing_facts: [] });
    expect(c[0]).toMatchObject({ chunkNo: 0, chunkCount: 1 });
  });

  it("at most 1,000 rows per chunk; contiguous numbering; one digest over the ordered chunk hashes", () => {
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
type Img = { id: string; order_number: string | null; staff_id: string; created_at: string; parent_event_id?: string | null };
const COLS: Record<string, string[]> = {
  event_facts: ["case_id", "created_at", "department", "event_id", "event_type", "invalid_detail", "item_issue_detail", "item_issue_kind", "item_status", "items", "line_key", "order_key", "parent_event_id", "product_kind", "production_date", "quantity", "raw_order", "role", "sku", "staff_id", "timing_stream", "timing_weight", "work_type"],
  cancel_edges: ["cancel_event_id", "is_self", "pair", "parent_created_at", "parent_event_id", "parent_role"],
  order_occurrences: ["case_id", "occurred_at", "order_key", "raw_order", "staff_id", "terminal_event_id", "work_type"],
  timing_facts: ["event_id", "occurred_at", "prev_all_event_id", "prev_same_type_event_id", "staff_id", "weight", "work_type"],
};
const jsTrim = (s: string | null) => (s ?? "").trim();

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
  checkRows(w: Work, rows: Record<string, Array<Record<string, unknown>>>): void {
    for (const t of Object.keys(COLS)) {
      rows[t].forEach((r, i) => {
        if (Object.keys(r).sort().join(",") !== [...COLS[t]].sort().join(",")) throw new Error(`${t}[${i + 1}] has unexpected keys`);
        const id = String(t === "cancel_edges" ? r.cancel_event_id : t === "order_occurrences" ? r.terminal_event_id : r.event_id);
        const img = this.frozen.get(id);
        if (!img) throw new Error(`${t}[${i + 1}] event ${id} is not in the frozen view`);
        const [pk, key] = this.owner(img);
        if (pk !== w.partitionKind || key !== w.partitionKey) throw new Error(`${t}[${i + 1}] event ${id} belongs to partition ${pk}/${key}`);
        if (w.audienceKind === "self" && img.staff_id !== w.audienceStaff) throw new Error(`${t}[${i + 1}] event ${id} is not the self audience's own row`);
        if (t === "event_facts") {
          if (r.created_at !== img.created_at) throw new Error(`event_facts[${i + 1}] created_at differs from the frozen source`);
          if (String(r.created_at) > this.cutoff) throw new Error(`event_facts[${i + 1}] is after the batch cutoff`);
          if (r.raw_order !== img.order_number) throw new Error(`event_facts[${i + 1}] raw_order differs`);
          if (r.order_key !== jsTrim(r.raw_order as string | null)) throw new Error(`event_facts[${i + 1}] order_key is not the trimmed raw order`);
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
    if (Object.keys(rows).sort().join(",") !== "cancel_edges,event_facts,order_occurrences,timing_facts") throw new Error("canonicalRows must hold exactly the four arrays");
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

describe("staging rules (reference model of 0038)", () => {
  const imgs = new Map<string, Img>([
    ["v1", { id: "v1", order_number: "5001", staff_id: STAFF, created_at: "2026-01-15T09:00:00Z" }],
    ["v2", { id: "v2", order_number: " 5001 ", staff_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", created_at: "2026-01-15T09:05:00Z" }],
    ["c1", { id: "c1", order_number: "5001", staff_id: STAFF, created_at: "2026-01-15T09:10:00Z", parent_event_id: "v1" }],
    ["x1", { id: "x1", order_number: "  ", staff_id: STAFF, created_at: "2026-01-15T09:20:00Z" }],
    ["f1", { id: "f1", order_number: "5001", staff_id: STAFF, created_at: "2026-02-20T09:00:00Z" }],
  ]);
  const fact = (id: string, over: Record<string, unknown> = {}) => {
    const img = imgs.get(id)!;
    const base: Record<string, unknown> = Object.fromEntries(COLS.event_facts.map((k) => [k, null]));
    return { ...base, event_id: id, created_at: img.created_at, raw_order: img.order_number, order_key: jsTrim(img.order_number), event_type: "line_verified", role: "verification", staff_id: img.staff_id, ...over };
  };
  const edge = (id: string) => ({ cancel_event_id: id, parent_event_id: "v1", is_self: false, parent_role: "verification", parent_created_at: "2026-01-15T09:00:00Z", pair: "valid" });
  const env = (rows: Partial<ResultRows>) => buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], ...rows } as ResultRows);
  function setup() {
    const db = new StageRef(imgs, "2026-02-10T00:00:00Z");
    const add = (id: string, w: Partial<Work>) => db.works.set(id, { id, batch: BATCH, audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "5001", state: "leased", fence: 7, expCount: null, expDigest: null, ...w });
    add("1", {});
    add("2", { partitionKind: "event", partitionKey: "x1" });
    add("3", { audienceKind: "self", audienceStaff: STAFF });
    add("4", { state: "pending", fence: null });
    return db;
  }

  it("all chunks present with the declared digest complete the work; one missing chunk keeps it open", () => {
    const db = setup();
    const chunks = buildChunks({ event_facts: Array.from({ length: 1200 }, () => fact("v1")), cancel_edges: [], order_occurrences: [], timing_facts: [] });
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
    const two = buildChunks({ event_facts: Array.from({ length: 1001 }, () => fact("v1")), cancel_edges: [], order_occurrences: [], timing_facts: [] });
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
    expect(db.works.get("1")!.state).toBe("leased");
  });

  it("ownership: rows must belong to the claimed partition (JS-trimmed order), be in the frozen view, and be the self audience's own rows", () => {
    const db = setup();
    // v2's order " 5001 " trims to 5001: same owner.
    expect(db.stage(7, "1", env({ event_facts: [fact("v1"), fact("v2")], cancel_edges: [edge("c1")] })[0]).done).toBe(true);
    expect(() => setup().stage(7, "2", env({ event_facts: [fact("v1")] })[0])).toThrow(/belongs to partition order\/5001/);
    expect(setup().stage(7, "2", env({ event_facts: [fact("x1")] })[0]).done).toBe(true);
    expect(() => setup().stage(7, "1", env({ event_facts: [fact("v1", { event_id: "zz" })] })[0])).toThrow(/not in the frozen view/);
    expect(() => setup().stage(7, "3", env({ event_facts: [fact("v2")] })[0])).toThrow(/not the self audience's own row/);
  });

  it("payload attempts to set trusted metadata (site, audience, partition, rule, validity) are refused", () => {
    for (const k of ["site", "audience_kind", "audience_staff", "partition_key", "rule_version", "valid_from_seq"]) {
      expect(() => setup().stage(7, "1", env({ event_facts: [{ ...fact("v1"), [k]: "x" }] })[0]), k).toThrow(/unexpected keys/);
    }
  });

  it("frozen-source drift in a row (time, order, key) and rows after the cutoff are refused", () => {
    expect(() => setup().stage(7, "1", env({ event_facts: [fact("v1", { created_at: "2026-01-15T09:00:01Z" })] })[0])).toThrow(/created_at differs/);
    expect(() => setup().stage(7, "1", env({ event_facts: [fact("v1", { raw_order: "5002", order_key: "5002" })] })[0])).toThrow(/raw_order differs/);
    expect(() => setup().stage(7, "1", env({ event_facts: [fact("v2", { order_key: " 5001 " })] })[0])).toThrow(/order_key is not the trimmed raw order/);
    expect(() => setup().stage(7, "1", env({ event_facts: [fact("f1")] })[0])).toThrow(/after the batch cutoff/);
  });

  it("unclaimed work, another fence, and completed work refuse new chunks", () => {
    const [c] = env({ event_facts: [] });
    expect(() => setup().stage(7, "4", c)).toThrow(/not claimed under fence 7/);
    expect(() => setup().stage(8, "1", c)).toThrow(/not claimed under fence 8/);
    expect(() => setup().stage(7, "9", c)).toThrow(/does not belong/);
  });

  it("bulk: one invalid entry rolls back the whole request; bulk and single-work staging end in the same state", () => {
    const good1 = env({ event_facts: [fact("v1")] })[0];
    const good2 = env({ event_facts: [fact("x1")] })[0];
    const bad = { ...good1, chunkHash: H("0") };
    const db = setup();
    expect(() => db.bulk(7, [{ partition: "1", chunk: good1 }, { partition: "2", chunk: good2 }, { partition: "3", chunk: bad }])).toThrow();
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

  it("plan: frozen unsealed batch under a live fence; ≤1,000 descriptors and 1 MiB; exact shape; conflicts fail; identical replay is a no-op", () => {
    const f = fn("public.plan_reporting_work");
    expect(f).toMatch(/b := reporting_private\.lock_batch\(p_batch, p_fence, true\);/);
    expect(f).toMatch(/IF b\.state <> 'frozen' THEN/);
    expect(f).toMatch(/IF b\.sealed_at IS NOT NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/jsonb_array_length\(p_items\) > 1000/);
    expect(f).toMatch(/octet_length\(p_items::text\) > 1048576/);
    expect(f).toMatch(/IS DISTINCT FROM 'audienceKind,audienceStaff,inputHash,partitionKey,partitionKind'/);
    expect(f).toMatch(/reporting_private\.order_key\(e\.v ->> 'partitionKey'\) IS DISTINCT FROM e\.v ->> 'partitionKey' THEN 'order partition key is not a trimmed order key'/);
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

  it("claim: sealed frozen batch; limit 1..1000; SKIP LOCKED; ≤1 MiB; work id as text", () => {
    const f = fn("public.claim_reporting_work");
    expect(f).toMatch(/^CREATE FUNCTION public\.claim_reporting_work\(p_batch uuid, p_fence bigint, p_limit integer DEFAULT 100\) RETURNS TABLE \(work_id text,/);
    expect(f).toMatch(/IF b\.state <> 'frozen' OR b\.sealed_at IS NULL THEN RAISE EXCEPTION/);
    expect(f).toMatch(/IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN/);
    expect(f).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(f).toMatch(/s\.run <= 1048576/);
    expect(f).toMatch(/SET state = 'leased', lease_fence = p_fence/);
    expect(f).toMatch(/SELECT c\.work_id::text,/);
  });

  it("stage: hash of the exact UTF-8 bytes BEFORE parsing; exact envelope and arrays; replay/conflict; claimed under the fence; ≤1,000 rows; completion digest", () => {
    const f = fn("reporting_private.stage_one");
    const hashAt = f.indexOf("pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_text, 'UTF8')), 'hex') <> v_hash");
    expect(hashAt).toBeGreaterThan(0);
    expect(hashAt).toBeLessThan(f.indexOf("v_rows := v_text::jsonb;"));
    expect(f).not.toMatch(/sha256\([^)]*::text/); // never hashes jsonb::text
    expect(f).toMatch(/p_partition !~ '\^\[1-9\]\[0-9\]\{0,18\}\$'/);
    expect(f).toMatch(/IS DISTINCT FROM 'canonicalRows,chunkCount,chunkHash,chunkNo,resultDigest'/);
    expect(f).toMatch(/IS DISTINCT FROM 'cancel_edges,event_facts,order_occurrences,timing_facts'/);
    expect(f).toMatch(/octet_length\(p_chunk::text\) > 1048576/);
    expect(f).toMatch(/> 1000 THEN RAISE EXCEPTION 'stage: more than 1000 rows in one chunk'/);
    expect(f).toMatch(/IF v_prev = v_hash THEN RETURN QUERY SELECT p_partition, v_no, false, w\.state = 'done';/);
    expect(f).toMatch(/was already saved with different content/);
    expect(f).toMatch(/IF w\.state <> 'leased' OR w\.lease_fence IS DISTINCT FROM p_fence THEN/);
    expect(f).toMatch(/string_agg\(r\.chunk_hash, E'\\n' ORDER BY r\.chunk_no\)/);
    expect(f).toMatch(/IF v_all <> v_dig THEN RAISE EXCEPTION/);
    expect(f).toMatch(/SET state = 'done', chunk_count = v_count, result_digest = v_dig, completed_at = now\(\)/);
  });

  it("rows: exact keys per table (no trusted metadata), typed parse, frozen-view ownership, self rows, source consistency, cutoff", () => {
    const f = fn("reporting_private.check_staged_rows");
    expect(f).toMatch(/has unexpected keys \(site, audience, partition, rule and validity are set by the server\)/);
    for (const t of ["event_facts", "cancel_edges", "order_occurrences", "timing_facts"]) expect(f).toContain(`jsonb_populate_record(NULL::reporting_private.${t}, r.v)`);
    expect(f).toMatch(/img := reporting_private\.frozen_image\(p_batch, v_id\);/);
    expect(f).toMatch(/own\.partition_kind <> p_work\.partition_kind OR own\.partition_key <> p_work\.partition_key/);
    expect(f).toMatch(/p_work\.audience_kind = 'self' AND \(img ->> 'staff_id'\) IS DISTINCT FROM p_work\.audience_staff::text/);
    expect(f).toMatch(/> b\.source_cutoff THEN RETURN/);
    for (const k of ["site", "audience_kind", "audience_staff", "valid_from_seq", "valid_to_seq", "rule_version", "partition_kind", "partition_key"]) {
      expect(f.match(/WHEN 'event_facts' THEN '([^']+)'/)?.[1].split(",")).not.toContain(k);
    }
    const fi = fn("reporting_private.frozen_image");
    expect(fi).toMatch(/IF b\.kind = 'rebuild' THEN SELECT sc\.image INTO img FROM reporting_private\.source_candidate sc/);
    expect(fi).toMatch(/FROM reporting_private\.batch_events be .* IF FOUND THEN RETURN img; END IF; SELECT s\.image INTO img FROM reporting_private\.source_current s/);
    expect(fn("reporting_private.owner_partition")).toMatch(/coalesce\(reporting_private\.order_key\(p_image ->> 'order_number'\), ''\) <> '' THEN 'order' ELSE 'event'/);
  });

  it("bulk: ≤100 entries and 1 MiB; exact {partition, chunk}; one function body, no exception handler, so any failure rolls back every entry", () => {
    const f = fn("public.stage_reporting_results");
    expect(f).toMatch(/jsonb_array_length\(p_results\) > 100/);
    expect(f).toMatch(/octet_length\(p_results::text\) > 1048576/);
    expect(f).toMatch(/IS DISTINCT FROM 'chunk,partition'/);
    expect(f).toMatch(/RETURN QUERY SELECT \* FROM reporting_private\.stage_one\(p_batch, p_fence, e\.v ->> 'partition', e\.v -> 'chunk'\);/);
    expect(f).not.toMatch(/EXCEPTION WHEN/);
    expect(fn("public.stage_reporting_result")).toMatch(/RETURN QUERY SELECT \* FROM reporting_private\.stage_one\(p_batch, p_fence, p_partition, p_chunk\);/);
  });

  it("every B2a function: invoker, empty search path, no dynamic SQL; RPCs service-only", () => {
    for (const n of ["public.plan_reporting_work", "public.seal_reporting_work", "public.claim_reporting_work", "public.stage_reporting_result", "public.stage_reporting_results", "reporting_private.stage_one", "reporting_private.check_staged_rows", "reporting_private.frozen_image", "reporting_private.owner_partition", "reporting_private.work_manifest", "reporting_private.partition_work_guard"]) {
      const f = fn(n);
      expect(f, n).toMatch(/SECURITY INVOKER SET search_path = ''/);
      expect(f, n).not.toMatch(/\bEXECUTE\b|\bformat\b/i);
    }
    for (const sig of ["public.plan_reporting_work(uuid, bigint, jsonb)", "public.seal_reporting_work(uuid, bigint, integer, text)", "public.claim_reporting_work(uuid, bigint, integer)", "public.stage_reporting_result(uuid, bigint, text, jsonb)", "public.stage_reporting_results(uuid, bigint, jsonb)"]) {
      expect(codes).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated`);
      expect(codes).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role`);
    }
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

  it("stage validates the work id; bulk enforces 1..100 entries and the result count; database errors keep their code", async () => {
    const [c] = buildChunks({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [] });
    await expect(stageReportingResult(fake([]).client, BATCH, 7, { partition: "0", chunk: c })).rejects.toThrow(/positive decimal/);
    await expect(stageReportingResults(fake([]).client, BATCH, 7, [])).rejects.toThrow(/1\.\.100/);
    await expect(stageReportingResults(fake([{ work_id: "1", chunk_no: 0, stored: true, done: true }]).client, BATCH, 7, [{ partition: "1", chunk: c }, { partition: "2", chunk: c }])).rejects.toThrow(/different number/);
    const err = await stageReportingResult(fake(null, { message: "reporting batch is no longer valid: capture epoch changed", code: "P0001" }).client, BATCH, 7, { partition: "1", chunk: c }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportingJobError);
    expect(err.code).toBe("P0001");
  });
});
