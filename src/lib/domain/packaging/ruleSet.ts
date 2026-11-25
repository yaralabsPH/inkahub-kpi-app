import { z } from "zod";

/**
 * F4 box-auto-pick: the shape of a packaging rule set (the JSON stored in
 * packaging_rule_sets.body). Rules are data an owner or manager edits in
 * Settings; none are defined in code.
 */

export const PackingPointSchema = z.enum(["a0_framed", "dispatch", "unframed"]);
export const PieceKindSchema = z.enum(["framed", "unframed", "picture_frame", "free_print", "accessory"]);
export const PieceSizeSchema = z.enum(["A0", "A1", "A2", "A3", "A4", "GW"]);

/** Largest quantity of one packaging item a single pick may hold (mirrors the SQL bound). */
export const MAX_PACKAGE_QTY = 20;
/** Most distinct packaging items a single pick may hold (mirrors the SQL bound). */
export const MAX_PACKAGE_LINES = 10;

const Key = z.string().trim().min(1).max(60);

export const CatalogueItemSchema = z.object({
  /** Stable key rules refer to, e.g. "A1-Single". */
  key: Key,
  /** products.id at this site; the stock item that is deducted. */
  product_id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(80),
  /** Printed box barcode pattern from the old scan flow, e.g. "+48=". */
  legacy_barcode: z.string().trim().min(1).max(40).optional(),
  /** Where a worker may pick this item by hand. Omitted = every packing point. */
  packing_points: z.array(PackingPointSchema).min(1).optional(),
});
export type CatalogueItem = z.infer<typeof CatalogueItemSchema>;

export const PackageQtySchema = z.object({
  key: Key,
  qty: z.number().int().min(1).max(MAX_PACKAGE_QTY),
});
export type PackageQty = z.infer<typeof PackageQtySchema>;

export const RuleOutputSchema = z.discriminatedUnion("mode", [
  /** All matched pieces go into this fixed list of packages. */
  z.object({ mode: z.literal("fixed"), packages: z.array(PackageQtySchema).min(1).max(MAX_PACKAGE_LINES) }),
  /** One package per `capacity` matched pieces, rounded up. */
  z.object({ mode: z.literal("per_capacity"), capacity: z.number().int().min(1).max(500), package: Key }),
]);
export type RuleOutput = z.infer<typeof RuleOutputSchema>;

export const RuleSchema = z.object({
  id: Key,
  label: z.string().trim().max(120).optional(),
  packing_point: PackingPointSchema,
  /** Piece kinds this rule takes. */
  kinds: z.array(PieceKindSchema).min(1),
  /** Sizes this rule takes. Omitted = any size, including accessories (no size). */
  sizes: z.array(PieceSizeSchema).min(1).optional(),
  /** Fire only when the matched piece count is within this range. */
  min_pieces: z.number().int().min(1).optional(),
  max_pieces: z.number().int().min(1).optional(),
  /** Fire only when every one of these sizes is among the matched pieces. */
  contains_sizes: z.array(PieceSizeSchema).min(1).optional(),
  output: RuleOutputSchema,
});
export type PackagingRule = z.infer<typeof RuleSchema>;

export const PieceGroupSchema = z.object({
  kind: PieceKindSchema,
  size: PieceSizeSchema.nullable(),
  pieces: z.number().int().min(1).max(10_000),
});

export const ExampleSchema = z.object({
  id: Key,
  label: z.string().trim().max(160).optional(),
  packing_point: PackingPointSchema,
  contents: z.array(PieceGroupSchema).min(1),
  /** Expected packages, or "unresolved" when no automatic pick should happen. */
  expect: z.union([z.literal("unresolved"), z.array(PackageQtySchema)]),
});
export type PackagingExample = z.infer<typeof ExampleSchema>;

export const RuleSetBodySchema = z.object({
  schema_version: z.literal(1),
  catalogue: z.array(CatalogueItemSchema).max(100),
  rules: z.array(RuleSchema).max(300),
  examples: z.array(ExampleSchema).max(300),
});
export type RuleSetBody = z.infer<typeof RuleSetBodySchema>;

export function emptyRuleSetBody(): RuleSetBody {
  return { schema_version: 1, catalogue: [], rules: [], examples: [] };
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
}

/**
 * Problems zod's shape check cannot see: duplicate ids, rules or examples
 * that name a package missing from the catalogue, impossible ranges.
 * Returns human-readable messages; empty when the rule set is usable.
 */
export function ruleSetProblems(body: RuleSetBody): string[] {
  const problems: string[] = [];
  const keys = new Set(body.catalogue.map((c) => c.key));

  for (const d of duplicates(body.catalogue.map((c) => c.key))) problems.push(`Packaging item "${d}" is listed twice.`);
  for (const d of duplicates(body.catalogue.map((c) => c.legacy_barcode).filter((b): b is string => !!b))) {
    problems.push(`Barcode "${d}" is used by more than one packaging item.`);
  }
  for (const d of duplicates(body.rules.map((r) => r.id))) problems.push(`Rule id "${d}" is used twice.`);
  for (const d of duplicates(body.examples.map((e) => e.id))) problems.push(`Example id "${d}" is used twice.`);

  for (const r of body.rules) {
    const name = r.label ? `Rule "${r.label}"` : `Rule ${r.id}`;
    if (r.min_pieces !== undefined && r.max_pieces !== undefined && r.min_pieces > r.max_pieces) {
      problems.push(`${name}: minimum pieces is larger than maximum pieces.`);
    }
    if (r.sizes && r.contains_sizes && r.contains_sizes.some((s) => !r.sizes!.includes(s))) {
      problems.push(`${name}: "must contain" names a size the rule does not take.`);
    }
    const used = r.output.mode === "fixed" ? r.output.packages.map((p) => p.key) : [r.output.package];
    for (const k of used) if (!keys.has(k)) problems.push(`${name}: packaging item "${k}" is not in the catalogue.`);
    if (r.output.mode === "fixed") {
      for (const d of duplicates(used)) problems.push(`${name}: packaging item "${d}" is listed twice.`);
    }
  }
  for (const e of body.examples) {
    if (e.expect === "unresolved") continue;
    for (const p of e.expect) {
      if (!keys.has(p.key)) problems.push(`Example ${e.label ?? e.id}: packaging item "${p.key}" is not in the catalogue.`);
    }
  }
  return problems;
}

export type ParsedRuleSet =
  | { ok: true; body: RuleSetBody }
  | { ok: false; problems: string[] };

/** Parse and validate untrusted JSON (from the database or the editor). */
export function parseRuleSetBody(input: unknown): ParsedRuleSet {
  const parsed = RuleSetBodySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "rule set"}: ${i.message}`),
    };
  }
  const problems = ruleSetProblems(parsed.data);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, body: parsed.data };
}
