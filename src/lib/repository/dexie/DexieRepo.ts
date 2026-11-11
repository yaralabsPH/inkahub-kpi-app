import { getDb, salesRowId, type StockDB } from "./db";
import type { Repository } from "../Repository";
import {
  GlobalSettingsSchema,
  type Backup,
  type Bay,
  type DemandChangeEvent,
  type GlobalSettings,
  type IncomingShipment,
  type PalletAssignment,
  type Product,
  type StorageLayout,
  type WeeklyEntry,
  type WeeklySales,
  type PaperUsageEntry,
  type LedgerEntry,
  type LedgerReason,
  type ProductComponent,
  type CsCase,
  type CsCaseLine,
  type CsCaseWithLines,
  type CsReturn,
  type CsReturnLine,
  type CsReturnWithLines,
} from "@/lib/domain";

/**
 * Sortable ledger ID: unix-ms prefix + 6-char random suffix. Reads back in
 * insertion order via `orderBy("id")` because Dexie sorts strings
 * lexicographically and the unix-ms prefix is monotonically increasing.
 * Random suffix prevents collisions when multiple rows are inserted in
 * the same millisecond (rare but possible during a BOM cascade).
 */
function nextLedgerId(): string {
  const ms = Date.now().toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${ms}-${rand}`;
}

const SETTINGS_KEY = "global" as const;
const DEFAULT_SETTINGS: GlobalSettings = GlobalSettingsSchema.parse({});

export class DexieRepo implements Repository {
  private db: StockDB;
  constructor(db: StockDB = getDb()) {
    this.db = db;
  }

  // -------- products --------
  async listProducts(): Promise<Product[]> {
    return this.db.products.orderBy("code").toArray();
  }
  async getProduct(id: string): Promise<Product | undefined> {
    return this.db.products.get(id);
  }
  async upsertProduct(p: Product): Promise<void> {
    // Cycle check on the BOM graph BEFORE opening a write transaction.
    // Walks the proposed components, then recursively the existing
    // components of each descendant, and aborts if any path reaches back
    // to `p.id`. Pure read, safe to run outside a write tx.
    if (Array.isArray(p.components) && p.components.length > 0) {
      const cyclePath = await this.findBomCycle(p.id, p.components);
      if (cyclePath) {
        throw new Error(
          `Component recipe forms a cycle: ${cyclePath}. A SKU can't appear in its own bill-of-materials, directly or indirectly.`,
        );
      }
    }

    // Detect on-hand drift so the ledger records every manual edit. Done
    // inside a transaction so the product update and the ledger row land
    // atomically — partial failure can't leave them out of sync.
    await this.db.transaction("rw", [this.db.products, this.db.ledger], async () => {
      const prev = await this.db.products.get(p.id);
      const prevOnHand = prev?.current_on_hand ?? 0;
      const newOnHand = p.current_on_hand ?? 0;
      const delta = newOnHand - prevOnHand;
      if (delta !== 0) {
        const reason: LedgerReason = prev ? "manual" : "initial";
        await this.appendLedger({
          product_id: p.id,
          delta,
          reason,
          source_id: `product-edit:${p.id}:${Date.now()}`,
          note: prev ? "On-hand edited via SKU form or bulk edit" : "Initial seed",
        });
      }
      await this.db.products.put(p);
    });
  }

  /**
   * Walks the BOM graph from each direct component and returns the cycle
   * path (as a string like "A → B → A") if any descendant points back at
   * `rootId`. Returns null when the graph is acyclic. Uses an iterative
   * DFS with a depth cap so even pathological data can't hang the page.
   */
  private async findBomCycle(
    rootId: string,
    proposedComponents: ProductComponent[],
    maxDepth = 10,
  ): Promise<string | null> {
    const rootCode = (await this.db.products.get(rootId))?.code ?? rootId;
    for (const direct of proposedComponents) {
      // Each direct edge starts its own DFS so the ancestor path is
      // accurate for the cycle error message.
      const stack: { id: string; depth: number; ancestorCodes: string[] }[] = [
        { id: direct.child_product_id, depth: 0, ancestorCodes: [rootCode] },
      ];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const { id, depth, ancestorCodes } = stack.pop()!;
        if (id === rootId) {
          return [...ancestorCodes, rootCode].join(" → ");
        }
        if (visited.has(id) || depth > maxDepth) continue;
        visited.add(id);
        // eslint-disable-next-line no-await-in-loop
        const node = await this.db.products.get(id);
        if (!node || !Array.isArray(node.components)) continue;
        for (const c of node.components) {
          stack.push({
            id: c.child_product_id,
            depth: depth + 1,
            ancestorCodes: [...ancestorCodes, node.code],
          });
        }
      }
    }
    return null;
  }
  /**
   * Subtract `delta` from the product's `current_on_hand` inside a single
   * Dexie transaction. Two concurrent calls can't lose updates because the
   * read+write happens atomically; the snapshot a caller had is irrelevant.
   *
   * The call sites currently feed in different conceptual reasons (sales
   * deduction, paper-roll consumption, Shopify import) but all flow through
   * this generic method. Phase 1 logs everything as `manual` — Phase 2
   * will extend the API so call sites can pass richer reason / source_id
   * context, but for now the cell-edit / ad-hoc adjust path always lands
   * here as "manual".
   */
  async adjustOnHand(
    productId: string,
    delta: number,
    context?: { reason: LedgerReason; source_id?: string | null; note?: string; parent_event_id?: string | null },
  ): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) return;
    await this.db.transaction("rw", [this.db.products, this.db.ledger], async () => {
      const p = await this.db.products.get(productId);
      if (!p) return;
      const before = p.current_on_hand ?? 0;
      const next = Math.max(before - delta, 0);
      if (next === before) {
        // No actual change to parent on-hand. Skip cascade too — most
        // commonly happens when the floor-at-zero clamp swallows a
        // negative-or-zero result.
        return;
      }
      await this.db.products.put({ ...p, current_on_hand: next });
      // adjustOnHand semantics: positive `delta` decrements on-hand. The
      // ledger uses natural signed convention (negative = outbound) and
      // captures the *actual* on-hand change so the floor-at-zero clamp
      // is reflected accurately.
      await this.appendLedger({
        product_id: productId,
        delta: next - before,
        reason: context?.reason ?? "manual",
        source_id: context?.source_id ?? null,
        parent_event_id: context?.parent_event_id ?? null,
        note: context?.note ?? "adjustOnHand",
      });

      // ---------- BOM cascade ----------
      // Only sales cascade (and their reversal). Shipment credits land on
      // the finished SKU directly — they don't unmake the components.
      // Stocktakes / manual adjusts are local to the SKU being edited.
      // Transfers move whole units, not their inputs.
      if (
        context?.reason === "sale"
        && Array.isArray(p.components)
        && p.components.length > 0
      ) {
        // Cascade multiplier == delta (positive = deduction, negative =
        // reversal credits back to components). Use the parent's source_id
        // as the cascade root so every descendant row links to it via
        // `parent_event_id`.
        const cascadeRoot = context.source_id ?? `cascade:${productId}:${Date.now()}`;
        await this.cascadeBomDeduction(
          p.components,
          delta,
          0,
          cascadeRoot,
          p.code,
        );
      }
    });
  }

  /**
   * Recursive BOM cascade. For each component, multiplies the parent's
   * delta by `qty_per_unit` and applies the same deduct-or-credit to the
   * child SKU's on-hand. Then walks into the child's own components.
   * Hard depth cap of 8 levels — well beyond any realistic recipe, but
   * makes accidental cycles (despite the upsert guard) impossible to hang
   * the transaction on.
   */
  private async cascadeBomDeduction(
    components: ProductComponent[],
    parentDelta: number,
    depth: number,
    parentEventId: string,
    parentCode: string,
  ): Promise<void> {
    if (depth >= 8) return;
    for (const comp of components) {
      const childDelta = parentDelta * comp.qty_per_unit;
      if (childDelta === 0 || !Number.isFinite(childDelta)) continue;
      // eslint-disable-next-line no-await-in-loop
      const child = await this.db.products.get(comp.child_product_id);
      if (!child) continue;
      const before = child.current_on_hand ?? 0;
      const next = Math.max(before - childDelta, 0);
      if (next === before) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.db.products.put({ ...child, current_on_hand: next });
      // eslint-disable-next-line no-await-in-loop
      await this.appendLedger({
        product_id: child.id,
        delta: next - before,
        reason: "bom",
        source_id: `${parentEventId}:bom:${child.code}`,
        parent_event_id: parentEventId,
        note: `BOM cascade from ${parentCode} (×${comp.qty_per_unit})`,
      });
      // Recurse into this child's components so multi-level recipes
      // (frame → print → roll) all deduct in one transaction.
      if (Array.isArray(child.components) && child.components.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await this.cascadeBomDeduction(
          child.components,
          childDelta,
          depth + 1,
          parentEventId,
          child.code,
        );
      }
    }
  }
  async deleteProduct(id: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.products, this.db.weeklySales, this.db.shipments],
      async () => {
        await this.db.products.delete(id);
        await this.db.weeklySales.where("product_id").equals(id).delete();
        // Multi-line shipments: there is no longer a `product_id` index on the
        // shipments table (dropped in v3). Scan every shipment, drop any line
        // that points at this SKU, and delete shipments that empty out.
        const shipments = await this.db.shipments.toArray();
        for (const s of shipments) {
          const lines = Array.isArray(s.lines) ? s.lines : [];
          const filtered = lines.filter((l) => l.product_id !== id);
          const legacyHit = s.product_id === id;
          if (!legacyHit && filtered.length === lines.length) continue;
          if (filtered.length === 0) {
            await this.db.shipments.delete(s.id);
          } else {
            const updated = { ...s, lines: filtered };
            // Strip the legacy single-line fields if they pointed at this SKU.
            if (legacyHit) {
              delete (updated as Partial<IncomingShipment>).product_id;
              delete (updated as Partial<IncomingShipment>).quantity;
            }
            await this.db.shipments.put(updated);
          }
        }
        // Sweep any other product whose recipe references this SKU. Leaves
        // a dangling component reference is messier than just dropping the
        // line — the parent SKU loses one input from its recipe but the
        // user can re-add it (or map a replacement) on the SKU detail.
        const allProducts = await this.db.products.toArray();
        for (const p of allProducts) {
          if (!Array.isArray(p.components) || p.components.length === 0) continue;
          const filteredComps = p.components.filter((c) => c.child_product_id !== id);
          if (filteredComps.length !== p.components.length) {
            await this.db.products.put({ ...p, components: filteredComps });
          }
        }
      },
    );
  }

  // -------- weekly sales --------
  async listSales(productId?: string): Promise<WeeklySales[]> {
    const rows = productId
      ? await this.db.weeklySales.where("product_id").equals(productId).toArray()
      : await this.db.weeklySales.toArray();
    return rows.map(({ id: _id, ...s }) => s as WeeklySales);
  }
  async upsertSale(s: WeeklySales): Promise<void> {
    await this.db.weeklySales.put({ ...s, id: salesRowId(s.product_id, s.iso_week_start) });
  }
  async bulkUpsertSales(rows: WeeklySales[]): Promise<void> {
    await this.db.weeklySales.bulkPut(
      rows.map((s) => ({ ...s, id: salesRowId(s.product_id, s.iso_week_start) })),
    );
  }
  /**
   * Delete a single sales row, atomically crediting its `units_sold` back
   * to the product's on-hand (and cascading through any BOM components
   * the parent had at the time of the original sale). Gated by
   * `auto_adjust_inventory_on_sale` — if that toggle is off, neither
   * the original deduction nor this reversal happens, so we just drop
   * the row.
   *
   * Symmetric with `deleteWeeklyEntry`: any sales-removal path at the
   * repo layer reverses its own inventory effect. The UI never has to
   * remember to do it.
   */
  async deleteSale(productId: string, isoWeekStart: string): Promise<void> {
    const settings = await this.getSettings();
    const autoAdjust = settings.auto_adjust_inventory_on_sale ?? true;
    await this.db.transaction(
      "rw",
      [this.db.weeklySales, this.db.products, this.db.ledger],
      async () => {
        const rowId = salesRowId(productId, isoWeekStart);
        const row = await this.db.weeklySales.get(rowId);
        if (row && autoAdjust && row.units_sold > 0) {
          // Negative delta = credit back. Reason "sale" triggers BOM
          // cascade so any component deductions from the original sale
          // are also reversed.
          await this.adjustOnHand(productId, -row.units_sold, {
            reason: "sale",
            source_id: `sale:${productId}:${isoWeekStart}:delete`,
            note: "Sale row deleted — credit returned",
          });
        }
        await this.db.weeklySales.delete(rowId);
      },
    );
  }

  // -------- weekly entries --------
  // The unframed Dexie table is left dormant after the framed/unframed
  // distinction was removed. listWeeklyEntries reads only the canonical
  // table; nothing writes to weeklyEntriesUnframed any more.
  async listWeeklyEntries(): Promise<WeeklyEntry[]> {
    // Merge rows from BOTH physical tables and tag each with its department.
    // Legacy rows in weeklyEntries that lack the field default to 'framed'.
    const [framed, unframed] = await Promise.all([
      this.db.weeklyEntries.toArray(),
      this.db.weeklyEntriesUnframed.toArray(),
    ]);
    const tagged = [
      ...framed.map((e) => ({ ...e, department: e.department ?? "framed" })),
      ...unframed.map((e) => ({ ...e, department: e.department ?? "unframed" })),
    ];
    return tagged.sort((a, b) => a.iso_week_start.localeCompare(b.iso_week_start));
  }
  async upsertWeeklyEntry(e: WeeklyEntry): Promise<void> {
    // Strip any legacy `kind` field that may still be on imported data.
    const { kind: _kind, ...rest } = e as WeeklyEntry & { kind?: string };
    void _kind;
    const withDept: WeeklyEntry = {
      ...(rest as WeeklyEntry),
      department: (rest as WeeklyEntry).department ?? "framed",
    };
    // Route the row to the table that matches its department. PK is
    // iso_week_start in both tables, so a single-string key works.
    const table = this.tableFor(withDept.department);
    await table.put(withDept);
  }

  /** Pick the Dexie table that holds rows for the given department. */
  private tableFor(department: "framed" | "unframed") {
    return department === "unframed"
      ? this.db.weeklyEntriesUnframed
      : this.db.weeklyEntries;
  }

  /**
   * Bulk-delete weekly entries + their sales rows. Two paths based on the
   * `auto_adjust_inventory_on_sale` setting:
   *
   *   auto-adjust OFF
   *     Fast path. Single Dexie transaction. Drop entries + sales in
   *     batch. on_hand is not touched (matches the setting's intent).
   *
   *   auto-adjust ON
   *     Optimised cascade. Aggregate per-product credits across every
   *     deleted sale row, then call adjustOnHand once per product (which
   *     handles BOM cascade + ledger entry). 1 + N(unique products)
   *     operations instead of N(sale rows). Way faster than calling
   *     deleteSale per row, while still leaving on_hand accurate.
   */
  async bulkDeleteWeeklyEntries(
    weeks: Array<{ iso_week_start: string; department: "framed" | "unframed" }>,
  ): Promise<{ entries: number; sales: number }> {
    if (weeks.length === 0) return { entries: 0, sales: 0 };
    const settings = await this.getSettings();
    const autoAdjust = settings.auto_adjust_inventory_on_sale ?? true;

    const framedIsos = weeks
      .filter((w) => w.department === "framed")
      .map((w) => w.iso_week_start);
    const unframedIsos = weeks
      .filter((w) => w.department === "unframed")
      .map((w) => w.iso_week_start);
    const allIsos = Array.from(new Set<string>([...framedIsos, ...unframedIsos]));

    // Path A — auto-adjust OFF: skip the cascade, just drop rows.
    if (!autoAdjust) {
      let salesDeleted = 0;
      let entriesDeleted = 0;
      await this.db.transaction(
        "rw",
        [
          this.db.weeklyEntries,
          this.db.weeklyEntriesUnframed,
          this.db.weeklySales,
        ],
        async () => {
          if (framedIsos.length > 0) {
            await this.db.weeklyEntries.bulkDelete(framedIsos);
            entriesDeleted += framedIsos.length;
          }
          if (unframedIsos.length > 0) {
            await this.db.weeklyEntriesUnframed.bulkDelete(unframedIsos);
            entriesDeleted += unframedIsos.length;
          }
          if (allIsos.length > 0) {
            salesDeleted = await this.db.weeklySales
              .where("iso_week_start").anyOf(allIsos).delete();
          }
        },
      );
      return { entries: entriesDeleted, sales: salesDeleted };
    }

    // Path B — auto-adjust ON: aggregate credits per product, then drop.
    // 1) Read all matching sale rows once (no per-row transaction).
    const salesRows = allIsos.length === 0
      ? []
      : await this.db.weeklySales.where("iso_week_start").anyOf(allIsos).toArray();
    // 2) Sum units_sold per product across every deleted sale row.
    const creditByProduct = new Map<string, number>();
    for (const s of salesRows) {
      if (s.units_sold <= 0) continue;
      creditByProduct.set(s.product_id, (creditByProduct.get(s.product_id) ?? 0) + s.units_sold);
    }
    // 3) Apply one credit-back per unique product. adjustOnHand handles
    //    the BOM cascade + ledger write itself, so we get correct
    //    component crediting without iterating per-sale.
    for (const [productId, units] of creditByProduct) {
      if (units === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.adjustOnHand(productId, -units, {
        reason: "sale",
        source_id: `bulk-delete:${productId}:${allIsos[0] ?? "unknown"}`,
        note: `Bulk delete of ${weeks.length} week${weeks.length === 1 ? "" : "s"} — sales credit returned`,
      });
    }
    // 4) Drop entries + sales in a single transaction.
    let salesDeleted = 0;
    let entriesDeleted = 0;
    await this.db.transaction(
      "rw",
      [
        this.db.weeklyEntries,
        this.db.weeklyEntriesUnframed,
        this.db.weeklySales,
      ],
      async () => {
        if (framedIsos.length > 0) {
          await this.db.weeklyEntries.bulkDelete(framedIsos);
          entriesDeleted += framedIsos.length;
        }
        if (unframedIsos.length > 0) {
          await this.db.weeklyEntriesUnframed.bulkDelete(unframedIsos);
          entriesDeleted += unframedIsos.length;
        }
        if (allIsos.length > 0) {
          salesDeleted = await this.db.weeklySales
            .where("iso_week_start").anyOf(allIsos).delete();
        }
      },
    );
    return { entries: entriesDeleted, sales: salesDeleted };
  }
  /**
   * Delete a weekly entry and every sales row attached to that week. Each
   * sales row's `units_sold` is credited back to the matching product's
   * on-hand (with full BOM cascade) before the rows are removed — so
   * deleting a whole week's worth of sales correctly returns inventory
   * to where it was, including any component SKUs that were cascaded
   * during the original sale. Respects `auto_adjust_inventory_on_sale`
   * — if that setting is off, neither the deduction nor the credit
   * happens, and we just drop the rows.
   *
   * All four operations (settings read, sales scan, per-row reverse +
   * cascade via adjustOnHand, entry+sales delete) run inside one Dexie
   * transaction. The inner `adjustOnHand` calls auto-join because Dexie
   * transactions are zone-scoped.
   */
  /**
   * Delete a weekly entry and every sales row attached to it. Each sales
   * deletion goes through `deleteSale`, which credits back inventory and
   * cascades BOM components when `auto_adjust_inventory_on_sale` is on.
   * Single code path keeps the two delete methods behaving identically
   * with respect to inventory.
   */
  async deleteWeeklyEntry(
    isoWeekStart: string,
    department: "framed" | "unframed",
  ): Promise<void> {
    const table = this.tableFor(department);
    await this.db.transaction(
      "rw",
      [
        this.db.weeklyEntries,
        this.db.weeklyEntriesUnframed,
        this.db.weeklySales,
        this.db.products,
        this.db.ledger,
      ],
      async () => {
        // Per-SKU sales rows are unfiltered by department (a sale's
        // department is implied by its product's supplier). Scope the
        // cascade by joining via the product list so the other
        // department's sales for the same week aren't touched.
        const sales = await this.db.weeklySales
          .where("iso_week_start").equals(isoWeekStart).toArray();
        const products = await this.db.products.toArray();
        const productDept = new Map(products.map(
          (p) => [p.id, ((p.supplier ?? "").trim().toUpperCase() === "UNFRAMED" ? "unframed" : "framed") as "framed" | "unframed"],
        ));
        for (const s of sales) {
          if (productDept.get(s.product_id) !== department) continue;
          // eslint-disable-next-line no-await-in-loop
          await this.deleteSale(s.product_id, s.iso_week_start);
        }
        await table.delete(isoWeekStart);
      },
    );
  }
  async renameWeeklyEntry(
    oldIso: string,
    newIso: string,
    department: "framed" | "unframed",
  ): Promise<void> {
    if (oldIso === newIso) return;
    const table = this.tableFor(department);
    await this.db.transaction(
      "rw",
      [this.db.weeklyEntries, this.db.weeklyEntriesUnframed, this.db.weeklySales],
      async () => {
        const collision = await table.get(newIso);
        if (collision) {
          throw new Error(
            `A ${department} row already exists for ${newIso}. Pick a different date or delete that row first.`,
          );
        }
        const entry = await table.get(oldIso);
        if (!entry) throw new Error(`No ${department} entry found for ${oldIso}`);
        const sales = await this.db.weeklySales
          .where("iso_week_start").equals(oldIso).toArray();
        const products = await this.db.products.toArray();
        const productDept = new Map(products.map(
          (p) => [p.id, ((p.supplier ?? "").trim().toUpperCase() === "UNFRAMED" ? "unframed" : "framed") as "framed" | "unframed"],
        ));
        await table.delete(oldIso);
        await table.put({ ...entry, iso_week_start: newIso, department });
        for (const s of sales) {
          if (productDept.get(s.product_id) !== department) continue;
          await this.db.weeklySales.delete(s.id);
          await this.db.weeklySales.put({
            ...s,
            iso_week_start: newIso,
            id: salesRowId(s.product_id, newIso),
          });
        }
      },
    );
  }

  // -------- shipments --------
  async listShipments(productId?: string): Promise<IncomingShipment[]> {
    // Shipments are multi-line in v3+, so we can't use a Dexie index. When a
    // product filter is requested, fetch all and filter in JS — fast enough
    // for the dataset sizes this app is built for.
    const all = await this.db.shipments.toArray();
    // Backfill any pre-v3 records that were stored without a `lines` array so
    // downstream code can rely on `s.lines` always being iterable.
    for (const s of all) {
      if (!Array.isArray(s.lines)) {
        s.lines = s.product_id && s.quantity
          ? [{ product_id: s.product_id, quantity: s.quantity }]
          : [];
      }
    }
    if (!productId) return all;
    return all.filter(
      (s) => s.product_id === productId || s.lines.some((l) => l.product_id === productId),
    );
  }
  /**
   * Upsert a shipment with atomic inventory credit/reverse on status
   * transitions to/from "Delivered". All reads, the on-hand adjustments,
   * and the shipment put run inside a single Dexie rw transaction so a
   * partial failure can't desync inventory from the shipment record.
   *
   * Idempotency: the `inventory_applied_at` field tracks whether the
   * credit has fired. Transitions are detected by comparing
   * (previous inventory_applied_at, new status):
   *
   *   not-applied + new=Delivered  → APPLY credit, stamp applied_at
   *   applied     + newâ‰ Delivered  → REVERSE using PREV lines, clear it
   *   any other combination        → just save, no inventory change
   *
   * The reversal uses the PREVIOUS lines, not the new ones — editing
   * line qty on a Delivered shipment will leave inventory stale; the
   * intentional fix is to bounce the status out and back. We don't
   * compute line-by-line diffs.
   */
  async upsertShipment(s: IncomingShipment): Promise<void> {
    const settings = await this.getSettings();
    const autoApply = settings.auto_apply_shipments_on_delivery ?? true;

    await this.db.transaction("rw", [this.db.products, this.db.shipments, this.db.ledger], async () => {
      const prev = await this.db.shipments.get(s.id);
      const newLines = Array.isArray(s.lines) ? s.lines : [];
      const prevLines = Array.isArray(prev?.lines) ? prev!.lines : [];
      const prevApplied = prev?.inventory_applied_at ?? null;
      const isDelivered = s.status === "Delivered";

      const next: IncomingShipment = { ...s };

      if (autoApply) {
        if (isDelivered && !prevApplied) {
          // APPLY — credit each line qty to product on-hand + ledger row.
          for (const line of newLines) {
            const p = await this.db.products.get(line.product_id);
            if (!p) continue;
            const beforeQty = p.current_on_hand ?? 0;
            const afterQty = beforeQty + line.quantity;
            await this.db.products.put({ ...p, current_on_hand: afterQty });
            await this.appendLedger({
              product_id: line.product_id,
              delta: line.quantity,
              reason: "shipment",
              source_id: `shipment:${s.id}:${line.product_id}`,
              parent_event_id: `shipment:${s.id}`,
              note: `Delivered: ${s.po_number}`,
            });
          }
          next.inventory_applied_at = new Date().toISOString();
        } else if (!isDelivered && prevApplied) {
          // REVERSE — debit using prev lines so the same qty that was
          // credited is taken back. Floor at zero defensively.
          for (const line of prevLines) {
            const p = await this.db.products.get(line.product_id);
            if (!p) continue;
            const beforeQty = p.current_on_hand ?? 0;
            const afterQty = Math.max(beforeQty - line.quantity, 0);
            const actualDelta = afterQty - beforeQty; // negative or zero
            await this.db.products.put({ ...p, current_on_hand: afterQty });
            await this.appendLedger({
              product_id: line.product_id,
              delta: actualDelta,
              reason: "shipment",
              source_id: `shipment:${s.id}:${line.product_id}:reverse`,
              parent_event_id: `shipment:${s.id}`,
              note: `Reverse of Delivered: ${prev?.po_number ?? s.po_number}`,
            });
          }
          next.inventory_applied_at = null;
        }
      }

      await this.db.shipments.put(next);
    });
  }
  /**
   * Delete a shipment. If the shipment had previously credited its lines
   * to inventory (status Delivered with inventory_applied_at set), debit
   * those same line qtys back before removing the row — otherwise the
   * on-hand stays artificially inflated by stock that no longer has a
   * tracked source.
   */
  async deleteShipment(id: string): Promise<void> {
    await this.db.transaction("rw", [this.db.products, this.db.shipments, this.db.ledger], async () => {
      const prev = await this.db.shipments.get(id);
      if (prev?.inventory_applied_at && Array.isArray(prev.lines)) {
        for (const line of prev.lines) {
          const p = await this.db.products.get(line.product_id);
          if (!p) continue;
          const beforeQty = p.current_on_hand ?? 0;
          const afterQty = Math.max(beforeQty - line.quantity, 0);
          const actualDelta = afterQty - beforeQty;
          await this.db.products.put({ ...p, current_on_hand: afterQty });
          if (actualDelta !== 0) {
            await this.appendLedger({
              product_id: line.product_id,
              delta: actualDelta,
              reason: "shipment",
              source_id: `shipment:${id}:${line.product_id}:delete`,
              parent_event_id: `shipment:${id}`,
              note: `Shipment ${prev.po_number} deleted — credit reversed`,
            });
          }
        }
      }
      await this.db.shipments.delete(id);
    });
  }

  // -------- demand events --------
  async listDemandEvents(): Promise<DemandChangeEvent[]> {
    return this.db.demandEvents.toArray();
  }
  async upsertDemandEvent(e: DemandChangeEvent): Promise<void> {
    await this.db.demandEvents.put(e);
  }
  async deleteDemandEvent(id: string): Promise<void> {
    await this.db.demandEvents.delete(id);
  }

  // -------- storage layout --------
  async getStorage(): Promise<StorageLayout> {
    const [bays, palletAssignments] = await Promise.all([
      this.db.bays.orderBy("row").toArray(),
      this.db.palletAssignments.toArray(),
    ]);
    return { bays, palletAssignments };
  }
  async setStorage(s: StorageLayout): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.bays, this.db.palletAssignments],
      async () => {
        await this.db.bays.clear();
        await this.db.palletAssignments.clear();
        if (s.bays.length) await this.db.bays.bulkPut(s.bays as Bay[]);
        if (s.palletAssignments.length)
          await this.db.palletAssignments.bulkPut(s.palletAssignments as PalletAssignment[]);
      },
    );
  }

  // -------- settings --------
  async getSettings(): Promise<GlobalSettings> {
    const row = await this.db.settings.get(SETTINGS_KEY);
    if (!row) {
      const seeded = { ...DEFAULT_SETTINGS, id: SETTINGS_KEY } as const;
      await this.db.settings.put(seeded);
      return DEFAULT_SETTINGS;
    }
    const { id: _id, ...rest } = row;
    return rest as GlobalSettings;
  }
  async setSettings(s: GlobalSettings): Promise<void> {
    await this.db.settings.put({ ...s, id: SETTINGS_KEY });
  }

  // -------- backup --------
  async exportBackup(): Promise<Backup> {
    const [
      products,
      weekly_sales,
      weekly_entries,
      incoming_shipments,
      demand_events,
      storage,
      settings,
      paper_usage,
      ledger,
    ] = await Promise.all([
      this.listProducts(),
      this.listSales(),
      this.listWeeklyEntries(),
      this.listShipments(),
      this.listDemandEvents(),
      this.getStorage(),
      this.getSettings(),
      this.listPaperUsage(),
      this.listLedger(),
    ]);
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      products,
      weekly_sales,
      weekly_entries,
      incoming_shipments,
      demand_events,
      storage,
      settings,
      paper_usage,
      ledger,
    };
  }

  async importBackup(b: Backup): Promise<void> {
    await this.wipe();
    await this.db.transaction("rw", this.db.tables, async () => {
      if (b.products.length) await this.db.products.bulkPut(b.products);
      if (b.weekly_sales.length) await this.bulkUpsertSales(b.weekly_sales);
      if (b.weekly_entries.length) await this.db.weeklyEntries.bulkPut(b.weekly_entries);
      if (b.incoming_shipments.length) await this.db.shipments.bulkPut(b.incoming_shipments);
      if (b.demand_events.length) await this.db.demandEvents.bulkPut(b.demand_events);
      if (b.paper_usage && b.paper_usage.length) await this.db.paperUsage.bulkPut(b.paper_usage);
      // Restore the audit trail if the backup includes it. Old backups
      // pre-dating the ledger have `b.ledger = []` (Zod default) so this
      // is a safe no-op.
      if (b.ledger && b.ledger.length) await this.db.ledger.bulkPut(b.ledger);
      await this.setStorage(b.storage);
      await this.setSettings(b.settings);
    });
  }

  async wipe(): Promise<void> {
    await this.db.transaction("rw", this.db.tables, async () => {
      await Promise.all(this.db.tables.map((t) => t.clear()));
    });
  }

  /**
   * Delete WeeklyEntry rows that contribute nothing — no total_orders, no
   * name, not flagged reference, and no WeeklySales rows attached for that
   * week. These ghost rows can appear after botched imports.
   */
  async deleteEmptyWeeklyEntries(): Promise<{ deleted: number }> {
    // Sweep BOTH department tables. Each row carries its department field
    // so we can route the deletes back to the correct physical table.
    const [framedRows, unframedRows, sales] = await Promise.all([
      this.db.weeklyEntries.toArray(),
      this.db.weeklyEntriesUnframed.toArray(),
      this.db.weeklySales.toArray(),
    ]);
    const rows = [
      ...framedRows.map((r) => ({ ...r, department: r.department ?? "framed" as const })),
      ...unframedRows.map((r) => ({ ...r, department: r.department ?? "unframed" as const })),
    ];
    const salesByWeek = new Map<string, boolean>();
    for (const s of sales) {
      if (s.units_sold === 0) continue;
      salesByWeek.set(s.iso_week_start, true);
    }
    let deleted = 0;
    for (const row of rows) {
      const hasOrders = row.total_orders != null && row.total_orders > 0;
      const hasName = row.name != null && row.name.trim() !== "";
      const isRef = row.is_reference;
      if (hasOrders || hasName || isRef) continue;
      if (salesByWeek.get(row.iso_week_start)) continue;
      // Route by department to the correct physical table. PK is
      // iso_week_start in both tables — single-string key works.
      const dept = (row.department ?? "framed") as "framed" | "unframed";
      await this.tableFor(dept).delete(row.iso_week_start);
      deleted += 1;
    }
    return { deleted };
  }

  // -------- paper usage history --------
  async listPaperUsage(): Promise<PaperUsageEntry[]> {
    return this.db.paperUsage.orderBy("iso_week_start").toArray();
  }
  async upsertPaperUsage(e: PaperUsageEntry): Promise<void> {
    await this.db.paperUsage.put(e);
  }
  async deletePaperUsage(isoWeekStart: string): Promise<void> {
    await this.db.paperUsage.delete(isoWeekStart);
  }

  // -------- inventory ledger --------

  /**
   * Append a single ledger row. Internal helper — call sites pass the
   * conceptual delta, reason, and source_id; we stamp the id + ts.
   * Designed to be called from inside an already-open transaction by the
   * surrounding mutation method, so the ledger row commits atomically
   * with whatever inventory change triggered it.
   *
   * The caller does NOT need to be inside a transaction — Dexie will
   * auto-create one for this single put if needed — but in practice
   * every call site is already transactional for safety.
   */
  private async appendLedger(
    e: Omit<LedgerEntry, "id" | "ts" | "parent_event_id" | "note"> & {
      parent_event_id?: string | null;
      note?: string;
    },
  ): Promise<void> {
    const row: LedgerEntry = {
      id: nextLedgerId(),
      ts: new Date().toISOString(),
      product_id: e.product_id,
      delta: e.delta,
      reason: e.reason,
      source_id: e.source_id ?? null,
      parent_event_id: e.parent_event_id ?? null,
      note: e.note ?? "",
    };
    await this.db.ledger.put(row);
  }

  /**
   * Read ledger rows, optionally filtered by product. Returns newest-
   * first (IDs are unix-ms prefixed so a descending sort = chronological).
   * Used by the SKU-detail audit panel.
   */
  async listLedger(productId?: string, limit?: number): Promise<LedgerEntry[]> {
    const coll = productId
      ? this.db.ledger.where("product_id").equals(productId)
      : this.db.ledger.toCollection();
    const all = await coll.sortBy("id");
    all.reverse(); // ascending → descending
    if (limit && limit > 0) return all.slice(0, limit);
    return all;
  }

  // -------- CS Cases --------

  /**
   * List every CS case with its line items pre-joined. Sorted by
   * created_at descending. Volumes are small (~50/month) so we read
   * everything in one pass — no pagination.
   */
  async listCsCases(): Promise<CsCaseWithLines[]> {
    const [cases, lines] = await Promise.all([
      this.db.csCases.toArray(),
      this.db.csCaseLines.toArray(),
    ]);
    const linesByCase = new Map<string, CsCaseLine[]>();
    for (const l of lines) {
      const arr = linesByCase.get(l.case_id) ?? [];
      arr.push(l);
      linesByCase.set(l.case_id, arr);
    }
    return cases
      .map((c) => ({ ...c, lines: linesByCase.get(c.id) ?? [] }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Upsert a case + its lines atomically. Detects status transitions and
   * fires inventory adjustments where appropriate:
   *
   *   not-deducted + new state has tracking AND status is 'shipped'
   *     → deduct each new line, set inventory_deducted=true
   *
   *   deducted + new state lacks tracking OR status moved back to new/query/denied
   *     → credit back using PREV lines, set inventory_deducted=false
   *
   *   deducted + status stays 'shipped' + lines changed
   *     → reverse PREV, deduct NEW (handles "CS edited the quantity").
   *
   * Reversal uses the previously-stored lines so quantity edits are
   * cleanly handled. All adjust_on_hand calls go through the shared RPC-
   * equivalent path so ledger rows track every movement with
   * reason="replacement".
   */
  async upsertCsCase(c: CsCase, lines: CsCaseLine[]): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.csCases, this.db.csCaseLines, this.db.products, this.db.ledger],
      async () => {
        const prev = await this.db.csCases.get(c.id);
        const prevLines = prev
          ? await this.db.csCaseLines.where("case_id").equals(c.id).toArray()
          : [];

        const wasDeducted = prev?.inventory_deducted ?? false;
        const shouldBeDeducted = csCaseShouldDeductInventory(c);

        // 1) Reverse prior deduction if it's no longer applicable, OR if
        //    we'll re-deduct with new lines (so the deduction always
        //    reflects current lines).
        if (wasDeducted) {
          for (const l of prevLines) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, -l.quantity, {
              reason: "replacement",
              source_id: `cs-case:${c.id}:line:${l.id}:reverse`,
              parent_event_id: `cs-case:${c.id}`,
              note: `Replacement reversed — case re-edited or status moved back`,
            });
          }
        }

        // 2) Apply new deduction if applicable.
        if (shouldBeDeducted) {
          for (const l of lines) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, l.quantity, {
              reason: "replacement",
              source_id: `cs-case:${c.id}:line:${l.id}`,
              parent_event_id: `cs-case:${c.id}`,
              note: `Replacement for order ${c.order_number}`,
            });
          }
        }

        // 3) Persist case + lines (replace lines wholesale).
        const next: CsCase = {
          ...c,
          inventory_deducted: shouldBeDeducted,
          updated_at: new Date().toISOString(),
        };
        await this.db.csCases.put(next);
        await this.db.csCaseLines.where("case_id").equals(c.id).delete();
        if (lines.length > 0) {
          await this.db.csCaseLines.bulkPut(
            lines.map((l) => ({ ...l, case_id: c.id })),
          );
        }
      },
    );
  }

  /**
   * Delete a case. Credits back any inventory that was previously deducted
   * so on-hand isn't left artificially low.
   */
  async deleteCsCase(id: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.csCases, this.db.csCaseLines, this.db.products, this.db.ledger],
      async () => {
        const prev = await this.db.csCases.get(id);
        if (prev?.inventory_deducted) {
          const prevLines = await this.db.csCaseLines.where("case_id").equals(id).toArray();
          for (const l of prevLines) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, -l.quantity, {
              reason: "replacement",
              source_id: `cs-case:${id}:line:${l.id}:delete`,
              parent_event_id: `cs-case:${id}`,
              note: `CS case ${id} deleted — replacement credit returned`,
            });
          }
        }
        await this.db.csCaseLines.where("case_id").equals(id).delete();
        await this.db.csCases.delete(id);
      },
    );
  }

  // ---------- CS Returns ----------

  async listCsReturns(): Promise<CsReturnWithLines[]> {
    const [returns, lines] = await Promise.all([
      this.db.csReturns.toArray(),
      this.db.csReturnLines.toArray(),
    ]);
    const linesByReturn = new Map<string, CsReturnLine[]>();
    for (const l of lines) {
      const arr = linesByReturn.get(l.return_id) ?? [];
      arr.push(l);
      linesByReturn.set(l.return_id, arr);
    }
    return returns
      .map((r) => ({ ...r, lines: linesByReturn.get(r.id) ?? [] }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Upsert a return + its lines atomically.
   *
   * Status-driven timestamps:
   *   - `received_at` is set the first time status moves to 'received'
   *   - `closed_at` is set the first time status moves to 'closed'
   * Preserves existing values so reverting + re-advancing the status
   * doesn't keep rewriting the timestamps.
   *
   * Inventory model (per-line restock):
   *   1. Compute "should-be-credited NOW" set: lines with restock=true AND
   *      parent status='received'.
   *   2. Reverse any previously-credited line whose row is no longer in the
   *      should-credit set (or whose qty changed — handled implicitly).
   *   3. Apply credit for any should-credit line that wasn't already credited
   *      (or whose qty changed).
   *   4. Persist new line state with inventory_credited flag set correctly.
   *
   * We use the simple "reverse-all-then-reapply" pattern (matches CsCase) —
   * slightly more ledger rows in edge cases but conceptually bulletproof.
   */
  async upsertCsReturn(r: CsReturn, lines: CsReturnLine[]): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.csReturns, this.db.csReturnLines, this.db.products, this.db.ledger],
      async () => {
        const prev = await this.db.csReturns.get(r.id);
        const prevLines = prev
          ? await this.db.csReturnLines.where("return_id").equals(r.id).toArray()
          : [];

        // 1) Reverse every previously-credited line. We always reverse then
        //    re-apply; the net delta is correct even if quantities or
        //    product_ids changed in this save.
        for (const l of prevLines) {
          if (l.inventory_credited) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, -l.quantity, {
              reason: "return",
              source_id: `cs-return:${r.id}:line:${l.id}:reverse`,
              parent_event_id: `cs-return:${r.id}`,
              note: `Return ${r.id} previous restock reversed`,
            });
          }
        }

        // 2) Decide what should be credited now and apply it.
        const shouldCredit = r.status === "received" || r.status === "rts";
        const linesWithFlag: CsReturnLine[] = [];
        for (const l of lines) {
          const willCredit = shouldCredit && l.restock;
          if (willCredit) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, l.quantity, {
              reason: "return",
              source_id: `cs-return:${r.id}:line:${l.id}`,
              parent_event_id: `cs-return:${r.id}`,
              note: `Return ${r.id} restocked to inventory`,
            });
          }
          linesWithFlag.push({
            ...l,
            return_id: r.id,
            inventory_credited: willCredit,
          });
        }

        // 3) Persist parent + replace lines.
        const now = new Date().toISOString();
        const next: CsReturn = {
          ...r,
          received_at:
            r.status === "received" && !prev?.received_at ? now : prev?.received_at ?? r.received_at,
          closed_at:
            r.status === "closed" && !prev?.closed_at ? now : prev?.closed_at ?? r.closed_at,
          updated_at: now,
        };
        await this.db.csReturns.put(next);
        await this.db.csReturnLines.where("return_id").equals(r.id).delete();
        if (linesWithFlag.length > 0) {
          await this.db.csReturnLines.bulkPut(linesWithFlag);
        }
      },
    );
  }

  async deleteCsReturn(id: string): Promise<void> {
    await this.db.transaction(
      "rw",
      [this.db.csReturns, this.db.csReturnLines, this.db.products, this.db.ledger],
      async () => {
        // Reverse any active restock credits before removing rows, so
        // deleting a return doesn't leave on_hand artificially inflated.
        const prevLines = await this.db.csReturnLines.where("return_id").equals(id).toArray();
        for (const l of prevLines) {
          if (l.inventory_credited) {
            // eslint-disable-next-line no-await-in-loop
            await this.adjustOnHand(l.product_id, -l.quantity, {
              reason: "return",
              source_id: `cs-return:${id}:line:${l.id}:delete`,
              parent_event_id: `cs-return:${id}`,
              note: `Return ${id} deleted — restock credit reversed`,
            });
          }
        }
        await this.db.csReturnLines.where("return_id").equals(id).delete();
        await this.db.csReturns.delete(id);
      },
    );
  }
}

/**
 * Inventory-deduction rule: deduct only when the case is in `shipped` state
 * AND has a tracking number set. 'query' is a holding state where CS is
 * still chasing info — stock must not move there. Pre-tracking edits stay
 * safe; once we ship and enter a tracking number, we commit the stock
 * change. Mirrored verbatim by SupabaseRepo.
 */
function csCaseShouldDeductInventory(c: CsCase): boolean {
  if (c.status !== "shipped") return false;
  if (!c.tracking_number || c.tracking_number.trim() === "") return false;
  return true;
}
