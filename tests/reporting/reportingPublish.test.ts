/**
 * Task 13 Part B2b: atomic publication (0038 publish_reporting_batch) and
 * api/_lib/reporting-publish.ts.
 *
 * (1) A reference model of publish_reporting_batch, rule for rule, run on
 *     facts produced by the REAL Task 11 projector, whose daily totals are
 *     compared with the existing reducer (site and self audiences, counted /
 *     excluded / unclassified lines, rework, cancellations, hidden context).
 * (2) Replacement, deletion, moves, rebuild, no-change, replay, mirror and
 *     retained versions, receipts, integrity refusals.
 * (3) The 0038 SQL text for every rule, the fingerprint and the wrapper.
 * Real SQL execution is the staging runner's (tests/staging/reportingPublication.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareProductionEvidence, summarizeProduction, type ProductionEvidenceEvent, type ProductionVisibility, type WorkType } from "../../src/lib/domain/productionCounts";
import { instantMicros } from "../../src/lib/domain/productionInstant";
import { REPORTING_RULE_VERSION, type FrozenPartitionInput, type PartitionResult, type ReportingAudience } from "../../src/lib/domain/productionReporting";
import { projectReportingPartition } from "../../src/lib/domain/productionReportingProjection";
import { publicationFingerprint, publishReportingBatch } from "../../api/_lib/reporting-publish";
import { reportingManifestHash, RESULT_TABLES, resultRowProblem, type ResultRows, type ResultTable, type WorkDescriptor } from "../../api/_lib/reporting-stage";
import { acknowledgeable, pendingForSite, ReportingJobError, type BatchRow, type JournalRow, type RpcClient } from "../../api/_lib/reporting-jobs";
import { splitSqlStatements } from "../staging/sqlStatements";
import { rowsByOwner, type Owner } from "../fixtures/reporting-rows";
import { ANNA, at, BEN, cancel, CUTOFF, day, fourFamilySnapshot, history, resetIds, SITE, SKU, verify } from "../fixtures/reporting-history";

const H = (c: string) => c.repeat(64);
const MAX_SAFE = 9007199254740991;

// ---------------------------------------------------------------------------
// Projector output -> staged rows (the classified fixture; Task 14 owns the real mapping)
// ---------------------------------------------------------------------------

function project(events: readonly ProductionEvidenceEvent[], audience: ReportingAudience): PartitionResult {
  const input: FrozenPartitionInput = { site: SITE, audience, ruleVersion: REPORTING_RULE_VERSION, sourceCutoffUtc: CUTOFF, events: events.filter((e) => e.location === SITE) };
  return projectReportingPartition(input);
}

// ---------------------------------------------------------------------------
// Reference model of publish_reporting_batch
// ---------------------------------------------------------------------------

type Img = Record<string, unknown> & { id: string; location: string; created_at: string };
interface Work { desc: WorkDescriptor; state: "pending" | "leased" | "done"; rows: ResultRows; digest: string }
interface Batch {
  id: string; site: string; kind: "refresh" | "rebuild"; fence: number; state: "frozen" | "published" | "active"; sealed: boolean;
  works: Work[]; events: Map<string, Img | null>; candidate: Map<string, Img>; changeIds: number[]; generation: string | null; cutoff: string;
}
interface FactRow { family: ResultTable; site: string; audKind: string; audStaff: string | null; id: string; owner: Owner; from: number; to: number | null; row: Record<string, unknown> }
interface DailyRow { site: string; audKind: string; audStaff: string | null; date: string; staff: string; workType: string; rework: boolean; from: number; to: number | null; items: number | null; overflow: boolean; lines: number }
interface Gen { id: string; seq: number; site: string; state: "building" | "published" | "superseded"; fingerprint: string | null }

const ID_OF: Record<ResultTable, string> = { event_facts: "event_id", cancel_edges: "cancel_event_id", order_occurrences: "terminal_event_id", timing_facts: "event_id", source_issue_facts: "event_id" };
const us = (iso: unknown) => instantMicros(String(iso))!;

class PubRef {
  seq = 0;
  gens: Gen[] = [];
  facts: FactRow[] = [];
  daily: DailyRow[] = [];
  versions: Array<{ site: string; id: string; from: number; to: number | null; image: Img }> = [];
  mirror = new Map<string, Img>(); // `${site}|${id}`
  site = new Map<string, { active: string | null; cutoff: string | null }>();
  journal: JournalRow[] = [];
  batches: Batch[] = [];

  current(family: ResultTable, site: string, aud: [string, string | null]) {
    return this.facts.filter((f) => f.family === family && f.site === site && f.audKind === aud[0] && f.audStaff === aud[1] && f.to === null);
  }

  publish(b: Batch, fence: number): { generation: string; seq: number; replay: boolean; acknowledged: number[] } {
    if (b.state === "published") {
      if (fence !== b.fence) throw new Error("was published under another fence");
      const g = this.gens.find((x) => x.id === b.generation)!;
      return { generation: g.id, seq: g.seq, replay: true, acknowledged: [] };
    }
    if (fence !== b.fence) throw new Error("fence is obsolete");
    if (b.state !== "frozen" || !b.sealed) throw new Error("is not a sealed frozen batch");
    const bad = b.works.find((w) => w.state !== "done");
    if (bad) throw new Error(`is incomplete: work ${bad.desc.partitionKey} is ${bad.state}`);
    const S = ++this.seq;
    const gen: Gen = { id: `g${S}`, seq: S, site: b.site, state: "building", fingerprint: null };
    this.gens.push(gen);
    const planned = new Set(b.works.map((w) => `${w.desc.audienceKind}|${w.desc.audienceStaff}|${w.desc.partitionKind}|${w.desc.partitionKey}`));
    // Close (all five families): by planned owner, or everything of the site on a rebuild.
    for (const f of this.facts) {
      if (f.site !== b.site || f.to !== null) continue;
      if (b.kind === "rebuild" || planned.has(`${f.audKind}|${f.audStaff}|${f.owner.partitionKind}|${f.owner.partitionKey}`)) f.to = S;
    }
    // Install with trusted metadata.
    for (const w of b.works) {
      for (const t of RESULT_TABLES) {
        for (const row of w.rows[t]) {
          this.facts.push({ family: t, site: b.site, audKind: w.desc.audienceKind, audStaff: w.desc.audienceStaff, id: String(row[ID_OF[t]]), owner: { partitionKind: w.desc.partitionKind, partitionKey: w.desc.partitionKey }, from: S, to: null, row });
        }
      }
    }
    const installed = this.facts.filter((f) => f.site === b.site && f.from === S);
    const undated = installed.find((f) => f.family === "event_facts" && f.row.role === "verification" && f.row.production_date === null);
    if (undated) throw new Error(`event ${undated.id} is a verification without production_date`);
    for (const f of installed) {
      const twin = this.facts.find((o) => o !== f && o.family === f.family && o.site === f.site && o.audKind === f.audKind && o.audStaff === f.audStaff && o.id === f.id && o.to === null);
      if (twin) throw new Error(`${f.family} event ${f.id} has another current row (an old owner was not planned)`);
    }
    // Daily groups: touched by retired/installed verifications or changed edges' parents (rebuild: all current groups).
    type G = { audKind: string; audStaff: string | null; date: string; staff: string; workType: string; rework: boolean };
    const gk = (g: G) => JSON.stringify([g.audKind, g.audStaff, g.date, g.staff, g.workType, g.rework]);
    const groupOf = (f: FactRow): G => ({ audKind: f.audKind, audStaff: f.audStaff, date: String(f.row.production_date), staff: String(f.row.staff_id), workType: String(f.row.work_type), rework: f.row.case_id !== null });
    const changed = new Map<string, G>();
    const isVer = (f: FactRow) => f.family === "event_facts" && f.row.role === "verification" && f.row.production_date !== null;
    for (const f of this.facts) if (f.site === b.site && isVer(f) && (f.from === S || f.to === S)) changed.set(gk(groupOf(f)), groupOf(f));
    for (const e of this.facts) {
      if (e.site !== b.site || e.family !== "cancel_edges" || (e.from !== S && e.to !== S)) continue;
      const p = this.facts.find((x) => isVer(x) && x.to === null && x.site === e.site && x.audKind === e.audKind && x.audStaff === e.audStaff && x.id === e.row.parent_event_id);
      if (p) changed.set(gk(groupOf(p)), groupOf(p));
    }
    if (b.kind === "rebuild") for (const d of this.daily) if (d.site === b.site && d.to === null) { const g = { audKind: d.audKind, audStaff: d.audStaff, date: d.date, staff: d.staff, workType: d.workType, rework: d.rework }; changed.set(gk(g), g); }
    for (const d of this.daily) if (d.site === b.site && d.to === null && changed.has(gk(d as unknown as G))) d.to = S;
    for (const g of changed.values()) {
      const lines = this.facts.filter((v) => isVer(v) && v.to === null && v.site === b.site && gk(groupOf(v)) === gk(g)).filter((v) => !this.cancelled(v));
      if (lines.length === 0) continue; // removal
      const items = lines.reduce((n, v) => n + (v.row.item_status === "counted" ? Number(v.row.items) : 0), 0);
      this.daily.push({ site: b.site, ...g, from: S, to: null, items: items > MAX_SAFE ? null : items, overflow: items > MAX_SAFE, lines: lines.length });
    }
    // Mirror and retained versions.
    const images: Map<string, Img | null> = b.kind === "refresh" ? b.events : new Map([...[...this.mirror.keys()].filter((k) => k.startsWith(`${b.site}|`)).map((k) => [k.slice(b.site.length + 1), null] as [string, null]), ...b.candidate]);
    for (const [id, image] of images) {
      const k = `${b.site}|${id}`;
      const cur = this.versions.find((v) => v.site === b.site && v.id === id && v.to === null);
      if (cur && JSON.stringify(cur.image) !== JSON.stringify(image)) cur.to = S;
      if (image && !this.versions.find((v) => v.site === b.site && v.id === id && v.to === null)) this.versions.push({ site: b.site, id, from: S, to: null, image });
      if (image) this.mirror.set(k, image);
      else this.mirror.delete(k);
    }
    for (const g of this.gens) if (g.site === b.site && g.state === "published") g.state = "superseded";
    gen.state = "published";
    b.state = "published";
    b.generation = gen.id;
    this.site.set(b.site, { active: gen.id, cutoff: b.cutoff });
    const receipts: BatchRow[] = this.batches.filter((x) => x.state === "published").map((x) => ({ batchId: x.id, site: x.site, state: "published", changeIds: x.changeIds }));
    const ack = acknowledgeable(b.site as "au" | "uk" | "us", this.journal, receipts);
    for (const j of this.journal) if (ack.includes(j.changeId)) j.acknowledged = true;
    return { generation: gen.id, seq: S, replay: false, acknowledged: ack };
  }

  /** Current valid cancellation: pair valid, verification parent, not self, parent not later than the cancellation. */
  cancelled(v: FactRow): boolean {
    return this.facts.some((e) => {
      if (e.family !== "cancel_edges" || e.to !== null || e.site !== v.site || e.audKind !== v.audKind || e.audStaff !== v.audStaff) return false;
      if (e.row.parent_event_id !== v.id || e.row.is_self || e.row.pair !== "valid" || e.row.parent_role !== "verification") return false;
      const c = this.facts.find((x) => x.family === "event_facts" && x.to === null && x.site === e.site && x.audKind === e.audKind && x.audStaff === e.audStaff && x.id === e.id && x.row.role === "cancellation");
      return !!c && us(e.row.parent_created_at) <= us(c.row.created_at);
    });
  }

  currentDaily(site: string, aud: [string, string | null]) {
    return this.daily.filter((d) => d.site === site && d.audKind === aud[0] && d.audStaff === aud[1] && d.to === null);
  }
}

let batchSeq = 0;
function batchFrom(db: PubRef, kind: "refresh" | "rebuild", results: Array<[ReportingAudience, PartitionResult, ((o: Owner) => boolean)?]>, extra: Partial<Batch> = {}, emptyOwners: Array<[ReportingAudience, Owner]> = []): Batch {
  const works: Work[] = [];
  const add = (aud: ReportingAudience, owner: Owner, rows: ResultRows) => {
    for (const t of RESULT_TABLES) for (const r of rows[t]) expect(resultRowProblem(t, r), `${t} ${JSON.stringify(r).slice(0, 80)}`).toBeNull();
    works.push({ desc: { audienceKind: aud.kind, audienceStaff: aud.kind === "self" ? aud.staffId : null, ...owner, inputHash: H("a") }, state: "done", rows, digest: H("d") });
  };
  for (const [aud, r, keep] of results) for (const { owner, rows } of rowsByOwner(r).values()) if (!keep || keep(owner)) add(aud, owner, rows);
  for (const [aud, owner] of emptyOwners) add(aud, owner, { event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });
  const b: Batch = { id: `b${++batchSeq}`, site: SITE, kind, fence: 1, state: "frozen", sealed: true, works, events: new Map(), candidate: new Map(), changeIds: [], generation: null, cutoff: CUTOFF, ...extra };
  db.batches.push(b);
  return b;
}

const SITE_AUD: ReportingAudience = { kind: "site" };
const ANNA_AUD: ReportingAudience = { kind: "self", staffId: ANNA };

// ---------------------------------------------------------------------------
// Daily totals = the existing reducer (exact-rule parity)
// ---------------------------------------------------------------------------

describe("daily totals recomputed at publication equal the Task 11 reducer", () => {
  const source = history();
  const visible = (aud: ReportingAudience) => (aud.kind === "site" ? source : source.filter((e) => e.staff_id === aud.staffId));
  const vis = (aud: ReportingAudience): ProductionVisibility => (aud.kind === "site" ? { kind: "site" } : { kind: "limited", reason: "own work only" });

  /** Reducer answer for one production day / person / work type: Items per normal|rework and effective verified lines. */
  function reducer(aud: ReportingAudience, d: number, staff: string, wt: WorkType) {
    const prepared = prepareProductionEvidence(fourFamilySnapshot(visible(aud), day(d), vis(aud)));
    const s = summarizeProduction(prepared, { range: day(d), staffIds: [staff], workTypes: [wt] });
    const S = us(day(d).startUtc);
    const E = us(day(d).endUtcExclusive);
    const lines = prepared.verifications.filter((v) => v.effective && v.ev.staff_id === staff && v.workType === wt && v.ev.us >= S && v.ev.us < E);
    return {
      normal: { items: s.normal.items ?? -1, lines: lines.filter((v) => v.caseId === null).length },
      rework: { items: s.rework.items ?? -1, lines: lines.filter((v) => v.caseId !== null).length },
    };
  }

  for (const aud of [SITE_AUD, ANNA_AUD]) {
    it(`${aud.kind === "site" ? "site" : "Anna's self"} audience: every (day, person, work type, normal/rework) group, including excluded/unclassified zero-Item lines`, () => {
      const db = new PubRef();
      const r = project(visible(aud), aud);
      db.publish(batchFrom(db, "rebuild", [[aud, r]]), 1);
      const key: [string, string | null] = [aud.kind, aud.kind === "self" ? aud.staffId : null];
      const daily = db.currentDaily(SITE, key);
      // Every group the reducer has a line in is stored; nothing else.
      const days = [5, 11, 12, 13, 14, 15, 16];
      let compared = 0;
      for (const d of days) {
        const date = `2026-01-${String(d).padStart(2, "0")}`;
        for (const staff of [ANNA, BEN, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) {
          for (const wt of ["a0_framed", "framed", "unframed", "dispatch"] as WorkType[]) {
            const want = reducer(aud, d, staff, wt);
            for (const [rework, w] of [[false, want.normal], [true, want.rework]] as const) {
              const row = daily.find((x) => x.date === date && x.staff === staff && x.workType === wt && x.rework === rework);
              if (w.lines === 0) {
                expect(row, `${date} ${staff} ${wt} ${rework}`).toBeUndefined();
                expect(w.items).toBe(0);
              } else {
                expect(row, `${date} ${staff} ${wt} ${rework}`).toBeDefined();
                expect({ items: row!.items, lines: row!.lines }, `${date} ${staff} ${wt} ${rework}`).toEqual(w);
                compared++;
              }
            }
          }
        }
      }
      expect(compared).toBe(daily.length);
      expect(compared).toBeGreaterThan(5);
    });
  }

  it("a group whose effective lines are all excluded/unclassified is stored with zero Items and its line count (item_status gates Items only)", () => {
    resetIds();
    const src = [
      verify({ order_number: "8001", line_sku: SKU.hook, created_at: at(12, "09:00") }), // excluded
      verify({ order_number: "8001", line_sku: SKU.legacy, created_at: at(12, "09:05") }), // unclassified
    ];
    const db = new PubRef();
    db.publish(batchFrom(db, "rebuild", [[SITE_AUD, project(src, SITE_AUD)]]), 1);
    expect(db.currentDaily(SITE, ["site", null]).map((d) => ({ date: d.date, items: d.items, lines: d.lines }))).toEqual([{ date: "2026-01-12", items: 0, lines: 2 }]);
    const s = summarizeProduction(prepareProductionEvidence(fourFamilySnapshot(src, day(12))), { range: day(12) });
    expect(s.normal.items).toBe(0);
  });

  it("the hidden cross-worker cancellation (order 5008) cancels Anna's line for the site, not in Anna's self view", () => {
    const db = new PubRef();
    db.publish(batchFrom(db, "rebuild", [[SITE_AUD, project(source, SITE_AUD)], [ANNA_AUD, project(visible(ANNA_AUD), ANNA_AUD)]]), 1);
    const day14 = (k: [string, string | null]) => db.currentDaily(SITE, k).find((d) => d.date === "2026-01-14" && d.staff === ANNA && d.workType === "framed" && !d.rework)!;
    expect(day14(["self", ANNA]).lines - day14(["site", null]).lines).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Replacement, rebuild, no-change, replay, mirror, receipts
// ---------------------------------------------------------------------------

describe("publication semantics (reference model of 0038)", () => {
  const base = () => {
    resetIds();
    const v1 = verify({ id: "v1", order_number: "9001", created_at: at(12, "09:00") });
    const v2 = verify({ id: "v2", order_number: "9001", created_at: at(12, "09:10") });
    const v3 = verify({ id: "v3", order_number: "9002", staff_id: BEN, created_at: at(12, "10:00") });
    return [v1, v2, v3];
  };
  const rebuild = (src: ProductionEvidenceEvent[]) => {
    const db = new PubRef();
    db.publish(batchFrom(db, "rebuild", [[SITE_AUD, project(src, SITE_AUD)], [ANNA_AUD, project(src.filter((e) => e.staff_id === ANNA), ANNA_AUD)]]), 1);
    return db;
  };
  const ids = (db: PubRef, aud: [string, string | null] = ["site", null]) => db.current("event_facts", SITE, aud).map((f) => f.id).sort();
  const items = (db: PubRef, aud: [string, string | null] = ["site", null]) => db.currentDaily(SITE, aud).map((d) => `${d.date}|${d.staff.slice(0, 4)}|${d.items}|${d.lines}`).sort();

  it("refresh replaces exactly the planned owners; other owners keep their rows and validity", () => {
    const src = base();
    const db = rebuild(src);
    const before = db.current("event_facts", SITE, ["site", null]).find((f) => f.id === "v3")!;
    const changed = [{ ...src[0], line_quantity: 3 }, src[1], src[2]];
    const r = db.publish(batchFrom(db, "refresh", [[SITE_AUD, project(changed, SITE_AUD), (o) => o.partitionKey === "9001"]]), 1);
    expect(r.seq).toBe(2);
    expect(db.current("event_facts", SITE, ["site", null]).find((f) => f.id === "v3")).toBe(before);
    expect(db.current("event_facts", SITE, ["site", null]).filter((f) => f.from === 2).map((f) => f.id).sort()).toEqual(["v1", "v2"]);
    expect(items(db)).toEqual(["2026-01-12|aaaa|4|2", "2026-01-12|bbbb|1|1"]);
  });

  it("an EMPTY replacement closes every owned row in all five families (deletion), and its daily group is removed", () => {
    const src = base();
    const db = rebuild(src);
    db.publish(batchFrom(db, "refresh", [], {}, [[SITE_AUD, { partitionKind: "order", partitionKey: "9002" }]]), 1);
    expect(ids(db)).toEqual(["v1", "v2"]);
    expect(items(db)).toEqual(["2026-01-12|aaaa|2|2"]);
    // Closing only the ids present in the new output would have kept v3 forever.
    expect(db.facts.find((f) => f.id === "v3" && f.audKind === "site")!.to).toBe(2);
  });

  it("a move between owners needs BOTH owners planned; planning only the new one fails (two current rows)", () => {
    const src = base();
    const moved = [src[0], { ...src[1], order_number: "9002" }, src[2]];
    const ok = rebuild(src);
    ok.publish(batchFrom(ok, "refresh", [[SITE_AUD, project(moved, SITE_AUD)]]), 1);
    expect(ok.current("event_facts", SITE, ["site", null]).find((f) => f.id === "v2")!.owner.partitionKey).toBe("9002");
    const bad = rebuild(src);
    expect(() => bad.publish(batchFrom(bad, "refresh", [[SITE_AUD, project(moved, SITE_AUD), (o) => o.partitionKey === "9002"]]), 1)).toThrow(/v2 has another current row \(an old owner was not planned\)/);
  });

  it("a rebuild closes every current row of the site, including departed audiences and empty partitions", () => {
    const db = rebuild(base());
    expect(ids(db, ["self", ANNA])).toEqual(["v1", "v2"]);
    resetIds();
    const only = [verify({ id: "v9", order_number: "9100", staff_id: BEN, created_at: at(13, "09:00") })];
    db.publish(batchFrom(db, "rebuild", [[SITE_AUD, project(only, SITE_AUD)]]), 1);
    expect(ids(db)).toEqual(["v9"]);
    expect(ids(db, ["self", ANNA])).toEqual([]); // Anna departed: her self audience is closed
    expect(db.currentDaily(SITE, ["self", ANNA])).toEqual([]);
    expect(items(db)).toEqual(["2026-01-13|bbbb|1|1"]);
  });

  it("a cancellation published in another owner's partition recomputes the parent's daily group", () => {
    resetIds();
    const v = verify({ id: "pv", order_number: "9300", created_at: at(12, "09:00") });
    const db = rebuild([v]);
    expect(items(db)).toEqual(["2026-01-12|aaaa|1|1"]);
    const c = cancel(v, { id: "pc", order_number: " ", created_at: at(12, "11:00") }); // blank order: event partition "pc"
    const r = project([v, c], SITE_AUD);
    db.publish(batchFrom(db, "refresh", [[SITE_AUD, r, (o) => o.partitionKind === "event"]]), 1);
    expect(db.current("cancel_edges", SITE, ["site", null]).map((e) => e.owner.partitionKey)).toEqual(["pc"]);
    expect(items(db)).toEqual([]); // the only line is cancelled: the group is removed
  });

  it("a cancellation saved BEFORE its parent does not cancel it (parent later than the cancellation)", () => {
    resetIds();
    const late = verify({ id: "lv", order_number: "9400", created_at: at(12, "12:00") });
    const c = cancel(late, { id: "lc", created_at: at(12, "11:00") });
    const db = rebuild([late, c]);
    expect(items(db)).toEqual(["2026-01-12|aaaa|1|1"]);
  });

  it("Items above 2^53-1 are stored as overflow (null Items), never a rounded number", () => {
    const db = new PubRef();
    const row = (id: string, items: number) => ({
      event_id: id, event_type: "line_verified", created_at: "2026-01-12T09:00:00Z", staff_id: ANNA, department: "framed", raw_order: "9500", order_key: "9500",
      case_id: null, parent_event_id: null, sku: SKU.fb, quantity: 1, role: "verification", work_type: "framed", invalid_detail: null, line_key: "k",
      item_status: "counted", items, product_kind: "eligible", item_issue_kind: null, item_issue_detail: null, timing_stream: true, timing_weight: 1, production_date: "2026-01-12",
    });
    const b = batchFrom(db, "rebuild", []);
    b.works.push({ desc: { audienceKind: "site", audienceStaff: null, partitionKind: "order", partitionKey: "9500", inputHash: H("a") }, state: "done", digest: H("d"),
      rows: { event_facts: [row("o1", MAX_SAFE), row("o2", 1)], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] } });
    db.publish(b, 1);
    expect(db.currentDaily(SITE, ["site", null])).toMatchObject([{ items: null, overflow: true, lines: 2 }]);
  });

  it("a dated verification without production_date fails the publication", () => {
    const db = new PubRef();
    const r = project(base(), SITE_AUD);
    const b = batchFrom(db, "rebuild", [[SITE_AUD, r]]);
    b.works[0].rows.event_facts[0] = { ...b.works[0].rows.event_facts[0], production_date: null };
    expect(() => db.publish(b, 1)).toThrow(/without production_date/);
  });

  it("no-change: a sealed zero-work refresh publishes a new metadata generation; every fact interval continues", () => {
    const db = rebuild(base());
    const before = JSON.stringify(db.facts.map((f) => [f.id, f.from, f.to]));
    const r = db.publish(batchFrom(db, "refresh", [], { cutoff: "2026-02-11T00:00:00.000Z" }), 1);
    expect(r.replay).toBe(false);
    expect(JSON.stringify(db.facts.map((f) => [f.id, f.from, f.to]))).toBe(before);
    expect(db.gens.map((g) => g.state)).toEqual(["superseded", "published"]);
    expect(db.site.get(SITE)).toEqual({ active: r.generation, cutoff: "2026-02-11T00:00:00.000Z" });
  });

  it("lost-response replay returns the same generation and writes nothing; another fence, an unsealed or incomplete batch fail", () => {
    const db = new PubRef();
    const b = batchFrom(db, "rebuild", [[SITE_AUD, project(base(), SITE_AUD)]]);
    const first = db.publish(b, 1);
    const snapshot = JSON.stringify([db.facts.length, db.daily.length, db.gens.length, db.versions.length]);
    expect(db.publish(b, 1)).toEqual({ ...first, replay: true, acknowledged: [] });
    expect(JSON.stringify([db.facts.length, db.daily.length, db.gens.length, db.versions.length])).toBe(snapshot);
    expect(() => db.publish(b, 2)).toThrow(/another fence/);
    const u = batchFrom(db, "refresh", [], { sealed: false });
    expect(() => db.publish(u, 1)).toThrow(/not a sealed frozen batch/);
    const inc = batchFrom(db, "refresh", [[SITE_AUD, project(base(), SITE_AUD)]]);
    inc.works[0].state = "leased";
    const gens = db.gens.length;
    expect(() => db.publish(inc, 1)).toThrow(/incomplete/);
    expect(db.gens.length).toBe(gens);
  });

  it("mirror and retained versions: a changed image closes its version, a tombstone deletes and closes, identical images add nothing; rebuild drops absent rows", () => {
    const db = new PubRef();
    const img = (id: string, note: string): Img => ({ id, location: SITE, created_at: "2026-01-12T09:00:00Z", note });
    db.publish(batchFrom(db, "rebuild", [], { candidate: new Map([["a", img("a", "x")], ["b", img("b", "x")], ["c", img("c", "x")]]) }), 1);
    db.publish(batchFrom(db, "refresh", [], { events: new Map<string, Img | null>([["a", img("a", "y")], ["b", null], ["c", img("c", "x")], ["d", img("d", "x")]]) }), 1);
    expect([...db.mirror.keys()].sort()).toEqual([`${SITE}|a`, `${SITE}|c`, `${SITE}|d`]);
    expect(db.versions.map((v) => `${v.id}:${v.from}-${v.to ?? ""}:${v.image.note}`).sort()).toEqual(["a:1-2:x", "a:2-:y", "b:1-2:x", "c:1-:x", "d:2-:x"]);
    db.publish(batchFrom(db, "rebuild", [], { candidate: new Map([["c", img("c", "x")]]) }), 1);
    expect([...db.mirror.keys()]).toEqual([`${SITE}|c`]);
    expect(db.versions.filter((v) => v.to === null).map((v) => `${v.id}:${v.from}`)).toEqual(["c:1"]);
  });

  it("receipts: an AU→UK move stays unacknowledged after AU publishes; UK's publication acknowledges it", () => {
    const db = new PubRef();
    db.journal = [{ changeId: 7, oldSite: "au", newSite: "uk", acknowledged: false }, { changeId: 8, oldSite: "au", newSite: "au", acknowledged: false }];
    const au = batchFrom(db, "refresh", [], { site: "au", changeIds: [7, 8] });
    expect(db.publish(au, 1).acknowledged).toEqual([8]);
    expect(pendingForSite("uk", db.journal, db.batches.filter((x) => x.state === "published").map((x) => ({ batchId: x.id, site: x.site, state: "published" as const, changeIds: x.changeIds })))).toEqual([7]);
    const uk = batchFrom(db, "refresh", [], { site: "uk", changeIds: [7] });
    expect(db.publish(uk, 1).acknowledged).toEqual([7]);
  });
});

// ---------------------------------------------------------------------------
// 0038 SQL text (B2b)
// ---------------------------------------------------------------------------

describe("0038 B2b SQL", () => {
  const SQL = readFileSync("supabase/migrations/0038_reporting_jobs.sql", "utf8");
  const codes = splitSqlStatements(SQL).map((s) => s.text.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim());
  const fn = (name: string) => codes.find((c) => c.startsWith(`CREATE FUNCTION ${name}(`)) ?? "";
  const pub = fn("public.publish_reporting_batch");

  it("owner columns are additive and nullable on 0037's tables (both or neither) and required on the new fifth table; current-owner indexes", () => {
    for (const t of ["event_facts", "cancel_edges", "order_occurrences", "timing_facts"]) {
      const a = codes.find((c) => c.startsWith(`ALTER TABLE reporting_private.${t} ADD COLUMN partition_kind`))!;
      expect(a, t).toContain(`ADD COLUMN partition_key text, ADD CONSTRAINT ${t}_owner_pair CHECK ((partition_kind IS NULL) = (partition_key IS NULL))`);
      expect(codes, t).toContain(`CREATE INDEX ${t}_owner ON reporting_private.${t} (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL`);
    }
    const s = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.source_issue_facts"))!;
    expect(s).toContain("partition_kind text NOT NULL CHECK (partition_kind IN ('order', 'event')), partition_key text NOT NULL");
    expect(codes).toContain("CREATE INDEX source_issue_facts_owner ON reporting_private.source_issue_facts (site, audience_kind, audience_staff, partition_kind, partition_key) WHERE valid_to_seq IS NULL");
    expect(codes.find((c) => c.startsWith("ALTER TABLE reporting_private.batches ADD COLUMN published_generation_id"))).toContain("CHECK ((state = 'published') = (published_generation_id IS NOT NULL))");
  });

  it("retained source versions: private, versioned, one current image per event, service-only", () => {
    const t = codes.find((c) => c.startsWith("CREATE TABLE reporting_private.source_versions"))!;
    expect(t).toContain("PRIMARY KEY (site, event_id, valid_from_seq)");
    expect(t).toContain("CHECK (image ->> 'location' = site AND image ->> 'id' = event_id)");
    expect(codes).toContain("CREATE UNIQUE INDEX source_versions_current ON reporting_private.source_versions (site, event_id) WHERE valid_to_seq IS NULL");
    expect(codes).toContain("ALTER TABLE reporting_private.source_versions ENABLE ROW LEVEL SECURITY");
    expect(codes).toContain("REVOKE ALL ON TABLE reporting_private.source_versions FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE reporting_private.source_versions TO service_role");
  });

  it("lock order and lost-response replay come BEFORE lock_batch; replay writes nothing and needs the same fence", () => {
    const order = ["FROM reporting_private.control c WHERE c.singleton FOR SHARE", "FROM reporting_private.site_state s WHERE s.site = v_site FOR UPDATE", "FROM reporting_private.batches x WHERE x.batch_id = p_batch FOR UPDATE", "IF v_prior.state = 'published' THEN", "b := reporting_private.lock_batch(p_batch, p_fence, true);"];
    const idx = order.map((s) => pub.indexOf(s));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    const replay = pub.slice(idx[3], idx[4]);
    expect(replay).toContain("IF p_fence IS NULL OR v_prior.lease_fence <> p_fence THEN RAISE EXCEPTION 'reporting batch % was published under another fence'");
    expect(replay).toContain("0::bigint, true FROM reporting_private.generations g WHERE g.generation_id = v_prior.published_generation_id; RETURN;");
    expect(replay).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  it("refuses an unsealed batch, a manifest changed since seal, and any work not done or whose chunks/digest do not match", () => {
    expect(pub).toContain("IF b.state <> 'frozen' OR b.sealed_at IS NULL THEN RAISE EXCEPTION");
    expect(pub).toContain("IF m.work_count <> b.sealed_work_count OR m.manifest_hash <> b.sealed_manifest_hash THEN");
    expect(pub).toContain("AND (w.state <> 'done' OR z.n <> w.chunk_count OR z.top <> w.chunk_count - 1 OR z.digest <> w.result_digest)");
    expect(pub).toContain("string_agg(r.chunk_hash, E'\\n' ORDER BY r.chunk_no)");
    expect(pub.indexOf("RAISE EXCEPTION 'publish: batch % is incomplete")).toBeLessThan(pub.indexOf("INSERT INTO reporting_private.generations"));
  });

  it("closes every family by planned owner (refresh) or the whole site (rebuild), then installs at S with trusted columns only", () => {
    for (const t of RESULT_TABLES) {
      expect(pub, t).toContain(`UPDATE reporting_private.${t} f SET valid_to_seq = v_seq WHERE f.site = b.site AND f.valid_to_seq IS NULL AND (b.kind = 'rebuild' OR EXISTS (SELECT 1 FROM reporting_private.partition_work w WHERE w.batch_id = p_batch AND w.audience_kind = f.audience_kind AND w.audience_staff IS NOT DISTINCT FROM f.audience_staff AND w.partition_kind = f.partition_kind AND w.partition_key = f.partition_key));`);
      const ins = pub.slice(pub.indexOf(`INSERT INTO reporting_private.${t} (`));
      const sel = ins.slice(0, ins.indexOf(`jsonb_populate_recordset(NULL::reporting_private.${t}, r.chunk -> '${t}') x WHERE w.batch_id = p_batch;`));
      expect(sel, t).toMatch(/SELECT b\.site, w\.audience_kind, w\.audience_staff, x\.\w+, (x\.\w+, )?v_seq,/);
      expect(sel, t).toMatch(/w\.partition_kind, w\.partition_key FROM reporting_private\.partition_work w JOIN reporting_private\.partition_results r ON r\.work_id = w\.work_id CROSS JOIN LATERAL pg_catalog\.$/);
      expect(sel, t).not.toMatch(/x\.(site|audience_kind|audience_staff|valid_from_seq|valid_to_seq|rule_version|partition_kind|partition_key)\b/);
    }
    // All five closes come before the first install.
    expect(Math.max(...RESULT_TABLES.map((t) => pub.indexOf(`UPDATE reporting_private.${t} f SET valid_to_seq = v_seq`)))).toBeLessThan(pub.indexOf("INSERT INTO reporting_private.event_facts ("));
  });

  it("integrity: dated verifications and a single current owner per event in every family", () => {
    expect(pub).toContain("f.valid_from_seq = v_seq AND f.role = 'verification' AND f.production_date IS NULL");
    for (const [t, k] of [["event_facts", "event_id"], ["cancel_edges", "cancel_event_id"], ["order_occurrences", "terminal_event_id"], ["timing_facts", "event_id"], ["source_issue_facts", "event_id"]]) {
      expect(pub, t).toContain(`FROM reporting_private.${t} o WHERE o.site = f.site AND o.audience_kind = f.audience_kind AND o.audience_staff IS NOT DISTINCT FROM f.audience_staff AND o.${k} = f.${k} AND o.valid_to_seq IS NULL AND o.valid_from_seq <> v_seq`);
    }
  });

  it("daily totals: affected groups from retired/installed verifications and changed edges' parents (rebuild: all); Items gated by item_status ONLY; every effective line counted; overflow; removal", () => {
    const d = pub.slice(pub.indexOf("WITH changed AS ("), pub.indexOf("-- Mirror") > 0 ? pub.indexOf("IF b.kind = 'refresh' THEN") : undefined);
    expect(d).toContain("f.role = 'verification' AND f.production_date IS NOT NULL AND (f.valid_from_seq = v_seq OR f.valid_to_seq = v_seq)");
    expect(d).toContain("WHERE e.site = b.site AND (e.valid_from_seq = v_seq OR e.valid_to_seq = v_seq)");
    expect(d).toContain("WHERE d.site = b.site AND d.valid_to_seq IS NULL AND b.kind = 'rebuild'");
    // Planner note: item_status never filters lines/groups; it only gates the Items contribution.
    expect(d).toContain("count(*) AS lines, sum(CASE WHEN v.item_status = 'counted' THEN v.items ELSE 0 END)::numeric AS items");
    expect(d.match(/item_status/g)).toHaveLength(1);
    expect(d).toContain("AND e.parent_event_id = v.event_id AND e.valid_to_seq IS NULL AND NOT e.is_self AND e.pair = 'valid' AND e.parent_role = 'verification' AND e.parent_created_at <= c.created_at");
    expect(d).toContain("c.event_id = e.cancel_event_id AND c.role = 'cancellation' AND c.valid_to_seq IS NULL");
    expect(d).toContain("CASE WHEN t.items > 9007199254740991 THEN NULL ELSE t.items::bigint END, t.items > 9007199254740991, t.lines::integer FROM totals t WHERE t.lines > 0");
    // SQL only sums: no SKU, date or classification rule.
    expect(d).not.toMatch(/line_sku|sku\b|productionDate|AT TIME ZONE|interval '4 hours'|product_kind/);
  });

  it("mirror and retained versions for refresh (frozen images, tombstones) and rebuild (frozen candidate)", () => {
    const m = pub.slice(pub.indexOf("IF b.kind = 'refresh' THEN"), pub.indexOf("UPDATE reporting_private.generations g SET state = 'superseded'"));
    expect(m).toContain("AND v.valid_to_seq IS NULL AND v.image IS DISTINCT FROM be.image;");
    expect(m).toContain("WHERE be.batch_id = p_batch AND be.site = b.site AND be.image IS NULL AND sc.site = b.site AND sc.event_id = be.event_id;");
    expect(m).toContain("AND NOT EXISTS (SELECT 1 FROM reporting_private.source_candidate c WHERE c.batch_id = p_batch AND c.site = b.site AND c.event_id = v.event_id AND c.image = v.image);");
    expect(m).toContain("AND NOT EXISTS (SELECT 1 FROM reporting_private.source_candidate c WHERE c.batch_id = p_batch AND c.site = b.site AND c.event_id = sc.event_id);");
    expect(m.match(/WHERE reporting_private\.source_current\.image IS DISTINCT FROM EXCLUDED\.image;/g)).toHaveLength(2);
  });

  it("generations, receipts and site metadata: supersede before publish, fingerprint, receipt, acknowledgement pass, site moves to the new generation; read_mode untouched", () => {
    const tail = pub.slice(pub.indexOf("UPDATE reporting_private.generations g SET state = 'superseded'"));
    const steps = [
      "SET state = 'superseded', superseded_at = v_now, expires_at = v_now + interval '7 days' WHERE g.site = b.site AND g.state = 'published';",
      "SET state = 'published', complete = true, verified_at = v_now, published_at = v_now, reconciliation_fingerprint = reporting_private.publication_fingerprint(p_batch) WHERE g.generation_id = v_gen;",
      "UPDATE reporting_private.batches x SET state = 'published', published_generation_id = v_gen",
      "v_ack := reporting_private.acknowledge_received_changes(b.site, p_batch);",
      "SET active_generation_id = v_gen, source_epoch = b.capture_epoch, last_verified_cutoff = b.source_cutoff, active_batch_id = NULL",
    ];
    const idx = steps.map((s) => tail.indexOf(s));
    expect(idx.every((i) => i >= 0), JSON.stringify(idx)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(pub).not.toMatch(/read_mode|processor_enabled|capture_enabled\s*=/);
    expect(pub).not.toMatch(/public\.production_events|EXCEPTION WHEN|\bEXECUTE\b|\bformat\(/);
    expect(pub).toMatch(/SECURITY INVOKER SET search_path = ''/);
    expect(codes).toContain("REVOKE ALL ON FUNCTION public.publish_reporting_batch(uuid, bigint) FROM PUBLIC, anon, authenticated");
    expect(codes).toContain("GRANT EXECUTE ON FUNCTION public.publish_reporting_batch(uuid, bigint) TO service_role");
  });

  it("acknowledgement locks candidates in change-id order and skips rows a concurrent publication holds (no cross-site deadlock)", () => {
    const ack = fn("reporting_private.acknowledge_received_changes");
    expect(ack).toContain("WITH ready AS ( SELECT c.change_id FROM reporting_private.changes c WHERE c.acknowledged_at IS NULL AND (c.old_site = p_site OR c.new_site = p_site) ORDER BY c.change_id FOR UPDATE OF c SKIP LOCKED )");
    expect(ack).toContain("FROM ready r WHERE c.change_id = r.change_id AND c.acknowledged_at IS NULL");
  });

  it("the fingerprint SQL is the TypeScript model's exact byte layout", () => {
    const f = fn("reporting_private.publication_fingerprint");
    expect(f).toContain("'item-counting-publication-v1' || E'\\n' || b.site || E'\\n' || b.kind || E'\\n' || b.rule_version || E'\\n' || b.capture_epoch::text || E'\\n' || (pg_catalog.extract(epoch FROM b.source_cutoff) * 1000000)::bigint::text || E'\\n' || b.sealed_manifest_hash");
    expect(f).toContain("string_agg(E'\\n' || w.result_digest, '' ORDER BY w.audience_kind COLLATE \"C\", w.audience_staff::text COLLATE \"C\" NULLS FIRST, w.partition_kind COLLATE \"C\", w.partition_key COLLATE \"C\")");
  });
});

// ---------------------------------------------------------------------------
// Fingerprint and wrapper
// ---------------------------------------------------------------------------

describe("publication fingerprint and wrapper", () => {
  const w = (key: string, digest: string, staff: string | null = null): WorkDescriptor & { resultDigest: string } => ({ audienceKind: staff ? "self" : "site", audienceStaff: staff, partitionKind: "order", partitionKey: key, inputHash: H("a"), resultDigest: digest });
  const f = { site: "uk", kind: "refresh" as const, ruleVersion: "item-counting-summary-v1", captureEpoch: 4, sourceCutoffUtc: "2026-01-15T09:00:00.000123Z", sealedManifestHash: H("e"), works: [w("b", H("2")), w("a", H("1"), ANNA)] };

  it("is SHA-256 of the exact lines, in manifest order, with integer-microsecond cutoff; any input changes it", async () => {
    const { createHash } = await import("node:crypto");
    const lines = ["item-counting-publication-v1", "uk", "refresh", "item-counting-summary-v1", "4", "1768467600000123", H("e"), H("1"), H("2")].join("\n");
    expect(publicationFingerprint(f)).toBe(createHash("sha256").update(lines, "utf8").digest("hex"));
    expect(publicationFingerprint({ ...f, works: [...f.works].reverse() })).toBe(publicationFingerprint(f));
    expect(publicationFingerprint({ ...f, works: [] })).toBe(createHash("sha256").update(lines.split("\n").slice(0, 7).join("\n"), "utf8").digest("hex"));
    for (const g of [{ ...f, kind: "rebuild" as const }, { ...f, captureEpoch: 5 }, { ...f, sourceCutoffUtc: "2026-01-15T09:00:00.000124Z" }, { ...f, works: [w("b", H("3")), f.works[1]] }]) expect(publicationFingerprint(g)).not.toBe(publicationFingerprint(f));
    expect(reportingManifestHash(f.works)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => publicationFingerprint({ ...f, sourceCutoffUtc: "soon" })).toThrow(ReportingJobError);
  });

  function fake(data: unknown, error: { message: string; code?: string } | null = null) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client: RpcClient = { rpc: async (fnName, a) => (calls.push([fnName, a]), { data, error }) };
    return { client, calls };
  }
  const B = "5f0c1a7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
  const row = { batch_id: B, generation_id: "11111111-2222-4333-8444-555555555555", generation_seq: "9007199254740993", site: "uk", kind: "refresh", source_cutoff: "2026-01-15T09:00:00.000123+00:00", work_count: 3, receipts: "2", acknowledged: 1, replay: false };

  it("sends exactly batch and fence; keeps the generation sequence as a decimal string; validates the row; database errors keep their code", async () => {
    const { client, calls } = fake([row]);
    expect(await publishReportingBatch(client, B, 7)).toMatchObject({ generationSeq: "9007199254740993", receipts: 2, acknowledged: 1, replay: false, workCount: 3 });
    expect(calls).toEqual([["publish_reporting_batch", { p_batch: B, p_fence: 7 }]]);
    await expect(publishReportingBatch(fake([row]).client, "nope", 7)).rejects.toThrow(/uuid/);
    await expect(publishReportingBatch(fake([row]).client, B, 0)).rejects.toThrow(/fence/);
    await expect(publishReportingBatch(fake([{ ...row, generation_seq: 12 }]).client, B, 7)).rejects.toThrow(/decimal string/);
    await expect(publishReportingBatch(fake([{ ...row, batch_id: "22222222-2222-4222-8222-222222222222" }]).client, B, 7)).rejects.toThrow(/another batch/);
    await expect(publishReportingBatch(fake([row, row]).client, B, 7)).rejects.toThrow(/unexpected shape/);
    const err = await publishReportingBatch(fake(null, { message: "publish: batch is incomplete", code: "P0001" }).client, B, 7).catch((e) => e);
    expect(err).toBeInstanceOf(ReportingJobError);
    expect(err.code).toBe("P0001");
    expect((await publishReportingBatch(fake([{ ...row, replay: true }]).client, B, 7)).replay).toBe(true);
  });
});
