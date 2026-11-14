/**
 * Published production reporting: shared contract (item-counting amendment,
 * Task 11). Types, rule version, canonical hashing and request validation.
 *
 * Browser/server safe: no env, browser state, Node built-ins or Supabase
 * imports. No Set, bigint, raw source events or complete order-key arrays
 * cross the published boundary; facts are internal to the trusted worker.
 */
import type {
  CoverageIssue,
  CoverageIssueKind,
  CoverageNoteKind,
  ProductionCoverage,
  ProductionEvidenceEvent,
  ProductionSummary,
  ProductionVisibility,
  Qualification,
  CancellationPairOutcome,
  WorkType,
} from "./productionCounts";
import { WORK_TYPES } from "./productionCounts";
import type { FrameTimingTotals } from "./productionFrameTiming";
import type { ReportPersonRow } from "./productionReportView";
import type { ProductionWelcomeView, WelcomeCounts, WelcomeDepartment, WelcomeMostImproved } from "./productionWelcomeView";
import { isProductionDate, isReportSite, type ReportSite } from "./productionPeriods";

/** Rule identity frozen into every published generation and fact. */
export const REPORTING_RULE_VERSION = "item-counting-summary-v1";

// ---------------------------------------------------------------------------
// Audience, metadata and requests
// ---------------------------------------------------------------------------

/** Chosen only by the trusted server from current role/membership; never client authority. */
export type ReportingAudience = { kind: "site" } | { kind: "self"; staffId: string };

export interface PublishedMeta {
  site: ReportSite;
  generationId: string;
  ruleVersion: string;
  sourceCutoffUtc: string;
  verifiedAtUtc: string;
  publishedAtUtc: string;
  freshUntilUtc: string;
  expiresAtUtc: string;
  visibility: ProductionVisibility;
  state: "current" | "delayed" | "outdated";
}

export interface SummaryRequest {
  site: ReportSite;
  firstDate: string;
  lastDate: string;
  staffId?: string;
  workType?: WorkType;
  view: "reports" | "welcome";
  generationId?: string;
}

export const DETAIL_KINDS = ["days", "people", "orders", "events", "coverage", "timing", "raw-export"] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export interface DetailRequest {
  site: ReportSite;
  generationId: string;
  kind: DetailKind;
  firstDate: string;
  lastDate: string;
  staffId?: string;
  workType?: WorkType;
  orderNumber?: string;
  cursor?: string;
  limit?: number;
}

export const DETAIL_PAGE_DEFAULT = 200;
export const DETAIL_PAGE_MAX = 1000;
export const DETAIL_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface Page<T> {
  rows: T[];
  /** Only a null cursor certifies the end of the requested sequence. */
  nextCursor: string | null;
  /** This page was read completely. */
  pageComplete: boolean;
  totalRows: number;
}

// ---------------------------------------------------------------------------
// Summary DTOs (explicit mappings of the current selectors)
// ---------------------------------------------------------------------------

export interface ItemsOrdersDto {
  /** null = the existing overflow state, never an unknown value coerced to zero. */
  items: number | null;
  orders: number;
}

export interface CountTotals {
  normal: ItemsOrdersDto;
  rework: ItemsOrdersDto;
}

export interface WorkTypeTotals {
  workType: WorkType;
  totals: CountTotals;
}

export interface DailyCountTotals {
  productionDate: string;
  totals: CountTotals;
}

/** ProductionCoverage without the issue list (issues are paged as `coverage` detail rows). */
export interface CoverageCounts {
  issueCounts: Record<CoverageIssueKind, number>;
  notes: Record<CoverageNoteKind, number>;
  visibility: ProductionVisibility;
  incomplete: boolean;
  issueRows: number;
}

export type ReportPersonDto = ReportPersonRow;

export interface PublishedWelcomeView {
  today: string;
  yesterday: string;
  todayTotals: { normal: WelcomeCounts; rework: WelcomeCounts };
  perDepartment: Record<WorkType, WelcomeDepartment>;
  mostImproved: WelcomeMostImproved | null;
  sparkline: Array<{ day: string; orders: number }>;
  teamTotalYesterday: number;
  /** Today's card coverage (todaySummary.coverage) and every displayed figure's coverage. */
  todayCoverage: CoverageCounts;
  coverage: CoverageCounts;
}

export interface SummaryResult {
  meta: PublishedMeta;
  totals: CountTotals;
  byWorkType: WorkTypeTotals[];
  dailyPage: Page<DailyCountTotals>;
  coverage: CoverageCounts;
  timing: FrameTimingTotals;
  peoplePage: Page<ReportPersonDto>;
  welcome?: PublishedWelcomeView;
}

// ---------------------------------------------------------------------------
// Detail rows (one DTO per DetailKind)
// ---------------------------------------------------------------------------

export interface OrderDetailDto {
  key: string;
  orderNumber: string;
  caseId: string | null;
  group: "normal" | "rework";
  firstAtUtc: string;
  lastAtUtc: string;
  workTypes: WorkType[];
  verifiedLines: number;
  items: number | null;
  completed: boolean;
}

export interface EventDetailDto {
  id: string;
  staffId: string | null;
  department: string | null;
  orderNumber: string | null;
  sku: string | null;
  /** Raw saved quantity: never coerced. */
  quantity: unknown;
  eventType: string;
  createdAtUtc: string;
  parentEventId: string | null;
  caseId: string | null;
}

export interface CoverageDetailDto {
  kind: CoverageIssueKind;
  eventId: string;
  location: string;
  detail: string | null;
}

export interface TimingDetailDto {
  eventId: string;
  staffId: string;
  workType: WorkType;
  orderNumber: string;
  sku: string | null;
  weight: number;
  startedAtUtc: string;
  completedAtUtc: string;
  durationMin: number;
}

export interface RawExportDto extends EventDetailDto {
  note: string | null;
  stationId: string | null;
}

export type PublishedDetailRow =
  | { kind: "days"; row: DailyCountTotals }
  | { kind: "people"; row: ReportPersonDto }
  | { kind: "orders"; row: OrderDetailDto }
  | { kind: "events"; row: EventDetailDto }
  | { kind: "coverage"; row: CoverageDetailDto }
  | { kind: "timing"; row: TimingDetailDto }
  | { kind: "raw-export"; row: RawExportDto };

// ---------------------------------------------------------------------------
// Explicit mappings from the current selectors (no casts)
// ---------------------------------------------------------------------------

function safeCount(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} is not an exact non-negative safe integer`);
  return n;
}

function itemsOrders(g: { items: number | null; orders: number }, what: string): ItemsOrdersDto {
  return { items: g.items === null ? null : safeCount(g.items, `${what} Items`), orders: safeCount(g.orders, `${what} Orders`) };
}

export function toCountTotals(g: { normal: { items: number | null; orders: number }; rework: { items: number | null; orders: number } }): CountTotals {
  return { normal: itemsOrders(g.normal, "normal"), rework: itemsOrders(g.rework, "rework") };
}

export function toWorkTypeTotals(summary: Pick<ProductionSummary, "byWorkType">): WorkTypeTotals[] {
  return WORK_TYPES.map((workType) => ({ workType, totals: toCountTotals(summary.byWorkType[workType]) }));
}

export function toCoverageCounts(c: ProductionCoverage): CoverageCounts {
  return { issueCounts: { ...c.issueCounts }, notes: { ...c.notes }, visibility: c.visibility, incomplete: c.incomplete, issueRows: c.issues.length };
}

export function toCoverageDetail(i: CoverageIssue): CoverageDetailDto {
  return { kind: i.kind, eventId: i.eventId, location: i.location, detail: i.detail ?? null };
}

export function toPublishedWelcome(v: ProductionWelcomeView): PublishedWelcomeView {
  return {
    today: v.today,
    yesterday: v.yesterday,
    todayTotals: { normal: { ...v.todayTotals.normal }, rework: { ...v.todayTotals.rework } },
    perDepartment: Object.fromEntries(WORK_TYPES.map((w) => [w, { ...v.perDepartment[w] }])) as Record<WorkType, WelcomeDepartment>,
    mostImproved: v.mostImproved ? { ...v.mostImproved } : null,
    sparkline: v.sparkline.map((p) => ({ ...p })),
    teamTotalYesterday: v.teamTotalYesterday,
    todayCoverage: toCoverageCounts(v.todaySummary.coverage),
    coverage: toCoverageCounts(v.coverage),
  };
}

// ---------------------------------------------------------------------------
// Request validation (bounded, explicit)
// ---------------------------------------------------------------------------

export class ReportingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportingRequestError";
  }
}

const isWork = (v: unknown): v is WorkType => typeof v === "string" && (WORK_TYPES as readonly string[]).includes(v);

function checkRange(firstDate: unknown, lastDate: unknown): void {
  if (!isProductionDate(firstDate) || !isProductionDate(lastDate)) throw new ReportingRequestError("firstDate and lastDate must be calendar dates (YYYY-MM-DD)");
  if (firstDate > lastDate) throw new ReportingRequestError("firstDate is after lastDate");
}

export function validateSummaryRequest(r: SummaryRequest): SummaryRequest {
  if (!isReportSite(r.site)) throw new ReportingRequestError("unsupported site");
  checkRange(r.firstDate, r.lastDate);
  if (r.view !== "reports" && r.view !== "welcome") throw new ReportingRequestError("unsupported view");
  if (r.workType !== undefined && !isWork(r.workType)) throw new ReportingRequestError("unsupported work type");
  if (r.staffId !== undefined && (typeof r.staffId !== "string" || !r.staffId.trim())) throw new ReportingRequestError("invalid staffId");
  if (r.generationId !== undefined && (typeof r.generationId !== "string" || !r.generationId.trim())) throw new ReportingRequestError("invalid generationId");
  return r;
}

export function validateDetailRequest(r: DetailRequest): DetailRequest & { limit: number } {
  if (!isReportSite(r.site)) throw new ReportingRequestError("unsupported site");
  if (typeof r.generationId !== "string" || !r.generationId.trim()) throw new ReportingRequestError("generationId is required");
  if (!(DETAIL_KINDS as readonly string[]).includes(r.kind)) throw new ReportingRequestError("unsupported detail kind");
  checkRange(r.firstDate, r.lastDate);
  if (r.workType !== undefined && !isWork(r.workType)) throw new ReportingRequestError("unsupported work type");
  const limit = r.limit ?? DETAIL_PAGE_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > DETAIL_PAGE_MAX) throw new ReportingRequestError(`limit must be 1..${DETAIL_PAGE_MAX}`);
  return { ...r, limit };
}

// ---------------------------------------------------------------------------
// Derived facts (trusted worker only; never returned to clients)
// ---------------------------------------------------------------------------

export type FactRole = "verification" | "terminal" | "cancellation" | "invalid";

export interface ItemFact {
  status: "counted" | "excluded" | "unclassified";
  /** Credited pieces (0 unless counted). */
  items: number;
  productKind: "eligible" | "excluded" | "unclassified";
  /** Coverage issue raised by this verification's own line, if any. */
  issue: { kind: "unclassified_sku" | "invalid_quantity"; detail: string } | null;
}

export interface TimingFact {
  /** Takes part in the timing stream (frame, UN or unparseable legacy line). */
  stream: boolean;
  /** Frame units (0 for UN/legacy lines). */
  weight: number;
  /** Previous effective stream line of the same worker (all work types), full history at the cutoff. */
  prevAll: { id: string; ms: number } | null;
  /** Previous effective stream line of the same worker and work type. */
  prevSameType: { id: string; ms: number } | null;
}

/** One saved count-evidence event, classified once by the shared rules. */
export interface EventFact {
  site: string;
  id: string;
  eventType: string;
  /** Exact instant, epoch microseconds as a decimal string. */
  us: string;
  /** Whole milliseconds (display/durations only). */
  ms: number;
  createdAt: string;
  staffId: string | null;
  department: string | null;
  /** Saved order number, untrimmed (the v2 qualification family matches it exactly). */
  rawOrder: string | null;
  orderKey: string;
  caseId: string | null;
  parentId: string | null;
  sku: string | null;
  quantity: unknown;
  role: FactRole;
  workType: WorkType | null;
  invalidDetail: string | null;
  /** Verifications only. */
  lineKey: string | null;
  item: ItemFact | null;
  timing: TimingFact | null;
  /** Full-history effectiveness at the cutoff (verifications); reversed state (terminals). */
  cancelledBy: string[];
  /** Terminal qualification from ALL original verifications at or before it (full history). */
  fullQualification: Qualification | null;
}

/** A cancellation's relation to its parent, by identity (presence is decided per selection). */
export interface CancelEdgeFact {
  site: string;
  cancelId: string;
  parentId: string;
  self: boolean;
  /** Parent's role when a count-evidence event with that id exists at the site (any role). */
  parentRole: FactRole | null;
  parentUs: string | null;
  /** Pair rule when the parent is a verification/terminal; null otherwise. */
  pair: CancellationPairOutcome | null;
}

export interface FrozenPartitionInput {
  site: string;
  audience: ReportingAudience;
  ruleVersion: string;
  /** Fixed source cutoff: only events created at or before it are facts. */
  sourceCutoffUtc: string;
  /** Complete authorized partition/context source rows (any event types). */
  events: readonly ProductionEvidenceEvent[];
}

export interface PartitionResult {
  site: string;
  audience: ReportingAudience;
  ruleVersion: string;
  sourceCutoffUtc: string;
  facts: EventFact[];
  edges: CancelEdgeFact[];
  /** Rows that cannot be placed in time (always reported, never counted). */
  globalIssues: CoverageIssue[];
  /** Source events after the cutoff: kept out of facts until due. */
  futureEventIds: string[];
  /** SHA-256 of the canonical JSON of everything above. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Canonical hashing (pure, synchronous; identical in browser and Node)
// ---------------------------------------------------------------------------

/** Key-sorted JSON; undefined object members are dropped; non-finite numbers are rejected. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string's UTF-8 bytes, lowercase hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** The fields that define a partition result's identity (everything but the hash itself). */
export function partitionHash(r: Omit<PartitionResult, "hash">): string {
  return sha256Hex(canonicalJson({ ...r, facts: r.facts.map((f) => ({ ...f, quantity: f.quantity === undefined ? null : f.quantity })) }));
}
