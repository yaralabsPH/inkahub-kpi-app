import type { PackingPoint } from "./contents";
import { examplesAllowActivation } from "./evaluate";
import { parseRuleSetBody, type CatalogueItem, type RuleSetBody } from "./ruleSet";

/**
 * F4 box-auto-pick: pure helpers for editing a draft rule set in Settings.
 * A draft being typed can be temporarily invalid (empty key, missing
 * product); it is validated with parseRuleSetBody before it is saved.
 */

export function canManagePackagingRules(role: string | null | undefined): boolean {
  return role === "owner" || role === "manager";
}

/** A fresh, independent copy to edit (drafts never share objects with a saved version). */
export function draftFrom(body: RuleSetBody): RuleSetBody {
  return JSON.parse(JSON.stringify(body)) as RuleSetBody;
}

function uniqueKey(base: string, taken: Set<string>): string {
  const clean = base.trim() || "ITEM";
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const k = `${clean}-${n}`;
    if (!taken.has(k)) return k;
  }
}

/** Add a packaging item for a stock product; the key and label start from the product code. */
export function addCatalogueItem(body: RuleSetBody, product: { id: string; code: string }): RuleSetBody {
  const key = uniqueKey(product.code, new Set(body.catalogue.map((c) => c.key)));
  return { ...body, catalogue: [...body.catalogue, { key, product_id: product.id, label: product.code }] };
}

export function updateCatalogueItem(body: RuleSetBody, index: number, patch: Partial<CatalogueItem>): RuleSetBody {
  const catalogue = body.catalogue.map((c, i) => {
    if (i !== index) return c;
    const next: CatalogueItem = { ...c, ...patch };
    if (!next.legacy_barcode) delete next.legacy_barcode;
    if (!next.packing_points || next.packing_points.length === 0) delete next.packing_points;
    return next;
  });
  // Renaming a key keeps rules and examples pointing at the same item.
  const oldKey = body.catalogue[index]?.key;
  const newKey = catalogue[index]?.key;
  if (oldKey === undefined || newKey === undefined || oldKey === newKey) return { ...body, catalogue };
  const swap = (k: string) => (k === oldKey ? newKey : k);
  return {
    ...body,
    catalogue,
    rules: body.rules.map((r) => ({
      ...r,
      output:
        r.output.mode === "fixed"
          ? { ...r.output, packages: r.output.packages.map((p) => ({ ...p, key: swap(p.key) })) }
          : { ...r.output, package: swap(r.output.package) },
    })),
    examples: body.examples.map((e) => ({
      ...e,
      expect: e.expect === "unresolved" ? e.expect : e.expect.map((p) => ({ ...p, key: swap(p.key) })),
    })),
  };
}

export function removeCatalogueItem(body: RuleSetBody, index: number): RuleSetBody {
  return { ...body, catalogue: body.catalogue.filter((_, i) => i !== index) };
}

export function toggleCataloguePoint(item: CatalogueItem, point: PackingPoint): PackingPoint[] | undefined {
  const all: PackingPoint[] = ["a0_framed", "dispatch", "unframed"];
  const current = item.packing_points ?? all;
  const next = current.includes(point) ? current.filter((p) => p !== point) : [...current, point];
  // Every station (or none ticked) is stored as "no restriction".
  return next.length === 0 || next.length === all.length ? undefined : all.filter((p) => next.includes(p));
}

export interface DraftCheck {
  /** Problems that stop the draft being saved. */
  problems: string[];
  /** True when the draft could be activated once saved: valid, with examples that all pass. */
  canActivate: boolean;
  /** Why it cannot be activated yet (shown next to the button). */
  activationHint: string | null;
}

export function checkDraft(body: RuleSetBody, knownProductIds: ReadonlySet<string>): DraftCheck {
  const parsed = parseRuleSetBody(body);
  const problems = parsed.ok ? [] : [...parsed.problems];
  for (const c of body.catalogue) {
    if (c.product_id && !knownProductIds.has(c.product_id)) {
      problems.push(`Packaging item "${c.label || c.key}" points at a stock item that does not exist at this site.`);
    }
  }
  if (problems.length > 0) return { problems, canActivate: false, activationHint: "Fix the problems above first." };
  if (body.examples.length === 0) {
    return { problems, canActivate: false, activationHint: "Add at least one example before activating." };
  }
  if (!examplesAllowActivation(body)) {
    return { problems, canActivate: false, activationHint: "Every example must pass before activating." };
  }
  return { problems, canActivate: true, activationHint: null };
}
