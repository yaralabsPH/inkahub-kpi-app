import { z } from "zod";

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Expected YYYY-MM-DD");
export const IsoDateTime = z.string().datetime({ offset: true });
export const Id = z.string().min(1);

export const UnitOfSale = z.enum(["each", "case"]);

/**
 * High-level category telling the UI how to treat a SKU:
 *   product    ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â finished goods sold to customers. Shows up in Sales
 *                Entry, Order builder, Shopping list ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â everywhere.
 *                Default for backward compatibility.
 *   consumable ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used in production but never sold (ink cartridges,
 *                paper rolls, mouldings, backing boards). Excluded from
 *                Sales Entry; still tracked for reorder & warehouse.
 *   packaging  ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â fulfillment supplies (boxes, bubble wrap, tape, corner
 *                protectors). Behaves like consumable for the UI.
 *   service    ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â non-physical line items (printing fee, expedited
 *                shipping). Tracked for reporting but not inventory.
 *
 * Adding a new type is one entry here + (optionally) one new branch in
 * the filters that exclude non-products from Sales Entry. The default
 * "product" keeps every existing SKU working unchanged.
 */
export const ProductType = z.enum(["product", "consumable", "packaging", "service"]);
export type ProductTypeKey = z.infer<typeof ProductType>;

export const PRODUCT_TYPE_LABELS: Record<ProductTypeKey, string> = {
  product: "Product",
  consumable: "Consumable",
  packaging: "Packaging",
  service: "Service",
};

export const PRODUCT_TYPE_HINTS: Record<ProductTypeKey, string> = {
  product: "Finished goods sold to customers. Appears everywhere (Sales entry, Order builder, etc).",
  consumable: "Used in production, never sold (ink, paper rolls, mouldings). Hidden from Sales entry.",
  packaging: "Fulfillment supplies (boxes, tape, bubble wrap). Hidden from Sales entry.",
  service: "Non-physical (printing fee, shipping). Hidden from Sales entry.",
};

/** Product types that appear in Sales entry. Everything else is hidden. */
export const SALEABLE_PRODUCT_TYPES = new Set<ProductTypeKey>(["product"]);

/**
 * Derive the department for a product from its supplier field.
 *
 *   supplier === "UNFRAMED" (case-insensitive, trimmed) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "unframed"
 *   anything else (CHINA, blank, unknown)               ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "framed"
 *
 * Avoids needing a dedicated `department` column on Product ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the supplier
 * is already the source of truth for which side of the business handles it.
 */
export function productDepartment(p: { supplier?: string | null }): "framed" | "unframed" {
  return (p.supplier ?? "").trim().toUpperCase() === "UNFRAMED" ? "unframed" : "framed";
}

/**
 * Three-way production-department routing for a product (no dispatch ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * dispatch is order-level, not line-level):
 *
 *   unframed prints ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "unframed"
 *   framed A0       ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "a0_framed"  (own bench by business rule)
 *   framed other    ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ "framed"
 *
 * Used on the Production page to filter which Shopify line items show on
 * each department's tablet. A bench worker on the "framed" bench only
 * sees lines this function returns "framed" for; the A0 bench only sees
 * "a0_framed"; etc.
 */
export function lineProductionDepartment(
  p: { supplier?: string | null; size?: string | null },
): "a0_framed" | "framed" | "unframed" {
  if (productDepartment(p) === "unframed") return "unframed";
  const size = (p.size ?? "").trim().toUpperCase();
  return size === "A0" ? "a0_framed" : "framed";
}
export const WeeklyAvgMethod = z.enum([
  "trailing_8", "trailing_12", "weighted", "manual", "selected_weeks",
]);
export const ShipmentStatus = z.enum([
  "Draft", "Ordered", "Back-Ordered", "In Production", "In Transit", "Customs", "Delivered", "On hold", "Cancelled",
]);
export const BayType = z.enum(["floor", "rack", "cold"]);

// ---------- Product ----------

/**
 * One line of a parent SKU's bill-of-materials. When the parent is sold,
 * inventory cascades to each `child_product_id` by `units_sold *
 * qty_per_unit`. Fractional qty is allowed for continuous resources
 * (e.g. 0.000028 of a 30 m paper roll per A1 print).
 */
export const ProductComponentSchema = z.object({
  child_product_id: Id,
  qty_per_unit: z.number().positive(),
});
export type ProductComponent = z.infer<typeof ProductComponentSchema>;

export const ProductSchema = z.object({
  id: Id,
  code: z.string().min(1, "Code is required"),
  short_code: z.string().nullable().default(null),
  size: z.string().default(""),
  colour: z.string().default(""),
  unit_of_sale: UnitOfSale.default("each"),
  /**
   * Determines whether the SKU appears in Sales entry. Default "product"
   * keeps every legacy record behaving as before. Mark ink, paper rolls,
   * backing boards etc as "consumable" to hide them from Sales entry
   * while keeping them in the catalogue for reorder / forecasting / BOM.
   */
  product_type: ProductType.default("product"),
  pallet_capacity_units: z.number().int().nonnegative(),
  bay_capacity_pallets: z.number().int().nonnegative(),
  supplier: z.string().min(1),
  lead_time_days: z.number().int().nonnegative(),
  min_order_qty: z.number().int().nonnegative().default(0),
  order_increment: z.number().int().positive().default(1),
  /**
   * Current on-hand stock. Was `int` pre-Phase 3; relaxed to allow
   * fractional consumption of continuous resources (paper rolls, ink
   * cartridges, frame mouldings sold by metre). Existing integer data
   * still parses cleanly. Manual edits via the SKU form still floor to
   * integer; only BOM cascades can introduce fractions.
   */
  current_on_hand: z.number().nonnegative(),
  /** @deprecated Kept as a fallback floor when safety_stock_pct is 0. New code reads safety_stock_pct. */
  safety_stock_units: z.number().int().nonnegative().default(0),
  /**
   * Safety stock expressed as a percentage of weekly average demand. Drives
   * the Reorder alert: a SKU goes Reorder when projected weeks_left dips
   * below this. 100 = 1 week of cover, 200 = 2 weeks, 50 = half a week.
   */
  safety_stock_pct: z.number().nonnegative().default(100),
  /**
   * Target weeks of cover used by the Order builder to size the "Suggested"
   * quantity (targetStock = weekly_avg ÃƒÆ’Ã†â€™— this). Does NOT drive Reorder /
   * Critical alerts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â those come from safety_stock_pct (Reorder) and
   * lead_time_days (Critical). Default 21. Accepts null on input (older
   * backups stored it that way) and coerces to 21 on parse.
   */
  target_weeks_of_cover_override: z
    .number()
    .nonnegative()
    .nullable()
    .default(21)
    .transform((v) => v ?? 21),
  weekly_avg_method: WeeklyAvgMethod.default("trailing_8"),
  weekly_avg_manual: z.number().nonnegative().nullable().default(null),
  unit_cost: z.number().nonnegative().nullable().default(null),
  display_order: z.number().default(0),
  notes: z.string().default(""),
  /**
   * Carton-pack info ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â how many units fit in one outer carton, plus carton
   * dimensions (cm). When all four are set we can compute CBM (cubic
   * metres) for any order quantity, which the order builder uses to show
   * a live container-fill stat. All four are optional; leave blank if the
   * SKU isn't shipped in cartons or you don't track this.
   */
  carton_units: z.number().int().positive().nullable().default(null),
  carton_length_cm: z.number().positive().nullable().default(null),
  carton_width_cm: z.number().positive().nullable().default(null),
  carton_height_cm: z.number().positive().nullable().default(null),
  /**
   * Bill-of-materials. When this SKU is sold (or that sale is reversed),
   * each component is auto-deducted (or credited back) by
   * `units_sold * qty_per_unit`. Empty array = no cascade. Cycle
   * detection runs in the repository's `upsertProduct` write path.
   */
  components: z.array(ProductComponentSchema).default([]),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * CBM (cubic metres) for `qty` units of a SKU based on its carton info.
 * Returns null when any of the four carton fields are missing.
 *
 * Mirrors the spreadsheet formula:
 *   cbm = (L ÃƒÆ’Ã†â€™— W ÃƒÆ’Ã†â€™— H / 1_000_000) ÃƒÆ’Ã†â€™— (qty / units_per_carton)
 */
export function computeCbm(
  p: Pick<Product, "carton_units" | "carton_length_cm" | "carton_width_cm" | "carton_height_cm">,
  qty: number,
): number | null {
  if (!p.carton_units || !p.carton_length_cm || !p.carton_width_cm || !p.carton_height_cm) return null;
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const cartonVolumeCbm =
    (p.carton_length_cm * p.carton_width_cm * p.carton_height_cm) / 1_000_000;
  const cartons = qty / p.carton_units;
  return cartonVolumeCbm * cartons;
}

export function shortCode(p: Pick<Product, "size" | "colour" | "short_code">): string {
  if (p.short_code) return p.short_code;
  return `${p.size}${(p.colour[0] ?? "").toUpperCase()}`;
}

/**
 * Compute the effective safety-stock floor in units for a given SKU and its
 * current weekly-average demand.
 *
 * The `safety_stock_pct` field is authoritative ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â including when the user
 * sets it to 0 (which means "no safety floor"). The legacy
 * `safety_stock_units` is only consulted when `safety_stock_pct` is missing
 * entirely (pre-migration records that haven't been written through the
 * new schema yet).
 */
export function effectiveSafetyStock(
  p: Pick<Product, "safety_stock_pct" | "safety_stock_units"> & { safety_stock_pct?: number },
  weeklyAverage: number,
): number {
  if (typeof p.safety_stock_pct !== "number") {
    // Legacy fallback for records that pre-date the percentage field.
    return p.safety_stock_units ?? 0;
  }
  return Math.max(0, (p.safety_stock_pct / 100) * weeklyAverage);
}

// ---------- Weekly entry / sales ----------

/**
 * Department this weekly entry belongs to. Sales Entry, Dashboard, Order
 * Builder and forecast surfaces filter by the active app-state department
 * so framed and unframed each have their own week-by-week history and
 * totals. New entries default to 'framed' so existing data stays where it
 * is after migration.
 */
export const DepartmentSchema = z.enum(["framed", "unframed"]);
export type Department = z.infer<typeof DepartmentSchema>;

export const WeeklyEntrySchema = z.object({
  iso_week_start: IsoDate,
  /**
   * Composite PK partner. Framed and unframed each get their own row for
   * the same iso_week_start, so the discriminator is part of identity.
   * Old rows missing this field are treated as 'framed' (see default).
   */
  department: DepartmentSchema.default("framed"),
  name: z.string().nullable().default(null),
  total_orders: z.number().nonnegative().nullable().default(null),
  is_reference: z.boolean().default(false),
  entered_at: IsoDateTime,
  entered_by: z.string().default("system"),
  /**
   * Orders contributed by each Shopify weekly-report import, keyed by size
   * (e.g. { A0: 73, A1: 133 }). Used to keep imports idempotent ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â re-running
   * the same size replaces the previous contribution rather than adding to it.
   * The week's `total_orders` is whatever manual value the user typed, plus
   * the sum of these contributions.
   */
  shopify_orders_by_size: z.record(z.number()).default({}),
});
export type WeeklyEntry = z.infer<typeof WeeklyEntrySchema>;

export const WeeklySalesSchema = z.object({
  product_id: Id,
  iso_week_start: IsoDate,
  units_sold: z.number().nonnegative(),
  entered_at: IsoDateTime,
  entered_by: z.string().default("system"),
});
export type WeeklySales = z.infer<typeof WeeklySalesSchema>;

// ---------- Shipments (multi-line) ----------

export const ShipmentLineSchema = z.object({
  product_id: Id,
  quantity: z.number().int().positive(),
});
export type ShipmentLine = z.infer<typeof ShipmentLineSchema>;

export const IncomingShipmentSchema = z
  .object({
    id: Id,
    product_id: Id.optional(),
    quantity: z.number().int().positive().optional(),
    lines: z.array(ShipmentLineSchema).default([]),
    po_number: z.string().min(1),
    supplier: z.string().min(1),
    order_placed_date: IsoDate,
    transit_started_date: IsoDate.nullable().default(null),
    expected_arrival_date: IsoDate,
    actual_arrival_date: IsoDate.nullable().default(null),
    status: ShipmentStatus.default("Ordered"),
    notes: z.string().default(""),
    /** Optional production lead (factory time) in days. */
    production_days: z.number().int().nonnegative().nullable().default(null),
    /** Optional planned ship-out date ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â when goods physically leave factory. */
    estimated_ship_date: IsoDate.nullable().default(null),
    /** Days for customs / clearance after arrival into region. Default 0. */
    customs_days: z.number().int().nonnegative().default(0),
    /**
     * ISO timestamp recording when this shipment's line quantities were
     * credited to product `current_on_hand`. Set automatically by the
     * repository when status transitions to "Delivered"; cleared when
     * status moves away from Delivered. The presence of this field is
     * the idempotency guard ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â we never double-credit and never reverse
     * a credit that didn't fire (e.g. legacy shipments marked Delivered
     * before auto-credit existed will be silently caught on next save).
     */
    inventory_applied_at: IsoDateTime.nullable().default(null),
    /**
     * When true, this shipment is hidden from the default Kanban + List
     * views. Only set on terminal states (Delivered / Cancelled) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â the
     * archive button is gated client-side so it's never offered on a
     * shipment that still needs work. Toggleable: setting back to false
     * brings the shipment back into the active view. The "Show archived"
     * filter override unhides everything regardless.
     */
    archived: z.boolean().default(false),
    delivered_at: IsoDateTime.nullable().default(null),
    delivered_by: z.string().nullable().default(null),
  })
  .transform((s) => {
    if (s.lines.length === 0 && s.product_id && s.quantity) {
      return { ...s, lines: [{ product_id: s.product_id, quantity: s.quantity }] };
    }
    return s;
  });
export type IncomingShipment = z.infer<typeof IncomingShipmentSchema>;

export function shipmentTotalUnits(s: IncomingShipment): number {
  return s.lines.reduce((sum, l) => sum + l.quantity, 0);
}

// ---------- Order templates (reusable line-ups) ----------

/**
 * A saved order layout the user can reload later ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â supplier + a map of
 * product IDs ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ quantities + the shipping/customs presets. Lives on
 * `GlobalSettings.order_templates`.
 */
export const OrderTemplateSchema = z.object({
  id: Id,
  name: z.string().min(1),
  supplier: z.string().min(1),
  /** productId ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ quantity. Quantities are pre-rounding, the modal will round on apply. */
  lines: z.record(z.string(), z.number().int().nonnegative()),
  production_days: z.number().int().nonnegative().nullable().default(null),
  customs_days: z.number().int().nonnegative().default(0),
  notes: z.string().default(""),
  created_at: IsoDateTime,
});
export type OrderTemplate = z.infer<typeof OrderTemplateSchema>;

// ---------- Demand events ----------

export const DemandChangeEventSchema = z
  .object({
    id: Id,
    product_id: z.union([Id, z.literal("*")]),
    name: z.string().min(1),
    start_date: IsoDate,
    end_date: IsoDate,
    /** Multiplier on baseline demand. >1 = boost, <1 = dip. No upper limit. */
    multiplier: z.number().min(0),
    notes: z.string().default(""),
    apply_to_size: z.string().nullable().default(null),
    apply_to_colour: z.string().nullable().default(null),
  })
  .refine((e) => e.start_date <= e.end_date, {
    message: "end_date must be on or after start_date",
    path: ["end_date"],
  });
export type DemandChangeEvent = z.infer<typeof DemandChangeEventSchema>;

// ---------- Storage layout ----------

export const BaySchema = z.object({
  id: Id, label: z.string().min(1),
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  max_pallets: z.number().int().positive(),
  type: BayType.default("floor"), notes: z.string().default(""),
});
export type Bay = z.infer<typeof BaySchema>;

export const PalletAssignmentSchema = z.object({
  id: Id, bay_id: Id,
  slot_index: z.number().int().nonnegative(),
  product_id: Id, quantity: z.number().int().nonnegative(),
  last_updated: IsoDateTime,
});
export type PalletAssignment = z.infer<typeof PalletAssignmentSchema>;

export const StorageLayoutSchema = z.object({
  bays: z.array(BaySchema),
  palletAssignments: z.array(PalletAssignmentSchema),
});
export type StorageLayout = z.infer<typeof StorageLayoutSchema>;

// ---------- Inventory ledger ----------

/**
 * Why an inventory movement happened. The set is deliberately small and
 * generic ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â specifics live in `source_id` (a back-reference to the
 * originating event) and `note` (free text).
 */
export const LedgerReasonSchema = z.enum([
  "sale",         // SalesEntry deduction (cell commit / Shopify import / bulk usage)
  "shipment",     // Incoming-shipment delivered credit (or reversal)
  "usage",        // PaperUsage snapshot (and future generic consumable usage)
  "manual",       // Direct on-hand edits via SKU form / bulk edit / adjustOnHand
  "stocktake",    // Future: stocktake reconciliation
  "transfer",     // Future: cross-location transfer
  "initial",      // First time a product is created with a non-zero on-hand
  "import",       // Bulk import from JSON / CSV / XLSX
  "bom",          // Future: cascading deduction from a parent SKU's recipe
  "replacement",  // CS Cases replacement send-out ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â excluded from sales/revenue math
  "return",       // CS Return restock credit ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â excluded from sales/revenue math
]);
export type LedgerReason = z.infer<typeof LedgerReasonSchema>;

/**
 * Append-only inventory movement. Stored per location (same Dexie DB as
 * the rest of the catalog). `delta` is signed: positive = inbound,
 * negative = outbound. Computed on-hand for a product is `ÃƒÆ’Ã…Â½Ãƒâ€šÃ‚Â£ delta` across
 * all ledger rows for it. Reversal is *not* destructive ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â it's a new row
 * with the opposite sign, optionally tagged with the same `source_id` so
 * a pair can be matched up later.
 *
 * Phase 1 of the ledger rollout: rows are *written* by every inventory-
 * mutating repo method but nothing reads them for correctness yet. The
 * legacy `Product.current_on_hand` field stays authoritative until
 * Phase 3, when on-hand becomes computed from the ledger.
 */
export const LedgerEntrySchema = z.object({
  /** Sortable insertion-order ID: `<unix-ms>-<6-char-random>`. */
  id: Id,
  ts: IsoDateTime,
  product_id: Id,
  /** Signed quantity. Positive = inbound, negative = outbound. */
  delta: z.number(),
  reason: LedgerReasonSchema,
  /**
   * Back-reference to the event that caused this row. Format is reason-
   * specific but namespaced, e.g.:
   *   - "sale:<productId>:<isoWeekStart>"
   *   - "shipment:<shipmentId>:<lineProductId>"
   *   - "paper:<isoWeekStart>:<rollWidth>"
   *   - "product-edit:<productId>:<unix-ms>"
   * Used by reversal logic to find the matching pair on edit/delete.
   */
  source_id: z.string().nullable().default(null),
  /**
   * When this row is one of many in a cascading deduction (e.g. a BOM
   * expansion of one finished-good sale into N component sales), this
   * holds the root event's ID so the whole cascade can be reversed
   * together. Null for standalone events.
   */
  parent_event_id: z.string().nullable().default(null),
  note: z.string().default(""),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------- Paper usage history ----------

/**
 * One persisted snapshot of weekly print counts ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ roll consumption. Stored
 * per location so a multi-country setup can keep separate paper histories.
 * Keyed by iso_week_start (one entry per week ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â re-saving overwrites).
 */
export const PaperUsageEntrySchema = z.object({
  iso_week_start: IsoDate,
  // Counts are typically integers (user types them in the page) but the
  // schema accepts any non-negative number. Some legacy rows have
  // fractional values that came from derived calculations; rejecting
  // them would needlessly fail migration. The roll-math uses
  // `Math.ceil` everywhere it matters, so fractional inputs are safe.
  counts: z.object({
    A0: z.number().nonnegative().default(0),
    A1: z.number().nonnegative().default(0),
    A2: z.number().nonnegative().default(0),
    A3: z.number().nonnegative().default(0),
    A4: z.number().nonnegative().default(0),
  }),
  buffer_pct: z.number().nonnegative().default(0),
  notes: z.string().default(""),
  recorded_at: IsoDateTime,
  recorded_by: z.string().default("manual"),
  /**
   * Integer roll counts deducted from inventory when this snapshot was
   * saved. Stored on the entry itself (not derived) so that re-saving or
   * deleting the snapshot can reverse the exact deduction even if settings
   * changed between save and reversal. `*_sku_id` records which SKU each
   * count came out of, so we always credit it back to the right product
   * even if the user later re-points the roll mapping.
   */
  deducted_rolls_24: z.number().int().nonnegative().default(0),
  deducted_rolls_42: z.number().int().nonnegative().default(0),
  deducted_sku_24_id: z.string().nullable().default(null),
  deducted_sku_42_id: z.string().nullable().default(null),
});
export type PaperUsageEntry = z.infer<typeof PaperUsageEntrySchema>;

// ---------- CS Cases (customer service replacements / complaints) ----------

/**
 * Mirrors the workflow:  new ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ query ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ shipped ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ closed
 * (plus 'denied' as an occasional off-ramp from new or query).
 *
 * 'query' = CS is waiting on info / has follow-up questions before sending
 * the replacement (e.g. asking the customer for a photo of damage). It is a
 * holding state, NOT an approval ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â inventory must not move in this state.
 *
 * Inventory deduction fires only when status transitions to 'shipped' AND
 * `tracking_number` is non-empty. Once deducted, edits to lines prompt a
 * confirmation in the UI to re-deduct.
 */
export const CsCaseStatusSchema = z.enum(["new", "query", "shipped", "closed", "denied"]);
export type CsCaseStatus = z.infer<typeof CsCaseStatusSchema>;

export const CsCaseUrgencySchema = z.enum(["critical", "high", "medium", "low"]);
export type CsCaseUrgency = z.infer<typeof CsCaseUrgencySchema>;

/**
 * Issue categories from the historical Notion data, normalised to
 * snake_case. Add new categories here + in the SQL CHECK constraint.
 */
export const CsCaseIssueTypeSchema = z.enum([
  "damaged",
  "incorrect_missing",
  "delivery_issue",
  "expedite",
  "quality",
  "other",
]);
export type CsCaseIssueType = z.infer<typeof CsCaseIssueTypeSchema>;

/** Routing hint ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â auto-derived from line items by the UI, but stored explicitly so reports can group cleanly. */
export const CsCaseDepartmentSchema = z.enum(["framed", "unframed", "mixed"]);
export type CsCaseDepartment = z.infer<typeof CsCaseDepartmentSchema>;

export const CS_CASE_STATUS_LABELS: Record<CsCaseStatus, string> = {
  new: "New",
  query: "Query",
  shipped: "Shipped",
  closed: "Closed",
  denied: "Denied",
};

export const CS_CASE_URGENCY_LABELS: Record<CsCaseUrgency, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const CS_CASE_ISSUE_LABELS: Record<CsCaseIssueType, string> = {
  damaged: "Damaged",
  incorrect_missing: "Incorrect / Missing",
  delivery_issue: "Delivery Issue",
  expedite: "Expedite",
  quality: "Quality Issue",
  other: "Other",
};

/**
 * One line item being replaced. A case has many lines ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used when the
 * customer needs multiple items resent. Quantity is positive; the
 * inventory deduction at approval time multiplies through.
 */
export const CsCaseLineSchema = z.object({
  id: Id,
  case_id: Id,
  product_id: Id,
  quantity: z.number().int().positive(),
  /** Shopify variant SKU that drove this replacement (display-only). */
  source_shopify_sku: z.string().nullable().optional().default(null),
  /** Shopify product title at the moment of + Add (display-only). */
  source_title: z.string().nullable().optional().default(null),
});
export type CsCaseLine = z.infer<typeof CsCaseLineSchema>;

/**
 * One row per customer-service intervention. Replaces the Notion
 * "Replacements Database" with a relational, queryable, inventory-
 * connected version.
 *
 * Lines are stored in a separate table (CsCaseLineSchema) and join in
 * via case_id. The repo layer is responsible for fetching + assembling.
 */
export const CsCaseSchema = z.object({
  id: Id,
  created_at: IsoDateTime,
  /** auth.users.id of the user who logged the case (the "respondent"). */
  created_by_user_id: z.string().nullable().default(null),

  status: CsCaseStatusSchema.default("new"),
  urgency: CsCaseUrgencySchema.default("medium"),
  issue_type: CsCaseIssueTypeSchema,
  /** Nullable: app derives from lines; explicit override allowed for routing. */
  department: CsCaseDepartmentSchema.nullable().default(null),

  order_number: z.string().min(1),
  shopify_order_url: z.string().nullable().default(null),
  date_ordered: IsoDate.nullable().default(null),

  customer_name: z.string().nullable().default(null),
  customer_email: z.string().nullable().default(null),
  /** True = customer keeps the original item; we just send a replacement. */
  customer_keeps_original: z.boolean().default(true),

  /**
   * Carrier that delivered the *original* order to the customer. Optional ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
   * captured by CS for reporting (which carrier causes most issues?).
   * Independent of the replacement parcel carrier below.
   */
  original_carrier: z.string().nullable().default(null),
  /** Carrier for the *replacement* parcel we send out. Paired with tracking_number. */
  carrier: z.string().nullable().default(null),
  tracking_number: z.string().nullable().default(null),

  notes: z.string().default(""),
  /** Supabase Storage URLs. Auto-purged at 60 days by a scheduled job. */
  attachments: z.array(z.string()).default([]),

  /** Timestamp of when the case first moved to 'query' (waiting on info). */
  queried_at: IsoDateTime.nullable().default(null),
  shipped_at: IsoDateTime.nullable().default(null),
  closed_at: IsoDateTime.nullable().default(null),

  /** Idempotency flag ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â true once the lines have been deducted from inventory. */
  inventory_deducted: z.boolean().default(false),

  updated_at: IsoDateTime,
});
export type CsCase = z.infer<typeof CsCaseSchema>;

/** Convenience: a CsCase with its lines fetched, used by detail views. */
export interface CsCaseWithLines extends CsCase {
  lines: CsCaseLine[];
}


// ---------- CS Returns (customer returns ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â inbound) ----------

/**
 * Mirror of CsCase for the inbound flow: customer is sending an item BACK
 * to us. Workflow: new ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ received ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ closed.
 *
 *   new      ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â customer notified us, item hasn't arrived yet
 *   received ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â item is physically at our warehouse
 *   closed   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â process complete (refund issued / no-refund decided)
 *
 * v1 does NOT auto-adjust inventory when status moves to 'received' ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â
 * returned items often arrive damaged. Future iteration can add a per-line
 * "restock" toggle that credits inventory back conditionally.
 */
export const CsReturnStatusSchema = z.enum(["new", "received", "rts", "closed"]);
export type CsReturnStatus = z.infer<typeof CsReturnStatusSchema>;

export const CS_RETURN_STATUS_LABELS: Record<CsReturnStatus, string> = {
  new: "New",
  received: "Received",
  rts: "RTS",
  closed: "Closed",
};

export const CsReturnSchema = z.object({
  id: Id,
  created_at: IsoDateTime,
  /** auth.users.id of the user who logged the return. */
  created_by_user_id: z.string().nullable().default(null),

  status: CsReturnStatusSchema.default("new"),

  order_number: z.string().min(1),
  shopify_order_url: z.string().nullable().default(null),
  customer_name: z.string().nullable().default(null),
  customer_email: z.string().nullable().default(null),

  /** Date the customer told us they'd drop off / post back the item. */
  expected_return_date: IsoDate.nullable().default(null),
  /** True if a refund should be issued once the return is processed. */
  refund_expected: z.boolean().default(true),
  /** True if the refund has actually been issued to the customer. */
  refund_received: z.boolean().default(false),

  notes: z.string().default(""),

  /** Set automatically when status first transitions to 'received'. */
  received_at: IsoDateTime.nullable().default(null),
  /** Set automatically when status first transitions to 'closed'. */
  closed_at: IsoDateTime.nullable().default(null),

  updated_at: IsoDateTime,
});
export type CsReturn = z.infer<typeof CsReturnSchema>;

export const CsReturnLineSchema = z.object({
  id: Id,
  return_id: Id,
  product_id: Id,
  quantity: z.number().int().positive(),
  /**
   * When true, CS confirmed this returned item is resaleable. On the next
   * save where the parent return is 'received', the qty is credited back
   * to on-hand. Unticking reverses the credit. Defaults to false because
   * returned items often arrive damaged.
   */
  restock: z.boolean().default(false),
  /**
   * Idempotency flag: true once this line's qty has been credited to
   * on_hand via the ledger. Repeated saves use this to decide whether
   * to apply, reverse, or do nothing.
   */
  inventory_credited: z.boolean().default(false),
});
export type CsReturnLine = z.infer<typeof CsReturnLineSchema>;

/** Convenience: a CsReturn with its lines fetched, used by detail views. */
export interface CsReturnWithLines extends CsReturn {
  lines: CsReturnLine[];
}


// ---------- Production / Order Submission ----------

/**
 * Production departments. Each `/production` station is bound to exactly
 * one of these via localStorage and only sees orders/lines relevant to
 * its department. Per-line-item attribution for the three framing
 * departments; per-order for Dispatch (just a log scan, no verification).
 */
export const ProductionDepartmentSchema = z.enum([
  "a0_framed",
  "framed",
  "unframed",
  "dispatch",
]);
export type ProductionDepartment = z.infer<typeof ProductionDepartmentSchema>;

export const PRODUCTION_DEPARTMENT_LABELS: Record<ProductionDepartment, string> = {
  a0_framed: "A0 Framed",
  framed: "Framed",
  unframed: "Unframed",
  dispatch: "Dispatch",
};

/**
 * Lanyard barcode tokens issued to staff. The token itself is an opaque
 * short hex string (8 chars) so a lost lanyard doesn't leak the user's
 * name or email. Mapping lives server-side; the scanner just transmits
 * the token, the page looks up the staff identity.
 *
 * One user can have multiple barcodes (replacement issued after a loss,
 * for example) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â `active` distinguishes the current valid one. Old
 * barcodes stay in the table so historical events can still resolve
 * to the right person.
 */
export const StaffBarcodeSchema = z.object({
  barcode: z.string().min(4),
  user_id: z.string().min(1),
  display_name: z.string().min(1),
  active: z.boolean().default(true),
  created_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable().default(null),
});
export type StaffBarcode = z.infer<typeof StaffBarcodeSchema>;

/**
 * Per-staff hourly rate, used to compute the labour component of
 * cost-per-frame / cost-per-order. Stored separately from auth profile
 * so it can have its own permission model and audit history.
 *
 * One row per user. If a user has no rate set, labour cost is treated
 * as zero and the report flags it with a "ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â rate missing" badge.
 */
export const StaffRateSchema = z.object({
  user_id: z.string().min(1),
  /** Hourly rate in the location's currency. Stored as a number for
   *  arithmetic; the UI handles currency display. */
  hourly_rate: z.number().nonnegative(),
  updated_at: IsoDateTime,
  updated_by: z.string().nullable().default(null),
});
export type StaffRate = z.infer<typeof StaffRateSchema>;

/**
 * Append-only production event log. Every Start, Complete, Cancel, and
 * Dispatch action writes a row here. Time-deltas are derived from pairs
 * of Start+Complete events for the same staff + order + line. Dispatch
 * events have no line ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â they're per-order.
 *
 * `event_type` semantics:
 *   started   ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â worker tapped Start on a line
 *   completed ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â worker tapped Complete on a line
 *   cancelled ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â worker tapped Cancel (or supervisor override)
 *   dispatched ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â order was scanned at the Dispatch bench
 */
export const ProductionEventTypeSchema = z.enum([
  "started",
  "completed",
  "cancelled",
  "dispatched",
]);
export type ProductionEventType = z.infer<typeof ProductionEventTypeSchema>;

export const ProductionEventSchema = z.object({
  id: Id,
  /** Staff user_id from the auth profile. */
  staff_id: z.string().min(1),
  department: ProductionDepartmentSchema,
  /** Shopify order name, e.g. "#10186629" (with the # prefix kept for
   *  human readability). */
  order_number: z.string().min(1),
  /** SKU code of the line item this event applies to. Null for
   *  dispatch events (they're order-level, not line-level). */
  line_sku: z.string().nullable().default(null),
  /** Quantity of this SKU in the original order, captured at scan time
   *  so reports stay correct even if the Shopify order is later edited. */
  line_quantity: z.number().int().positive().nullable().default(null),
  event_type: ProductionEventTypeSchema,
  /** Optional free-form station identifier (e.g. "bench-3"). Useful when
   *  multiple stations share one department. Set by the page from a
   *  localStorage value if present. */
  station_id: z.string().nullable().default(null),
  /** Optional note attached to a Cancel event ("damaged, restart"). */
  note: z.string().default(""),
  created_at: IsoDateTime,
});
export type ProductionEvent = z.infer<typeof ProductionEventSchema>;

/**
 * Size-effort scores feed the size-weighted volume metric:
 *   volume = ÃƒÆ’Ã…Â½Ãƒâ€šÃ‚Â£ (count ÃƒÆ’Ã†â€™— effort_score) across sizes.
 *
 * Hand-seeded at first; recomputable from observed medians once each
 * size has enough completion events. Keyed by size string ("A0",
 * "A1", ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦) which matches Product.size.
 *
 * Default values (per the user's instinct, will refine with data):
 *   A0=2.5, A1=1.5, A2=1.0, A3=0.7, A4=0.5
 */
export const ProductionSizeEffortSchema = z.object({
  size: z.string().min(1),
  effort_score: z.number().positive(),
  /** ISO timestamp of last manual edit. Future auto-recompute path will
   *  also update this. */
  updated_at: IsoDateTime,
});
export type ProductionSizeEffort = z.infer<typeof ProductionSizeEffortSchema>;

/**
 * Estimated time (in minutes) per SKU + department. Used to show
 * estimated-vs-actual feedback to workers in real time. Seeded by an
 * admin form (Settings ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ Production Benchmarks); auto-updates as
 * rolling medians accrue once each combo has ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â°Ãƒâ€šÃ‚Â¥50 events.
 */
export const ProductionBenchmarkSchema = z.object({
  /**
   * Synthetic id = `${product_id}__${department}`. Single-key Dexie can't
   * use composite keys mid-life, so we encode the natural composite as
   * one string. Supabase uses the natural composite (product_id, department)
   * as its PK and ignores this field.
   */
  id: Id,
  product_id: Id,
  department: ProductionDepartmentSchema,
  estimated_minutes: z.number().positive(),
  /** Source: "admin" while hand-seeded; "rolling_median" once auto-derived. */
  source: z.enum(["admin", "rolling_median"]).default("admin"),
  sample_size: z.number().int().nonnegative().default(0),
  updated_at: IsoDateTime,
});
export type ProductionBenchmark = z.infer<typeof ProductionBenchmarkSchema>;


// ---------- Locations ----------

export const LOCATIONS = ["default", "uk", "us", "au"] as const;
export type LocationKey = (typeof LOCATIONS)[number];
export const LOCATION_LABELS: Record<LocationKey, string> = {
  default: "Default",
  uk: "United Kingdom",
  us: "United States",
  au: "Australia",
};

// ---------- Sidebar nav ----------

/** Keys for the sidebar nav items ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â used as labels' map keys. */
export const NAV_KEYS = [
  "welcome", "dashboard", "skus", "sales", "shipments", "events", "warehouse", "orders", "paper", "movements", "cs_cases", "cs_returns", "order_submission", "reports", "team", "settings",
] as const;
export type NavKey = (typeof NAV_KEYS)[number];

export const DEFAULT_NAV_LABELS: Record<NavKey, string> = {
  welcome: "Welcome",
  dashboard: "Dashboard",
  skus: "SKUs",
  sales: "Sales entry",
  shipments: "Shipments",
  events: "Demand events",
  warehouse: "Warehouse",
  orders: "Shopping list",
  paper: "Paper usage",
  movements: "Movements",
  cs_cases: "CS Cases",
  cs_returns: "Returns",
  order_submission: "Order Submission",
  reports: "Reports",
  team: "Team",
  settings: "Settings",
};

// ---------- Global settings ----------

export const GlobalSettingsSchema = z.object({
  use_live_date: z.boolean().default(true),
  manual_scenario_start_date: IsoDate.nullable().default(null),
  working_days_per_week: z.number().int().min(1).max(7).default(7),
  currency_symbol: z.string().default("$"),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  week_start_day: z.enum(["sunday", "monday"]).default("monday"),
  auto_adjust_inventory_on_sale: z.boolean().default(true),
  /**
   * When a shipment's status transitions to "Delivered", credit each line's
   * quantity to that product's `current_on_hand`. Transitioning away from
   * Delivered reverses the credit. Default ON ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â mirrors the sales auto-
   * deduct symmetry.
   */
  auto_apply_shipments_on_delivery: z.boolean().default(true),
  /** Custom labels for the sidebar nav. Missing keys fall back to defaults. */
  nav_labels: z.record(z.string()).default({}),
  /**
   * ISO timestamp of the most recent JSON backup the user downloaded. Used
   * by the dashboard to nag if it's been a while. Null = never backed up.
   */
  last_backup_at: IsoDateTime.nullable().default(null),
  /** How many days between backup nag banners. */
  backup_reminder_days: z.number().int().positive().default(7),
  /** Saved order line-ups for the supplier-order builder. */
  order_templates: z.array(OrderTemplateSchema).default([]),
  /**
   * Cubic-metre capacity of one shipping container, used by the order
   * builder's container-fill widget. 67 ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â°Ãƒâ€¹Ã¢â‚¬Â  40' high cube.
   */
  container_cbm: z.number().positive().default(67),
  /**
   * Product IDs of the SKUs that represent paper rolls in inventory. When
   * set, saving a Paper-usage snapshot atomically deducts the computed roll
   * count from these SKUs' on-hand stock (rounded up ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â once a roll is
   * opened it's counted as consumed). Null = no deduction.
   */
  paper_roll_24_sku_id: z.string().nullable().default(null),
  paper_roll_42_sku_id: z.string().nullable().default(null),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export function navLabel(key: NavKey, settings: GlobalSettings | undefined): string {
  return (settings?.nav_labels?.[key] || "").trim() || DEFAULT_NAV_LABELS[key];
}

// ---------- Backup ----------

export const BackupSchema = z.object({
  version: z.literal(1),
  exported_at: IsoDateTime,
  products: z.array(ProductSchema),
  weekly_sales: z.array(WeeklySalesSchema),
  weekly_entries: z.array(WeeklyEntrySchema).default([]),
  incoming_shipments: z.array(IncomingShipmentSchema),
  demand_events: z.array(DemandChangeEventSchema),
  storage: StorageLayoutSchema,
  settings: GlobalSettingsSchema,
  // Optional for backward compat with older backups that pre-date the
  // Paper usage history. Default to [] so existing JSON files still parse.
  paper_usage: z.array(PaperUsageEntrySchema).default([]),
  // Inventory ledger ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â append-only audit of every stock movement. Phase 1
  // backups include this so a future restore preserves the audit trail.
  // Older JSON exports without this field still parse cleanly.
  ledger: z.array(LedgerEntrySchema).default([]),
});
export type Backup = z.infer<typeof BackupSchema>;

/**
 * Owner-only invoice + payment tracking row attached 1:1 to a shipment.
 * Lives in the separate `shipment_accounts` Supabase table for strict
 * owner-only RLS (Postgres RLS is row-level, not column-level).
 */
export const PaymentStatusValues = [
  "unpaid",
  "paid",
  "on_hold",
  "pending_approval",
  "disputed",
] as const;
export type PaymentStatus = (typeof PaymentStatusValues)[number];

export const ShipmentAccountsSchema = z.object({
  location: z.string(),
  shipment_id: z.string(),
  supplier_invoice_number: z.string().nullable().default(null),
  invoice_amount: z.number().nullable().default(null),
  invoice_currency: z.string().default("AUD"),
  invoice_received_date: z.string().nullable().default(null),
  payment_status: z.enum(PaymentStatusValues).default("unpaid"),
  payment_date: z.string().nullable().default(null),
  payment_reference: z.string().nullable().default(null),
  accounts_notes: z.string().nullable().default(null),
  payment_terms_days: z.number().int().nullable().default(null),
  payment_terms_eom: z.boolean().default(false),
});
export type ShipmentAccounts = z.infer<typeof ShipmentAccountsSchema>;

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  on_hold: "On hold",
  pending_approval: "Pending approval",
  disputed: "Disputed",
};

/**
 * Standard payment-term presets shown in dropdowns. `Custom` is handled
 * separately in the UI (any non-negative integer is valid).
 */
/**
 * Built-in payment-term presets. Each has a unique `key` used by the
 * dropdown, plus the underlying `days` + `eom` flag used by the due-date
 * calculation.
 *
 * Keep the order stable - the supplier card matches saved (days, eom)
 * back to a key by linear scan and shows the first match.
 */
export const STANDARD_PAYMENT_TERMS = [
  { key: "prepaid",  value: 0,  eom: false, label: "Prepaid" },
  { key: "net7",     value: 7,  eom: false, label: "NET7" },
  { key: "net14",    value: 14, eom: false, label: "NET14" },
  { key: "net30",    value: 30, eom: false, label: "NET30" },
  { key: "net60",    value: 60, eom: false, label: "NET60" },
  { key: "net90",    value: 90, eom: false, label: "NET90" },
  { key: "net30eom", value: 30, eom: true,  label: "NET30 EOM" },
  { key: "net60eom", value: 60, eom: true,  label: "NET60 EOM" },
] as const;

export const SupplierSettingsSchema = z.object({
  location: z.string(),
  supplier_name: z.string(),
  payment_terms_days: z.number().int().nullable().default(null),
  payment_terms_eom: z.boolean().default(false),
  default_currency: z.string().default("AUD"),
  notes: z.string().nullable().default(null),
});
export type SupplierSettings = z.infer<typeof SupplierSettingsSchema>;

/** "COD" / "NET30" / "â€”" for null. Anything non-standard renders as `NET{n}`. */
export function formatTermsLabel(days: number | null | undefined, eom: boolean = false): string {
  if (days == null) return "--";
  if (days === 0) return "Prepaid";
  return "NET" + days + (eom ? " EOM" : "");
}

/**
 * Compute the invoice due date for a shipment from its order_placed_date
 * + an effective payment-terms-days value. Returns YYYY-MM-DD (local).
 * Returns null if either input is missing.
 */
export function computeDueDate(
  orderPlacedDate: string | null | undefined,
  termsDays: number | null | undefined,
  eom: boolean = false,
): string | null {
  if (!orderPlacedDate || termsDays == null) return null;
  const d = new Date(orderPlacedDate + "T00:00:00");
  if (eom) {
    // Snap to last day of order_placed_date's month, then add days.
    d.setMonth(d.getMonth() + 1, 0);
  }
  d.setDate(d.getDate() + termsDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

/**
 * True if the due date has passed AND the payment status isn''t a
 * terminal-positive state (paid / on_hold).
 */
export function isShipmentOverdue(
  dueDate: string | null,
  paymentStatus: string | null | undefined,
): boolean {
  if (!dueDate) return false;
  if (paymentStatus === "paid" || paymentStatus === "on_hold") return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate + "T00:00:00") < today;
}

export const ShipmentInvoiceFileSchema = z.object({
  id: z.string(),
  location: z.string(),
  shipment_id: z.string(),
  file_path: z.string(),
  original_name: z.string(),
  mime_type: z.string().nullable().default(null),
  file_size: z.number().int().nullable().default(null),
  uploaded_at: z.string(),
  uploaded_by: z.string().nullable().default(null),
});
export type ShipmentInvoiceFile = z.infer<typeof ShipmentInvoiceFileSchema>;

export const ALLOWED_INVOICE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;
export const MAX_INVOICE_FILE_SIZE_BYTES = 10 * 1024 * 1024;
