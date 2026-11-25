/**
 * F7 dispatch flow: turn one looked-up order into the exact dispatch payload
 * the server commits (docs/specs/dispatch-flow.md), plus the small pure rules
 * for "who framed it".
 *
 * Same strictness as F6 framing: the existing SKU parser and deduction
 * router, never a guess. Anything it cannot classify sends the order to the
 * classic dispatch station.
 *
 * Framing evidence itself is resolved ONLY by the server
 * (scanner_dispatch_evidence / scanner_commit_dispatch share one SQL
 * reader), so preview and commit can never disagree about the rule. This
 * module only decides, from the server's answer, which lines still need a
 * person chosen, and applies the dispatcher's choice to an unsent payload.
 */
import { parseSku, routeShopifyLineToCatalogueLines, shouldDeductAtDept } from "@/lib/domain/skuRouting";
import { packagingContents, packagingLinesFromOrder, totalPieces } from "@/lib/domain/packaging/contents";
import { buildApplyPayload, predictPackaging } from "@/lib/domain/packaging/session";
import {
  MAX_LINE_QUANTITY,
  no,
  framingPieceMultiplier,
  orderHeaderProblem,
  type CatalogueProduct,
  type FramingPackaging,
  type FramingWorkType,
  type OrderLookup,
  type PackagingSetup,
  type PrepareRefusal,
} from "./order";

export type ScanMode = "framing" | "dispatch";

export interface DispatchFramedLine {
  sku: string;
  /** Raw ordered quantity, summed per SKU. */
  quantity: number;
  workType: FramingWorkType;
  pieces: number;
}

export type EvidenceStatus = "measured" | "missing" | "conflict";

/** The server's answer for one framed SKU (display + the decision to ask). */
export interface FramerEvidence {
  sku: string;
  status: EvidenceStatus;
  personId: string | null;
  displayName: string | null;
  verifiedEventId: string | null;
  completedEventId: string | null;
}

/** The dispatcher's assertion for one SKU with no measured record. */
export interface FramerChoice {
  sku: string;
  personId: string;
  displayName: string;
}

export interface PreparedDispatch {
  mode: "dispatch";
  orderNumber: string;
  displayName: string;
  /** Total ordered items (classic dispatched.line_quantity). */
  items: number;
  framed: DispatchFramedLine[];
  /** Dispatch-terminal components (catalogue code -> qty). */
  components: Array<{ code: string; qty: number }>;
  /** F4 packaging for the Dispatch parcel; null when nothing is packed here. */
  packaging: FramingPackaging | null;
  /** Evidence as previewed (display only; the server re-checks at commit). */
  evidence: FramerEvidence[];
  /** Manual attributions, only for SKUs without measured evidence. */
  choices: FramerChoice[];
}

export type DispatchPrepareResult = { ok: true; prepared: PreparedDispatch } | PrepareRefusal;

const CLASSIC = " Use the classic dispatch station for this order.";

function refuse(r: PrepareRefusal): PrepareRefusal {
  // Header refusals carry the framing wording; dispatch points at dispatch.
  return { ...r, message: r.message.replace(" Use the classic station for this order.", CLASSIC) };
}

const byKey = <T,>(k: (t: T) => string) => (a: T, b: T) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0);

/**
 * Supported: framed single/set prints (F6 grammar, incl. A0), unframed
 * prints, free prints, accessories and gift cards. Everything else
 * (picture frames, canvas, legacy/blank SKUs, GW singles) is classic.
 */
export function prepareDispatchOrder(
  lookup: OrderLookup,
  ctx: { orderNumber: string; openCase: boolean; products: readonly CatalogueProduct[]; packaging: PackagingSetup | null },
): DispatchPrepareResult {
  const n = ctx.orderNumber;
  const header = orderHeaderProblem(lookup, n, ctx.openCase);
  if (header) return refuse(header);

  const bySku = new Map<string, DispatchFramedLine>();
  const allLines: Array<{ sku: string; quantity: number }> = [];
  let items = 0;
  for (const it of lookup.line_items ?? []) {
    const sku = (it.sku ?? "").trim().toUpperCase();
    if (!sku) return refuse(no("blank_sku", `Order #${n} has a line without a SKU.`));
    const q = it.quantity;
    if (!Number.isInteger(q) || q < 1 || q > MAX_LINE_QUANTITY) return refuse(no("invalid_quantity", `Line ${sku} has quantity ${String(q)}.`));
    const p = parseSku(sku);
    if (!p) return refuse(no("unknown_sku", `Line ${sku} is not a current SKU.`));
    if (p.variant === "SC") return refuse(no("canvas", `Line ${sku} is stretched canvas.`));
    if (p.type === "picture_frame") return refuse(no("unsupported_sku", `Line ${sku} is a picture frame.`));
    const isPrint = p.type === "single_print" || p.type === "set_print";
    if (isPrint && p.size === "GW" && p.type !== "set_print") return refuse(no("unsupported_sku", `Line ${sku} is not a supported gallery-wall SKU.`));
    allLines.push({ sku, quantity: q });
    items += q;
    if (!(isPrint && (p.variant === "FB" || p.variant === "FW" || p.variant === "FN"))) continue;
    const hit = bySku.get(sku);
    const quantity = (hit?.quantity ?? 0) + q;
    if (quantity > MAX_LINE_QUANTITY) return refuse(no("invalid_quantity", `Line ${sku} has quantity ${quantity}.`));
    bySku.set(sku, { sku, quantity, workType: p.size === "A0" ? "a0_framed" : "framed", pieces: quantity * framingPieceMultiplier(sku) });
  }
  if (allLines.length === 0) return refuse(no("not_found", `Order #${n} has no lines.`));

  // Exactly what the classic dispatch completion deducts (A0 and unframed
  // prints belong to their own benches; the ledger skips anything already
  // charged for the order, e.g. accessories shipped from the A0 bench).
  const byCode = new Map<string, number>();
  for (const l of allLines) {
    if (!shouldDeductAtDept(l.sku, "dispatch", "dispatched")) continue;
    const route = routeShopifyLineToCatalogueLines(l.sku, l.quantity);
    if (route.lines.length === 0) return refuse(no("unroutable_component", `No stock components for ${l.sku}: ${route.reason ?? "unknown"}.`));
    for (const c of route.lines) byCode.set(c.code, (byCode.get(c.code) ?? 0) + c.qty);
  }
  for (const code of byCode.keys()) {
    const known = ctx.products.some((p) => p.id === code || p.code.trim().toLowerCase() === code.toLowerCase());
    if (!known) return refuse(no("missing_stock_code", `Stock code ${code} is not in this site's catalogue.`));
  }
  if (byCode.size > 30) return refuse(no("too_many_lines", `Order #${n} needs more than 30 stock components.`));
  const components = [...byCode.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([code, qty]) => ({ code, qty }));

  // F4: the Dispatch parcel, if this order packs anything here.
  let packaging: FramingPackaging | null = null;
  const pLines = packagingLinesFromOrder(allLines);
  const here = packagingContents(pLines, "dispatch");
  if (totalPieces(here) > 0 || here.unclassified.length > 0) {
    const setup = ctx.packaging;
    if (!setup || setup.mode !== "auto" || !setup.ruleSet) {
      return refuse(no("packaging_not_auto", `Order #${n} needs automatic box rules at this site.`));
    }
    const prediction = predictPackaging(setup.ruleSet.body, "dispatch", pLines, { replacement: false });
    const ev = prediction.evaluation;
    if (ev.status !== "resolved" || ev.packages.length === 0) {
      return refuse(no("packaging_unresolved", `The box rules could not pick the dispatch packaging for #${n}${ev.reason ? ` (${ev.reason})` : ""}.`));
    }
    const payload = buildApplyPayload({ ruleSet: setup.ruleSet, prediction, chosen: ev.packages });
    packaging = {
      ruleSetId: payload.ruleSetId,
      ruleSetVersion: setup.ruleSet.version,
      resolved: true,
      predicted: payload.predicted,
      target: payload.target,
      snapshot: payload.snapshot,
    };
  }

  const prepared: PreparedDispatch = {
    mode: "dispatch",
    orderNumber: n,
    displayName: `#${n}`,
    items,
    framed: [...bySku.values()].sort(byKey((l) => l.sku)),
    components,
    packaging,
    evidence: [],
    choices: [],
  };
  return { ok: true, prepared: JSON.parse(JSON.stringify(prepared)) as PreparedDispatch };
}

export function isPreparedDispatch(p: unknown): p is PreparedDispatch {
  return typeof p === "object" && p !== null && (p as { mode?: unknown }).mode === "dispatch";
}

/** SKUs the server could not attribute to one measured framer. */
export function missingSkus(p: PreparedDispatch): string[] {
  const measured = new Set(p.evidence.filter((e) => e.status === "measured").map((e) => e.sku));
  return p.framed.map((l) => l.sku).filter((s) => !measured.has(s));
}

/** Lines still without a measured record or a manual choice. */
export function unresolvedSkus(p: PreparedDispatch): string[] {
  const chosen = new Set(p.choices.map((c) => c.sku));
  return missingSkus(p).filter((s) => !chosen.has(s));
}

/**
 * Attach the server's evidence answer (one row per framed SKU, nothing
 * else). Choices are cleared: they are made against this evidence.
 */
export function withEvidence(p: PreparedDispatch, evidence: readonly FramerEvidence[]): PreparedDispatch | null {
  const skus = p.framed.map((l) => l.sku);
  const got = evidence.map((e) => e.sku);
  if (got.length !== skus.length || new Set(got).size !== got.length || !skus.every((s) => got.includes(s))) return null;
  for (const e of evidence) {
    if (e.status === "measured" && (!e.personId || !e.verifiedEventId || !e.completedEventId)) return null;
  }
  return JSON.parse(JSON.stringify({ ...p, evidence: [...evidence].sort(byKey((e: FramerEvidence) => e.sku)), choices: [] })) as PreparedDispatch;
}

export type ChoiceError = "not_missing" | "incomplete" | "duplicate" | "unknown_sku";

/**
 * Apply the dispatcher's choice to an UNSENT payload: exactly one person per
 * SKU that has no measured record, nothing for measured SKUs.
 */
export function applyChoices(p: PreparedDispatch, choices: readonly FramerChoice[]): { ok: true; prepared: PreparedDispatch } | { ok: false; error: ChoiceError } {
  const missing = missingSkus(p);
  const seen = new Set<string>();
  for (const c of choices) {
    if (!p.framed.some((l) => l.sku === c.sku)) return { ok: false, error: "unknown_sku" };
    if (!missing.includes(c.sku)) return { ok: false, error: "not_missing" };
    if (seen.has(c.sku)) return { ok: false, error: "duplicate" };
    if (!c.personId || !c.displayName) return { ok: false, error: "incomplete" };
    seen.add(c.sku);
  }
  if (seen.size !== missing.length) return { ok: false, error: "incomplete" };
  const sorted = [...choices].map((c) => ({ sku: c.sku, personId: c.personId, displayName: c.displayName })).sort(byKey((c) => c.sku));
  return { ok: true, prepared: JSON.parse(JSON.stringify({ ...p, choices: sorted })) as PreparedDispatch };
}

/**
 * One person for every missing line, with optional per-line overrides
 * (the compact chooser: "all missing lines were framed by ...").
 */
export function choicesFor(
  p: PreparedDispatch,
  all: { personId: string; displayName: string } | null,
  overrides: Readonly<Record<string, { personId: string; displayName: string } | undefined>> = {},
): FramerChoice[] {
  const out: FramerChoice[] = [];
  for (const sku of missingSkus(p)) {
    const who = overrides[sku] ?? all;
    if (who) out.push({ sku, personId: who.personId, displayName: who.displayName });
  }
  return out;
}

/** Block codes whose job is waiting for the dispatcher's choice (pre-commit, nothing saved). */
export const CHOICE_CODES: ReadonlySet<string> = new Set(["framer_missing", "framer_inactive"]);

/** Dispatch identity: until the next site 04:00 workday start, at most twelve hours. */
export const DISPATCH_SHIFT_MAX_MS = 12 * 60 * 60 * 1000;

export function dispatchShiftEnd(activatedAt: number, workdayEndsAt: number | null): number {
  const cap = activatedAt + DISPATCH_SHIFT_MAX_MS;
  return workdayEndsAt !== null && Number.isFinite(workdayEndsAt) ? Math.min(cap, workdayEndsAt) : cap;
}
