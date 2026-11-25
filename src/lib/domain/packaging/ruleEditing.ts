import { PIECE_KINDS, PIECE_SIZES, type PackingPoint, type PieceGroup, type PieceKind } from "./contents";
import { evaluatePackaging, type PackagingEvaluation } from "./evaluate";
import {
  ExampleSchema,
  MAX_PACKAGE_QTY,
  RuleSchema,
  type PackageQty,
  type PackagingExample,
  type PackagingRule,
  type RuleSetBody,
} from "./ruleSet";

/**
 * F4 box-auto-pick: pure helpers for the rule editor, the examples table and
 * the simulator in Settings. Like editing.ts, a draft being typed can be
 * temporarily invalid; the per-rule and per-example checks here say what is
 * wrong in plain words, and parseRuleSetBody still guards the save.
 */

export const POINT_LABEL: Record<PackingPoint, string> = { a0_framed: "A0 Framed", dispatch: "Dispatch", unframed: "Unframed" };

export const KIND_LABEL: Record<PieceKind, string> = {
  framed: "Framed print",
  unframed: "Unframed print",
  picture_frame: "Picture frame",
  free_print: "Free print",
  accessory: "Accessory",
};

type Size = (typeof PIECE_SIZES)[number];

function nextId(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

/** Tick or untick one value, keeping the list in its standard order. */
export function toggled<T>(list: readonly T[] | undefined, value: T, order: readonly T[]): T[] {
  const current = list ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return order.filter((v) => next.includes(v));
}

/** A number box that may be left empty. */
export function optionalCount(text: string): number | undefined {
  const t = text.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** A number box that must hold a number; empty or junk becomes 0 so the check flags it. */
export function requiredCount(text: string): number {
  return optionalCount(text) ?? 0;
}

function tidyRule(rule: PackagingRule): PackagingRule {
  const next: PackagingRule = { ...rule };
  if (!next.label) delete next.label;
  if (!next.sizes || next.sizes.length === 0) delete next.sizes;
  if (!next.contains_sizes || next.contains_sizes.length === 0) delete next.contains_sizes;
  if (next.min_pieces === undefined) delete next.min_pieces;
  if (next.max_pieces === undefined) delete next.max_pieces;
  return next;
}

/** A new rule at the bottom of the list (lowest priority). */
export function addRule(body: RuleSetBody, point: PackingPoint): RuleSetBody {
  const rule: PackagingRule = {
    id: nextId("r", body.rules.map((r) => r.id)),
    packing_point: point,
    kinds: ["framed"],
    output: { mode: "fixed", packages: [{ key: body.catalogue[0]?.key ?? "", qty: 1 }] },
  };
  return { ...body, rules: [...body.rules, rule] };
}

export function updateRule(body: RuleSetBody, index: number, patch: Partial<PackagingRule>): RuleSetBody {
  return { ...body, rules: body.rules.map((r, i) => (i === index ? tidyRule({ ...r, ...patch }) : r)) };
}

/** Move a rule one place up (-1) or down (+1). Order is priority. */
export function moveRule(body: RuleSetBody, index: number, by: -1 | 1): RuleSetBody {
  const to = index + by;
  if (index < 0 || index >= body.rules.length || to < 0 || to >= body.rules.length) return body;
  const rules = [...body.rules];
  [rules[index], rules[to]] = [rules[to], rules[index]];
  return { ...body, rules };
}

export function removeRule(body: RuleSetBody, index: number): RuleSetBody {
  return { ...body, rules: body.rules.filter((_, i) => i !== index) };
}

/** Switch a rule between "these packages" and "one package per N pieces", keeping its first package. */
export function withOutputMode(rule: PackagingRule, mode: "fixed" | "per_capacity", fallbackKey: string): PackagingRule["output"] {
  if (rule.output.mode === mode) return rule.output;
  if (mode === "fixed") {
    const from = rule.output.mode === "per_capacity" ? rule.output.package : fallbackKey;
    return { mode: "fixed", packages: [{ key: from, qty: 1 }] };
  }
  const from = rule.output.mode === "fixed" ? rule.output.packages[0]?.key ?? fallbackKey : fallbackKey;
  return { mode: "per_capacity", capacity: 1, package: from };
}

export function addExample(
  body: RuleSetBody,
  point: PackingPoint,
  seed?: { contents: PieceGroup[]; expect: PackagingExample["expect"] },
): RuleSetBody {
  const example: PackagingExample = {
    id: nextId("e", body.examples.map((e) => e.id)),
    packing_point: point,
    contents: seed?.contents ?? [{ kind: "framed", size: "A1", pieces: 1 }],
    expect: seed?.expect ?? "unresolved",
  };
  return { ...body, examples: [...body.examples, example] };
}

export function updateExample(body: RuleSetBody, index: number, patch: Partial<PackagingExample>): RuleSetBody {
  return {
    ...body,
    examples: body.examples.map((e, i) => {
      if (i !== index) return e;
      const next: PackagingExample = { ...e, ...patch };
      if (!next.label) delete next.label;
      return next;
    }),
  };
}

export function removeExample(body: RuleSetBody, index: number): RuleSetBody {
  return { ...body, examples: body.examples.filter((_, i) => i !== index) };
}

/** Accessories have no print size; every other kind needs one. */
export function withKind(group: PieceGroup, kind: PieceKind): PieceGroup {
  if (kind === "accessory") return { ...group, kind, size: null };
  return { ...group, kind, size: group.size ?? "A1" };
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

function packageIssues(packages: readonly PackageQty[], keys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of packages) {
    if (!p.key) out.push("Choose a packaging item.");
    else if (!keys.has(p.key)) out.push(`Packaging item "${p.key}" is no longer in the list above.`);
    else if (seen.has(p.key)) out.push("The same packaging item is listed twice.");
    seen.add(p.key);
    if (!Number.isInteger(p.qty) || p.qty < 1 || p.qty > MAX_PACKAGE_QTY) out.push(`Quantity must be 1 to ${MAX_PACKAGE_QTY}.`);
  }
  return out;
}

/** What is wrong with one rule, in plain words. Empty when the rule is usable. */
export function ruleIssues(body: RuleSetBody, index: number): string[] {
  const rule = body.rules[index];
  if (!rule) return [];
  const keys = new Set(body.catalogue.map((c) => c.key));
  const out: string[] = [];

  if (rule.kinds.length === 0) out.push("Tick at least one kind of item.");
  for (const n of [rule.min_pieces, rule.max_pieces]) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) out.push("Piece counts must be whole numbers of 1 or more.");
  }
  if (rule.min_pieces !== undefined && rule.max_pieces !== undefined && rule.min_pieces > rule.max_pieces) {
    out.push("The lowest piece count is larger than the highest.");
  }
  if (rule.sizes && rule.contains_sizes && rule.contains_sizes.some((s) => !rule.sizes!.includes(s))) {
    out.push('"Only when the parcel includes" names a size this rule does not take.');
  }
  if (rule.output.mode === "fixed") {
    if (rule.output.packages.length === 0) out.push("Add at least one packaging item.");
    out.push(...packageIssues(rule.output.packages, keys));
  } else {
    out.push(...packageIssues([{ key: rule.output.package, qty: 1 }], keys));
    const c = rule.output.capacity;
    if (!Number.isInteger(c) || c < 1 || c > 500) out.push("Pieces per package must be 1 to 500.");
  }
  if (body.rules.filter((r) => r.id === rule.id).length > 1) out.push("Another rule has the same id. Delete one and add it again.");

  // Anything the list above does not name (a very long name, for example).
  if (out.length === 0) {
    const parsed = RuleSchema.safeParse(rule);
    if (!parsed.success) out.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return unique(out);
}

/** What is wrong with one example, in plain words. Empty when it is usable. */
export function exampleIssues(body: RuleSetBody, index: number): string[] {
  const example = body.examples[index];
  if (!example) return [];
  const keys = new Set(body.catalogue.map((c) => c.key));
  const out: string[] = [];

  if (example.contents.length === 0) out.push("Add at least one item to the parcel.");
  for (const g of example.contents) {
    if (!Number.isInteger(g.pieces) || g.pieces < 1) out.push("Pieces must be a whole number of 1 or more.");
    if (g.kind !== "accessory" && g.size === null) out.push("Choose a size.");
  }
  if (example.expect !== "unresolved") out.push(...packageIssues(example.expect, keys));
  if (body.examples.filter((e) => e.id === example.id).length > 1) out.push("Another example has the same id. Delete one and add it again.");

  if (out.length === 0) {
    const parsed = ExampleSchema.safeParse(example);
    if (!parsed.success) out.push(...parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return unique(out);
}

/**
 * Split a draft's problem list into the ones shown next to a rule or example
 * (counted here) and the rest (shown in the list above the buttons).
 */
export function splitDraftProblems(problems: readonly string[]): { general: string[]; markedBelow: number } {
  const general = problems.filter((p) => !/^(rules|examples)\.\d|^Rule |^Example /.test(p));
  return { general, markedBelow: problems.length - general.length };
}

/** Rows typed into the simulator, without the ones that hold no pieces. */
export function usableContents(contents: readonly PieceGroup[]): PieceGroup[] {
  return contents.filter((g) => Number.isInteger(g.pieces) && g.pieces >= 1).map((g) => ({ ...g }));
}

export interface Simulation {
  evaluation: PackagingEvaluation;
  /** The rules that fired, in order, with their place in the list. */
  fired: { id: string; position: number; label: string | null }[];
}

/** Try a parcel against the draft, exactly as a station would. */
export function simulate(body: RuleSetBody, point: PackingPoint, contents: readonly PieceGroup[]): Simulation {
  const evaluation = evaluatePackaging(body, point, { pieces: usableContents(contents), unclassified: [] });
  const fired = evaluation.firedRuleIds.map((id) => {
    const position = body.rules.findIndex((r) => r.id === id);
    return { id, position: position + 1, label: body.rules[position]?.label ?? null };
  });
  return { evaluation, fired };
}

/** Keep what the simulator just showed as an example, so a later rule change that breaks it is caught. */
export function exampleFromSimulation(body: RuleSetBody, point: PackingPoint, contents: readonly PieceGroup[]): RuleSetBody {
  const usable = usableContents(contents);
  if (usable.length === 0) return body;
  const { evaluation } = simulate(body, point, usable);
  const expect: PackagingExample["expect"] =
    evaluation.status === "unresolved" ? "unresolved" : evaluation.packages.map((p) => ({ key: p.key, qty: p.qty }));
  return addExample(body, point, { contents: usable, expect });
}

export function describeGroup(g: PieceGroup): string {
  return `${g.pieces} × ${g.size ? `${g.size} ` : ""}${KIND_LABEL[g.kind] ?? g.kind}`;
}

export function describePackages(packages: "unresolved" | readonly PackageQty[], body: RuleSetBody): string {
  if (packages === "unresolved") return "Flagged (no automatic pick)";
  if (packages.length === 0) return "No packaging";
  return packages.map((p) => `×${p.qty} ${body.catalogue.find((c) => c.key === p.key)?.label ?? p.key}`).join(", ");
}

/**
 * True when a stored draft has the basic shape the editor needs to draw it.
 * A draft saved outside the app could be anything; one that fails here is
 * reported instead of opened.
 */
export function isEditableBody(input: unknown): input is RuleSetBody {
  const b = input as Partial<RuleSetBody> | null;
  if (!b || typeof b !== "object") return false;
  if (!Array.isArray(b.catalogue) || !Array.isArray(b.rules) || !Array.isArray(b.examples)) return false;
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
  const okPackages = (v: unknown) => Array.isArray(v) && v.every((p) => obj(p) && typeof p.key === "string");
  const okRule = (r: unknown) => {
    if (!obj(r) || typeof r.id !== "string" || !Array.isArray(r.kinds) || !obj(r.output)) return false;
    if (r.sizes !== undefined && !Array.isArray(r.sizes)) return false;
    if (r.contains_sizes !== undefined && !Array.isArray(r.contains_sizes)) return false;
    return r.output.mode === "fixed" ? okPackages(r.output.packages) : r.output.mode === "per_capacity" && typeof r.output.package === "string";
  };
  const okExample = (e: unknown) =>
    obj(e) && typeof e.id === "string" && Array.isArray(e.contents) && e.contents.every(obj) && (e.expect === "unresolved" || okPackages(e.expect));
  return b.catalogue.every((c) => obj(c) && typeof c.key === "string") && b.rules.every(okRule) && b.examples.every(okExample);
}

export const SIZE_OPTIONS: readonly Size[] = PIECE_SIZES;
export const KIND_OPTIONS: readonly PieceKind[] = PIECE_KINDS;
