import type { SupabaseClient } from "@supabase/supabase-js";
import type { Repository } from "../Repository";
import {
  // Runtime Zod schemas — used by importBackup to normalize legacy Dexie
  // rows (fill in default values for fields that didn't exist when the
  // row was first written, e.g. `product_type`, `components`).
  ProductSchema,
  WeeklySalesSchema,
  WeeklyEntrySchema,
  IncomingShipmentSchema,
  DemandChangeEventSchema,
  PaperUsageEntrySchema,
  LedgerEntrySchema,
  type Backup,
  type DemandChangeEvent,
  type GlobalSettings,
  type IncomingShipment,
  type LedgerEntry,
  type LedgerReason,
  type LocationKey,
  type PaperUsageEntry,
  type Product,
  type StorageLayout,
  type WeeklyEntry,
  type WeeklySales,
  type CsCase,
  type CsCaseLine,
  type CsCaseWithLines,
  type CsReturn,
  type CsReturnLine,
  type CsReturnWithLines,
} from "@/lib/domain";

/**
 * Client-side adapter implementing the same `Repository` interface as
 * `DexieRepo` but talking to Supabase Postgres over PostgREST.
 *
 * Design notes:
 * - One instance per location. The `location` is fixed at construction and
 *   filtered into every query — mirrors how DexieRepo holds a per-location
 *   StockDB reference.
 * - Inventory + ledger writes go through the `adjust_on_hand` RPC for
 *   transactional safety. Postgres handles the products update, ledger
 *   insert, and BOM cascade in one atomic call.
 * - Multi-step operations (deleteSale, upsertShipment delivery, etc) are
 *   orchestrated client-side. At small team scale the partial-failure risk
 *   is acceptable; promotable to RPC later if it bites.
 * - Column names match TS field names 1:1 (snake_case throughout). No
 *   translation layer needed.
 *
 * Phase 2 of the multi-user migration: this file exists but isn't used
 * unless VITE_BACKEND=supabase. The Dexie path stays the default.
 */
export class SupabaseRepo implements Repository {
  constructor(
    private supabase: SupabaseClient,
    private location: LocationKey,
  ) {}

  // ============================================================
  // PRODUCTS
  // ============================================================

  async listProducts(): Promise<Product[]> {
    const { data, error } = await this.supabase
      .from("products")
      .select("*")
      .eq("location", this.location)
      .order("code");
    if (error) throw error;
    return (data ?? []).map(stripLocation);
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const { data, error } = await this.supabase
      .from("products")
      .select("*")
      .eq("location", this.location)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? stripLocation(data) : undefined;
  }

  async upsertProduct(p: Product): Promise<void> {
    // Client-side BOM cycle check (cheap because components are bounded).
    // The RPC adjust_on_hand has its own depth cap as a hard backstop.
    if (Array.isArray(p.components) && p.components.length > 0) {
      const cyclePath = await this.findBomCycle(p.id, p.components);
      if (cyclePath) {
        throw new Error(
          `Component recipe forms a cycle: ${cyclePath}. A SKU can't appear in its own bill-of-materials.`,
        );
      }
    }

    // Detect on-hand drift to record a ledger entry. Done client-side
    // (read prev → upsert new → if drift, call adjust_on_hand to update
    // and append). Not atomic with the product upsert but acceptable at
    // this scale.
    const prev = await this.getProduct(p.id);
    const prevOnHand = prev?.current_on_hand ?? 0;
    const newOnHand = p.current_on_hand ?? 0;
    const drift = newOnHand - prevOnHand;

    // Write the product row first (with its declared on-hand). If drift
    // exists, we then call adjust_on_hand to record a ledger entry — but
    // we use a delta of 0 against the NEW value so adjust_on_hand doesn't
    // try to re-modify on-hand (it already matches what we just wrote).
    // Instead we append a manual ledger row directly via insert.
    const { error } = await this.supabase
      .from("products")
      .upsert({ ...p, location: this.location }, { onConflict: "location,id" });
    if (error) throw error;

    if (drift !== 0) {
      const reason: LedgerReason = prev ? "manual" : "initial";
      const ledgerRow: LedgerEntry = {
        id: nextLedgerId(),
        ts: new Date().toISOString(),
        product_id: p.id,
        delta: drift,
        reason,
        source_id: `product-edit:${p.id}:${Date.now()}`,
        parent_event_id: null,
        note: prev ? "On-hand edited via SKU form or bulk edit" : "Initial seed",
      };
      const { error: lerr } = await this.supabase
        .from("ledger")
        .insert({ ...ledgerRow, location: this.location });
      if (lerr) throw lerr;
    }
  }

  async deleteProduct(id: string): Promise<void> {
    // Sweep references first. Postgres FKs ON DELETE CASCADE handle most of
    // this (sales, pallet_assignments), but shipment lines (JSONB) and
    // recipe components (JSONB) need manual cleanup.

    // 1) Shipment lines pointing at this product.
    const { data: ships, error: serr } = await this.supabase
      .from("shipments")
      .select("*")
      .eq("location", this.location);
    if (serr) throw serr;
    for (const s of ships ?? []) {
      const lines: { product_id: string; quantity: number }[] =
        Array.isArray(s.lines) ? s.lines : [];
      const legacyHit = s.product_id === id;
      const filtered = lines.filter((l) => l.product_id !== id);
      if (!legacyHit && filtered.length === lines.length) continue;
      if (filtered.length === 0) {
        await this.supabase
          .from("shipments")
          .delete()
          .eq("location", this.location)
          .eq("id", s.id);
      } else {
        const updated: Record<string, unknown> = { ...s, lines: filtered };
        if (legacyHit) {
          updated.product_id = null;
          updated.quantity = null;
        }
        await this.supabase
          .from("shipments")
          .upsert(updated, { onConflict: "location,id" });
      }
    }

    // 2) Recipe references in other products' `components`.
    const { data: prods, error: perr } = await this.supabase
      .from("products")
      .select("*")
      .eq("location", this.location);
    if (perr) throw perr;
    for (const p of prods ?? []) {
      const comps: { child_product_id: string; qty_per_unit: number }[] =
        Array.isArray(p.components) ? p.components : [];
      const filtered = comps.filter((c) => c.child_product_id !== id);
      if (filtered.length !== comps.length) {
        await this.supabase
          .from("products")
          .update({ components: filtered })
          .eq("location", this.location)
          .eq("id", p.id);
      }
    }

    // 3) Finally delete the product itself. Postgres CASCADE drops the
    //    weekly_sales + pallet_assignments rows that reference it.
    const { error } = await this.supabase
      .from("products")
      .delete()
      .eq("location", this.location)
      .eq("id", id);
    if (error) throw error;
  }

  async adjustOnHand(
    productId: string,
    delta: number,
    context?: { reason: LedgerReason; source_id?: string | null; note?: string; parent_event_id?: string | null },
  ): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) return;
    const { error } = await this.supabase.rpc("adjust_on_hand", {
      p_location: this.location,
      p_product_id: productId,
      p_delta: delta,
      p_reason: context?.reason ?? "manual",
      p_source_id: context?.source_id ?? null,
      p_parent_event_id: context?.parent_event_id ?? null,
      p_note: context?.note ?? "adjustOnHand",
    });
    if (error) throw error;
  }

  // ============================================================
  // WEEKLY SALES
  // ============================================================

  async listSales(productId?: string): Promise<WeeklySales[]> {
    let q = this.supabase.from("weekly_sales").select("*").eq("location", this.location);
    if (productId) q = q.eq("product_id", productId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map(stripLocation);
  }

  async upsertSale(s: WeeklySales): Promise<void> {
    const { error } = await this.supabase
      .from("weekly_sales")
      .upsert({ ...s, location: this.location }, { onConflict: "location,product_id,iso_week_start" });
    if (error) throw error;
  }

  async bulkUpsertSales(rows: WeeklySales[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.supabase
      .from("weekly_sales")
      .upsert(rows.map((r) => ({ ...r, location: this.location })), { onConflict: "location,product_id,iso_week_start" });
    if (error) throw error;
  }

  async deleteSale(productId: string, isoWeekStart: string): Promise<void> {
    // Mirror DexieRepo: credit back the units to inventory (with BOM
    // cascade reverse) before deleting, gated by auto_adjust setting.
    const settings = await this.getSettings();
    if (settings.auto_adjust_inventory_on_sale ?? true) {
      const { data: row, error: rerr } = await this.supabase
        .from("weekly_sales")
        .select("*")
        .eq("location", this.location)
        .eq("product_id", productId)
        .eq("iso_week_start", isoWeekStart)
        .maybeSingle();
      if (rerr) throw rerr;
      if (row && row.units_sold > 0) {
        await this.adjustOnHand(productId, -row.units_sold, {
          reason: "sale",
          source_id: `sale:${productId}:${isoWeekStart}:delete`,
          note: "Sale row deleted — credit returned",
        });
      }
    }
    const { error } = await this.supabase
      .from("weekly_sales")
      .delete()
      .eq("location", this.location)
      .eq("product_id", productId)
      .eq("iso_week_start", isoWeekStart);
    if (error) throw error;
  }

  // ============================================================
  // WEEKLY ENTRIES
  // ============================================================

  async listWeeklyEntries(): Promise<WeeklyEntry[]> {
    const { data, error } = await this.supabase
      .from("weekly_entries")
      .select("*")
      .eq("location", this.location)
      .order("iso_week_start");
    if (error) throw error;
    // Coerce missing department on legacy rows (pre-migration cache) to
    // 'framed' so the rest of the app can rely on the field being set.
    return (data ?? []).map(stripLocation).map((e: WeeklyEntry) => ({
      ...e,
      department: e.department ?? "framed",
    }));
  }

  async upsertWeeklyEntry(e: WeeklyEntry): Promise<void> {
    const payload = {
      ...e,
      department: e.department ?? "framed",
      location: this.location,
    };
    const { error } = await this.supabase
      .from("weekly_entries")
      .upsert(payload, { onConflict: "location,department,iso_week_start" });
    if (error) throw error;
  }

  async deleteWeeklyEntry(
    isoWeekStart: string,
    department: "framed" | "unframed",
  ): Promise<void> {
    // Credit back inventory for every attached sale, scoped to the
    // department's products only. Sales rows don't carry department, so
    // we join client-side via the product list.
    const sales = await this.supabase
      .from("weekly_sales")
      .select("*")
      .eq("location", this.location)
      .eq("iso_week_start", isoWeekStart);
    if (sales.error) throw sales.error;

    const productLookup = await this.supabase
      .from("products")
      .select("id,supplier")
      .eq("location", this.location);
    if (productLookup.error) throw productLookup.error;
    const productDept = new Map<string, "framed" | "unframed">();
    for (const p of (productLookup.data ?? []) as Array<{ id: string; supplier: string | null }>) {
      productDept.set(
        p.id,
        (p.supplier ?? "").trim().toUpperCase() === "UNFRAMED" ? "unframed" : "framed",
      );
    }
    for (const s of sales.data ?? []) {
      if (productDept.get(s.product_id) !== department) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.deleteSale(s.product_id, s.iso_week_start);
    }

    const { error } = await this.supabase
      .from("weekly_entries")
      .delete()
      .eq("location", this.location)
      .eq("department", department)
      .eq("iso_week_start", isoWeekStart);
    if (error) throw error;
  }

  async renameWeeklyEntry(
    oldIso: string,
    newIso: string,
    department: "framed" | "unframed",
  ): Promise<void> {
    if (oldIso === newIso) return;
    // Check collision within the same department.
    const { data: collision, error: cerr } = await this.supabase
      .from("weekly_entries")
      .select("iso_week_start")
      .eq("location", this.location)
      .eq("department", department)
      .eq("iso_week_start", newIso)
      .maybeSingle();
    if (cerr) throw cerr;
    if (collision) {
      throw new Error(`A ${department} row already exists for ${newIso}. Pick a different date or delete that row first.`);
    }

    const { data: entry, error: eerr } = await this.supabase
      .from("weekly_entries")
      .select("*")
      .eq("location", this.location)
      .eq("department", department)
      .eq("iso_week_start", oldIso)
      .maybeSingle();
    if (eerr) throw eerr;
    if (!entry) throw new Error(`No ${department} entry found for ${oldIso}`);

    // Move entry + sales. Composite-key updates need delete+insert because
    // PostgREST doesn't natively support primary-key UPDATEs in one call.
    // Sales rows are filtered by department via product join.
    const { data: sales, error: serr } = await this.supabase
      .from("weekly_sales")
      .select("*")
      .eq("location", this.location)
      .eq("iso_week_start", oldIso);
    if (serr) throw serr;
    const productLookup = await this.supabase
      .from("products")
      .select("id,supplier")
      .eq("location", this.location);
    if (productLookup.error) throw productLookup.error;
    const productDept = new Map<string, "framed" | "unframed">();
    for (const p of (productLookup.data ?? []) as Array<{ id: string; supplier: string | null }>) {
      productDept.set(
        p.id,
        (p.supplier ?? "").trim().toUpperCase() === "UNFRAMED" ? "unframed" : "framed",
      );
    }

    await this.supabase.from("weekly_entries").delete()
      .eq("location", this.location)
      .eq("department", department)
      .eq("iso_week_start", oldIso);
    await this.supabase.from("weekly_entries").insert({ ...entry, iso_week_start: newIso });

    for (const s of sales ?? []) {
      if (productDept.get(s.product_id) !== department) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.supabase.from("weekly_sales").delete()
        .eq("location", this.location).eq("product_id", s.product_id).eq("iso_week_start", oldIso);
      // eslint-disable-next-line no-await-in-loop
      await this.supabase.from("weekly_sales").insert({ ...s, iso_week_start: newIso });
    }
  }

  /**
   * Bulk-delete weekly entries + sales rows. Two paths driven by the
   * auto_adjust_inventory_on_sale setting (mirrors DexieRepo):
   *
   *   auto-adjust OFF
   *     Two batched SQL DELETEs (entries + sales), one HTTP round-trip
   *     each. No cascade. on_hand stays where it is.
   *
   *   auto-adjust ON
   *     Aggregate per-product credits across every deleted sale row, call
   *     adjust_on_hand RPC once per unique product (BOM cascade handled
   *     inside the RPC), then the same two batched DELETEs. 1 + N(unique
   *     products) RPC calls — way faster than 1 per sale, while keeping
   *     on_hand accurate.
   */
  async bulkDeleteWeeklyEntries(
    weeks: Array<{ iso_week_start: string; department: "framed" | "unframed" }>,
  ): Promise<{ entries: number; sales: number }> {
    if (weeks.length === 0) return { entries: 0, sales: 0 };
    const loc = this.location;
    const settings = await this.getSettings();
    const autoAdjust = settings.auto_adjust_inventory_on_sale ?? true;

    const framedIsos = weeks
      .filter((w) => w.department === "framed")
      .map((w) => w.iso_week_start);
    const unframedIsos = weeks
      .filter((w) => w.department === "unframed")
      .map((w) => w.iso_week_start);
    const allIsos = Array.from(new Set([...framedIsos, ...unframedIsos]));

    // ---- 1. Optional credit-back, aggregated per product ----
    if (autoAdjust && allIsos.length > 0) {
      const { data: salesRows, error: serr } = await this.supabase
        .from("weekly_sales")
        .select("product_id, units_sold")
        .eq("location", loc)
        .in("iso_week_start", allIsos);
      if (serr) throw serr;
      const creditByProduct = new Map<string, number>();
      for (const s of (salesRows ?? []) as Array<{ product_id: string; units_sold: number }>) {
        if (!Number.isFinite(s.units_sold) || s.units_sold <= 0) continue;
        creditByProduct.set(
          s.product_id,
          (creditByProduct.get(s.product_id) ?? 0) + s.units_sold,
        );
      }
      for (const [productId, units] of creditByProduct) {
        if (units === 0) continue;
        // eslint-disable-next-line no-await-in-loop
        await this.adjustOnHand(productId, -units, {
          reason: "sale",
          source_id: `bulk-delete:${productId}:${allIsos[0]}`,
          note: `Bulk delete of ${weeks.length} week${weeks.length === 1 ? "" : "s"} — sales credit returned`,
        });
      }
    }

    // ---- 2. Batched DELETEs (entries by department, sales by week) ----
    let entriesDeleted = 0;
    if (framedIsos.length > 0) {
      const { error } = await this.supabase
        .from("weekly_entries")
        .delete()
        .eq("location", loc)
        .eq("department", "framed")
        .in("iso_week_start", framedIsos);
      if (error) throw error;
      entriesDeleted += framedIsos.length;
    }
    if (unframedIsos.length > 0) {
      const { error } = await this.supabase
        .from("weekly_entries")
        .delete()
        .eq("location", loc)
        .eq("department", "unframed")
        .in("iso_week_start", unframedIsos);
      if (error) throw error;
      entriesDeleted += unframedIsos.length;
    }

    let salesDeleted = 0;
    if (allIsos.length > 0) {
      const { error, count } = await this.supabase
        .from("weekly_sales")
        .delete({ count: "exact" })
        .eq("location", loc)
        .in("iso_week_start", allIsos);
      if (error) throw error;
      salesDeleted = count ?? 0;
    }
    return { entries: entriesDeleted, sales: salesDeleted };
  }

  // ============================================================
  // SHIPMENTS
  // ============================================================

  async listShipments(productId?: string): Promise<IncomingShipment[]> {
    const { data, error } = await this.supabase
      .from("shipments")
      .select("*")
      .eq("location", this.location);
    if (error) throw error;
    const all = (data ?? []).map(stripLocation).map((s: IncomingShipment) => {
      // Backfill legacy single-line shape into the multi-line `lines` array.
      if (!Array.isArray(s.lines) || s.lines.length === 0) {
        if (s.product_id && s.quantity) {
          s.lines = [{ product_id: s.product_id, quantity: s.quantity }];
        } else {
          s.lines = [];
        }
      }
      return s;
    });
    if (!productId) return all;
    return all.filter(
      (s) => s.product_id === productId || s.lines.some((l) => l.product_id === productId),
    );
  }

  async upsertShipment(s: IncomingShipment): Promise<void> {
    // Race-free flow (closes the duplicate-credit bug observed in
    // Laverton (2nd) on May 18 — see migration 0014):
    //
    //   1. If transitioning OUT of Delivered, call reverse_shipment_delivery
    //      FIRST. It locks the row, sees old lines, reverses them.
    //   2. Upsert the shipment row WITHOUT touching inventory_applied_at
    //      (the RPC is the sole writer of that column).
    //   3. If new status is Delivered, call apply_shipment_delivery. It
    //      locks the row, checks the flag, credits if needed.
    //
    // Both RPCs are idempotent — a second concurrent call sees the lock
    // released with the flag already flipped, returns 'noop'. Double-clicking
    // Save no longer double-credits.

    const settings = await this.getSettings();
    const autoApply = settings.auto_apply_shipments_on_delivery ?? true;

    // Read prev only to know whether we need to reverse before the upsert.
    const { data: prev } = await this.supabase
      .from("shipments")
      .select("status, inventory_applied_at")
      .eq("location", this.location)
      .eq("id", s.id)
      .maybeSingle();

    const wasDelivered = prev?.status === "Delivered" && !!prev?.inventory_applied_at;
    const isDelivered = s.status === "Delivered";

    // 1. Reverse first if we're leaving Delivered (or Delivered→Delivered with
    //    edited lines is intentionally NOT re-credited — matches prior behavior).
    if (autoApply && wasDelivered && !isDelivered) {
      const { error: revErr } = await this.supabase.rpc("reverse_shipment_delivery", {
        p_location: this.location,
        p_shipment_id: s.id,
      });
      if (revErr) throw revErr;
    }

    // 2. Upsert the shipment row — strip inventory_applied_at so we don't
    //    race with the RPC that owns it.
    const {
      inventory_applied_at: _ignoreAppliedAt, // eslint-disable-line @typescript-eslint/no-unused-vars
      ...rest
    } = s;
    const { error } = await this.supabase
      .from("shipments")
      .upsert({ ...rest, location: this.location }, { onConflict: "location,id" });
    if (error) throw error;

    // 3. Apply credit if new status is Delivered. Idempotent — if a concurrent
    //    save already credited, this returns 'noop'.
    if (autoApply && isDelivered) {
      const { error: appErr } = await this.supabase.rpc("apply_shipment_delivery", {
        p_location: this.location,
        p_shipment_id: s.id,
      });
      if (appErr) throw appErr;
    }
  }

  async deleteShipment(id: string): Promise<void> {
    // Atomic via delete_shipment_atomic RPC — locks the row, reverses if
    // applied, deletes in one transaction. Closes the same race as upsert:
    // two concurrent deletes both saw applied=true under the old code and
    // both fired the reverse.
    const { error } = await this.supabase.rpc("delete_shipment_atomic", {
      p_location: this.location,
      p_shipment_id: id,
    });
    if (error) throw error;
  }

  // ============================================================
  // DEMAND EVENTS
  // ============================================================

  async listDemandEvents(): Promise<DemandChangeEvent[]> {
    const { data, error } = await this.supabase
      .from("demand_events")
      .select("*")
      .eq("location", this.location);
    if (error) throw error;
    return (data ?? []).map(stripLocation);
  }

  async upsertDemandEvent(e: DemandChangeEvent): Promise<void> {
    const { error } = await this.supabase
      .from("demand_events")
      .upsert({ ...e, location: this.location }, { onConflict: "location,id" });
    if (error) throw error;
  }

  async deleteDemandEvent(id: string): Promise<void> {
    const { error } = await this.supabase
      .from("demand_events")
      .delete()
      .eq("location", this.location)
      .eq("id", id);
    if (error) throw error;
  }

  // ============================================================
  // STORAGE LAYOUT (bays + pallet assignments)
  // ============================================================

  async getStorage(): Promise<StorageLayout> {
    const [bays, palletAssignments] = await Promise.all([
      this.supabase.from("bays").select("*").eq("location", this.location).order("row"),
      this.supabase.from("pallet_assignments").select("*").eq("location", this.location),
    ]);
    if (bays.error) throw bays.error;
    if (palletAssignments.error) throw palletAssignments.error;
    return {
      bays: (bays.data ?? []).map(stripLocation),
      palletAssignments: (palletAssignments.data ?? []).map(stripLocation),
    };
  }

  async setStorage(s: StorageLayout): Promise<void> {
    // Replace the whole storage layout — same semantics as DexieRepo.
    await this.supabase.from("pallet_assignments").delete().eq("location", this.location);
    await this.supabase.from("bays").delete().eq("location", this.location);
    if (s.bays.length) {
      const { error } = await this.supabase
        .from("bays")
        .insert(s.bays.map((b) => ({ ...b, location: this.location })));
      if (error) throw error;
    }
    if (s.palletAssignments.length) {
      const { error } = await this.supabase
        .from("pallet_assignments")
        .insert(s.palletAssignments.map((pa) => ({ ...pa, location: this.location })));
      if (error) throw error;
    }
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  async getSettings(): Promise<GlobalSettings> {
    const { data, error } = await this.supabase
      .from("settings")
      .select("*")
      .eq("location", this.location)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      // Auto-seed defaults on first read — mirrors DexieRepo.
      const defaults = await this.seedDefaultSettings();
      return defaults;
    }
    return stripLocation(data);
  }

  async setSettings(s: GlobalSettings): Promise<void> {
    const { error } = await this.supabase
      .from("settings")
      .upsert({ ...s, location: this.location }, { onConflict: "location" });
    if (error) throw error;
  }

  private async seedDefaultSettings(): Promise<GlobalSettings> {
    // Insert a default-shaped row; relies on Postgres column defaults to
    // fill anything we don't specify. Return a fresh GlobalSettings shape.
    await this.supabase.from("settings").insert({ location: this.location });
    const { data, error } = await this.supabase
      .from("settings")
      .select("*")
      .eq("location", this.location)
      .single();
    if (error) throw error;
    return stripLocation(data);
  }

  // ============================================================
  // PAPER USAGE
  // ============================================================

  async listPaperUsage(): Promise<PaperUsageEntry[]> {
    const { data, error } = await this.supabase
      .from("paper_usage")
      .select("*")
      .eq("location", this.location)
      .order("iso_week_start");
    if (error) throw error;
    return (data ?? []).map(stripLocation);
  }

  async upsertPaperUsage(e: PaperUsageEntry): Promise<void> {
    const { error } = await this.supabase
      .from("paper_usage")
      .upsert({ ...e, location: this.location }, { onConflict: "location,iso_week_start" });
    if (error) throw error;
  }

  async deletePaperUsage(isoWeekStart: string): Promise<void> {
    const { error } = await this.supabase
      .from("paper_usage")
      .delete()
      .eq("location", this.location)
      .eq("iso_week_start", isoWeekStart);
    if (error) throw error;
  }

  // ============================================================
  // LEDGER
  // ============================================================

  async listLedger(productId?: string, limit?: number): Promise<LedgerEntry[]> {
    let q = this.supabase
      .from("ledger")
      .select("*")
      .eq("location", this.location)
      .order("ts", { ascending: false });
    if (productId) q = q.eq("product_id", productId);
    if (limit && limit > 0) q = q.limit(limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map(stripLocation);
  }

  // ============================================================
  // BACKUP / WIPE
  // ============================================================

  async exportBackup(): Promise<Backup> {
    const [products, sales, entries, shipments, events, storage, settings, paperUsage, ledger] =
      await Promise.all([
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
      weekly_sales: sales,
      weekly_entries: entries,
      incoming_shipments: shipments,
      demand_events: events,
      storage,
      settings,
      paper_usage: paperUsage,
      ledger,
    };
  }

  async importBackup(b: Backup): Promise<void> {
    await this.wipe();
    const loc = this.location;

    /**
     * Run rows through their Zod schema before sending. Legacy Dexie
     * rows often lack fields that were added later (e.g. `product_type`,
     * `components`, `safety_stock_pct`) — Zod's `.default()` clauses fill
     * them in, then Postgres NOT NULL constraints are satisfied. Without
     * this step, a single legacy row sinks the whole insert batch.
     *
     * If a row is too malformed for Zod to parse, we collect those errors
     * and surface them WITH ROW NUMBERS so the user can fix them in the
     * Dexie app before re-running.
     */
    const normalizeRows = <T>(
      rows: unknown[],
      schema: { parse: (v: unknown) => T },
      label: string,
    ): T[] => {
      const out: T[] = [];
      const errors: { index: number; message: string }[] = [];
      for (let i = 0; i < rows.length; i++) {
        try {
          out.push(schema.parse(rows[i]));
        } catch (e) {
          errors.push({ index: i, message: (e as Error).message.slice(0, 200) });
        }
      }
      if (errors.length > 0) {
        const sample = errors
          .slice(0, 3)
          .map((e) => `${label}[${e.index}]: ${e.message}`)
          .join(" | ");
        throw new Error(
          `${errors.length} of ${rows.length} ${label} rows failed schema validation. First few: ${sample}`,
        );
      }
      return out;
    };

    /**
     * Upsert rows in chunks, checking the response error after every
     * batch. Using upsert (not insert) makes the migration idempotent —
     * re-running it overwrites any rows that survived a previous partial
     * migration rather than erroring with a duplicate-key violation.
     *
     * Each table has its own composite PK; `onConflict` tells PostgREST
     * which columns to match on. Chunk size of 500 keeps payloads well
     * below PostgREST's default limit even for big tables (ledger /
     * weekly_sales).
     */
    const batchInsert = async (
      table: string,
      rows: Record<string, unknown>[],
      onConflict: string,
    ) => {
      if (rows.length === 0) return;
      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        // eslint-disable-next-line no-await-in-loop
        const { error } = await this.supabase.from(table).upsert(chunk, { onConflict });
        if (error) {
          const sample = chunk[0] ? JSON.stringify(chunk[0]).slice(0, 240) : "(empty chunk)";
          throw new Error(
            `Upsert into ${table} failed (rows ${i + 1}–${i + chunk.length} of ${rows.length}): ${error.message}` +
            (error.details ? ` Details: ${error.details}.` : "") +
            (error.hint ? ` Hint: ${error.hint}.` : "") +
            ` First row: ${sample}`,
          );
        }
      }
    };

    // Normalize each table's rows via Zod, then attach the location
    // column and batch-insert. Zod's `.default()` clauses fill missing
    // (undefined) values but do NOT fill `null` — so we follow up with
    // an explicit null-coalescing pass below that catches legacy rows
    // where the field was written as null instead of being absent.
    const products = normalizeRows(b.products, ProductSchema, "product");
    const entries = normalizeRows(b.weekly_entries, WeeklyEntrySchema, "weekly_entry");
    const sales = normalizeRows(b.weekly_sales, WeeklySalesSchema, "weekly_sale");
    const shipments = normalizeRows(b.incoming_shipments, IncomingShipmentSchema, "shipment");
    const events = normalizeRows(b.demand_events, DemandChangeEventSchema, "demand_event");
    const paperUsage = normalizeRows(b.paper_usage ?? [], PaperUsageEntrySchema, "paper_usage");
    const ledger = normalizeRows(b.ledger ?? [], LedgerEntrySchema, "ledger");

    // Belt-and-braces: explicitly coalesce every potentially-null field
    // that the Postgres schema has a NOT NULL constraint on. Handles
    // legacy Dexie rows whose missing fields ended up as `null` (rather
    // than `undefined`) at JSON-export time — Zod's `.default()` skips
    // those, but Postgres rejects them. Cheap insurance against any
    // future field-addition pattern hitting the same issue.
    const productsForInsert = products.map((p: Product) => ({
      ...p,
      product_type: p.product_type ?? "product",
      components: p.components ?? [],
      notes: p.notes ?? "",
      size: p.size ?? "",
      colour: p.colour ?? "",
      unit_of_sale: p.unit_of_sale ?? "each",
      pallet_capacity_units: p.pallet_capacity_units ?? 0,
      bay_capacity_pallets: p.bay_capacity_pallets ?? 0,
      lead_time_days: p.lead_time_days ?? 28,
      min_order_qty: p.min_order_qty ?? 0,
      order_increment: p.order_increment ?? 1,
      current_on_hand: p.current_on_hand ?? 0,
      safety_stock_units: p.safety_stock_units ?? 0,
      safety_stock_pct: p.safety_stock_pct ?? 100,
      target_weeks_of_cover_override: p.target_weeks_of_cover_override ?? 21,
      weekly_avg_method: p.weekly_avg_method ?? "trailing_8",
      display_order: p.display_order ?? 0,
      location: loc,
    }));

    await batchInsert("products", productsForInsert, "location,id");
    await batchInsert("weekly_entries", entries.map((e) => ({
      ...e,
      is_reference: e.is_reference ?? false,
      shopify_orders_by_size: e.shopify_orders_by_size ?? {},
      entered_by: e.entered_by ?? "system",
      location: loc,
    })), "location,iso_week_start");
    await batchInsert("weekly_sales", sales.map((s) => ({
      ...s,
      entered_by: s.entered_by ?? "system",
      location: loc,
    })), "location,product_id,iso_week_start");
    await batchInsert("shipments", shipments.map((s) => ({
      ...s,
      lines: s.lines ?? [],
      notes: s.notes ?? "",
      status: s.status ?? "Ordered",
      customs_days: s.customs_days ?? 0,
      location: loc,
    })), "location,id");
    await batchInsert("demand_events", events.map((e) => ({
      ...e,
      notes: e.notes ?? "",
      location: loc,
    })), "location,id");
    await batchInsert("paper_usage", paperUsage.map((e) => ({
      ...e,
      notes: e.notes ?? "",
      recorded_by: e.recorded_by ?? "manual",
      buffer_pct: e.buffer_pct ?? 0,
      deducted_rolls_24: e.deducted_rolls_24 ?? 0,
      deducted_rolls_42: e.deducted_rolls_42 ?? 0,
      location: loc,
    })), "location,iso_week_start");
    await batchInsert("ledger", ledger.map((e) => ({
      ...e,
      note: e.note ?? "",
      location: loc,
    })), "location,id");

    await this.setStorage(b.storage);
    await this.setSettings(b.settings);
  }

  async wipe(): Promise<void> {
    // Delete in FK-safe order. pallet_assignments before bays, sales before
    // products, etc. Postgres CASCADE would handle most of this but doing it
    // explicitly keeps RLS-permission errors readable if any fire.
    const loc = this.location;
    const tables = [
      "ledger", "paper_usage", "pallet_assignments", "bays",
      "demand_events", "shipments", "weekly_sales", "weekly_entries",
      "products", "settings",
    ];
    for (const t of tables) {
      // eslint-disable-next-line no-await-in-loop
      const { error } = await this.supabase.from(t).delete().eq("location", loc);
      if (error) {
        throw new Error(
          `Wipe of ${t} failed: ${error.message}` +
          (error.details ? ` Details: ${error.details}.` : ""),
        );
      }
    }
  }

  // ============================================================
  // CLEANUP / UTILITIES
  // ============================================================

  async deleteEmptyWeeklyEntries(): Promise<{ deleted: number }> {
    const [entries, sales] = await Promise.all([
      this.listWeeklyEntries(),
      this.listSales(),
    ]);
    const salesByWeek = new Set<string>();
    for (const s of sales) {
      if (s.units_sold === 0) continue;
      salesByWeek.add(s.iso_week_start);
    }
    let deleted = 0;
    for (const e of entries) {
      const hasOrders = e.total_orders != null && e.total_orders > 0;
      const hasName = e.name != null && e.name.trim() !== "";
      const isRef = e.is_reference;
      if (hasOrders || hasName || isRef) continue;
      if (salesByWeek.has(e.iso_week_start)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.supabase
        .from("weekly_entries")
        .delete()
        .eq("location", this.location)
        .eq("iso_week_start", e.iso_week_start);
      deleted += 1;
    }
    return { deleted };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  // ============================================================
  // CS CASES
  // ============================================================

  async listCsCases(): Promise<CsCaseWithLines[]> {
    const [casesRes, linesRes] = await Promise.all([
      this.supabase
        .from("cs_cases")
        .select("*")
        .eq("location", this.location)
        .order("created_at", { ascending: false }),
      this.supabase
        .from("cs_case_lines")
        .select("*")
        .eq("location", this.location),
    ]);
    if (casesRes.error) throw casesRes.error;
    if (linesRes.error) throw linesRes.error;
    const linesByCase = new Map<string, CsCaseLine[]>();
    for (const raw of linesRes.data ?? []) {
      const l = stripLocation(raw) as CsCaseLine;
      const arr = linesByCase.get(l.case_id) ?? [];
      arr.push(l);
      linesByCase.set(l.case_id, arr);
    }
    return (casesRes.data ?? []).map((raw) => {
      const c = stripLocation(raw) as CsCase;
      return { ...c, lines: linesByCase.get(c.id) ?? [] };
    });
  }

  async upsertCsCase(c: CsCase, lines: CsCaseLine[]): Promise<void> {
    // Mirror DexieRepo: detect deduction transitions, adjust inventory,
    // upsert the parent + replace lines. Multi-step orchestrated client-
    // side (similar to the shipment delivery flow).
    const loc = this.location;

    // Fetch prior state to compute transitions.
    const { data: prevRaw } = await this.supabase
      .from("cs_cases")
      .select("*")
      .eq("location", loc)
      .eq("id", c.id)
      .maybeSingle();
    const prev = prevRaw ? (stripLocation(prevRaw) as CsCase) : null;
    let prevLines: CsCaseLine[] = [];
    if (prev) {
      const { data: prevLinesRaw } = await this.supabase
        .from("cs_case_lines")
        .select("*")
        .eq("location", loc)
        .eq("case_id", c.id);
      prevLines = (prevLinesRaw ?? []).map((r) => stripLocation(r) as CsCaseLine);
    }

    const wasDeducted = prev?.inventory_deducted ?? false;
    const shouldBeDeducted = csCaseShouldDeductInventory(c);

    if (wasDeducted) {
      for (const l of prevLines) {
        // eslint-disable-next-line no-await-in-loop
        await this.adjustOnHand(l.product_id, -l.quantity, {
          reason: "replacement",
          source_id: `cs-case:${c.id}:line:${l.id}:reverse`,
          parent_event_id: `cs-case:${c.id}`,
          note: "Replacement reversed — case re-edited or status moved back",
        });
      }
    }
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

    // Upsert the parent row.
    const next: CsCase = {
      ...c,
      inventory_deducted: shouldBeDeducted,
      updated_at: new Date().toISOString(),
    };
    const { error: parentErr } = await this.supabase
      .from("cs_cases")
      .upsert({ ...next, location: loc }, { onConflict: "location,id" });
    if (parentErr) throw parentErr;

    // Replace lines: delete all for this case, re-insert fresh.
    const { error: delErr } = await this.supabase
      .from("cs_case_lines")
      .delete()
      .eq("location", loc)
      .eq("case_id", c.id);
    if (delErr) throw delErr;
    if (lines.length > 0) {
      const { error: insErr } = await this.supabase
        .from("cs_case_lines")
        .insert(lines.map((l) => ({ ...l, case_id: c.id, location: loc })));
      if (insErr) throw insErr;
    }
  }

  async deleteCsCase(id: string): Promise<void> {
    const loc = this.location;
    // Credit back if previously deducted.
    const { data: prevRaw } = await this.supabase
      .from("cs_cases")
      .select("*")
      .eq("location", loc)
      .eq("id", id)
      .maybeSingle();
    const prev = prevRaw ? (stripLocation(prevRaw) as CsCase) : null;
    if (prev?.inventory_deducted) {
      const { data: prevLinesRaw } = await this.supabase
        .from("cs_case_lines")
        .select("*")
        .eq("location", loc)
        .eq("case_id", id);
      const prevLines = (prevLinesRaw ?? []).map((r) => stripLocation(r) as CsCaseLine);
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
    // Lines cascade-delete via Postgres ON DELETE CASCADE.
    const { error } = await this.supabase
      .from("cs_cases")
      .delete()
      .eq("location", loc)
      .eq("id", id);
    if (error) throw error;
  }

  // ---------- CS Returns ----------

  async listCsReturns(): Promise<CsReturnWithLines[]> {
    const [returnsRes, linesRes] = await Promise.all([
      this.supabase
        .from("cs_returns")
        .select("*")
        .eq("location", this.location)
        .order("created_at", { ascending: false }),
      this.supabase
        .from("cs_return_lines")
        .select("*")
        .eq("location", this.location),
    ]);
    if (returnsRes.error) throw returnsRes.error;
    if (linesRes.error) throw linesRes.error;
    const linesByReturn = new Map<string, CsReturnLine[]>();
    for (const raw of linesRes.data ?? []) {
      const l = stripLocation(raw) as CsReturnLine;
      const arr = linesByReturn.get(l.return_id) ?? [];
      arr.push(l);
      linesByReturn.set(l.return_id, arr);
    }
    return (returnsRes.data ?? []).map((raw) => {
      const r = stripLocation(raw) as CsReturn;
      return { ...r, lines: linesByReturn.get(r.id) ?? [] };
    });
  }

  /**
   * Upsert a return + its lines. Mirrors DexieRepo:
   *   - status='received' first time → set received_at
   *   - status='closed' first time → set closed_at
   *   - Per-line restock credit/reverse: lines with restock=true are
   *     credited to inventory when parent is 'received'; reversed otherwise.
   *     `reverse-all-then-reapply` pattern for bulletproof correctness.
   */
  async upsertCsReturn(r: CsReturn, lines: CsReturnLine[]): Promise<void> {
    const loc = this.location;

    // Fetch previous state.
    const { data: prevRaw } = await this.supabase
      .from("cs_returns")
      .select("*")
      .eq("location", loc)
      .eq("id", r.id)
      .maybeSingle();
    const prev = prevRaw ? (stripLocation(prevRaw) as CsReturn) : null;
    let prevLines: CsReturnLine[] = [];
    if (prev) {
      const { data: prevLinesRaw } = await this.supabase
        .from("cs_return_lines")
        .select("*")
        .eq("location", loc)
        .eq("return_id", r.id);
      prevLines = (prevLinesRaw ?? []).map((row) => stripLocation(row) as CsReturnLine);
    }

    // 1) Reverse all previously-credited lines.
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

    // 2) Apply credit for every line that should be credited now.
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

    // 3) Persist parent.
    const now = new Date().toISOString();
    const next: CsReturn = {
      ...r,
      received_at:
        r.status === "received" && !prev?.received_at ? now : prev?.received_at ?? r.received_at,
      closed_at:
        r.status === "closed" && !prev?.closed_at ? now : prev?.closed_at ?? r.closed_at,
      updated_at: now,
    };
    const { error: parentErr } = await this.supabase
      .from("cs_returns")
      .upsert({ ...next, location: loc }, { onConflict: "location,id" });
    if (parentErr) throw parentErr;

    // 4) Replace lines wholesale.
    const { error: delErr } = await this.supabase
      .from("cs_return_lines")
      .delete()
      .eq("location", loc)
      .eq("return_id", r.id);
    if (delErr) throw delErr;
    if (linesWithFlag.length > 0) {
      const { error: insErr } = await this.supabase
        .from("cs_return_lines")
        .insert(linesWithFlag.map((l) => ({ ...l, location: loc })));
      if (insErr) throw insErr;
    }
  }

  async deleteCsReturn(id: string): Promise<void> {
    const loc = this.location;

    // Reverse any active restock credits before deleting the rows.
    const { data: prevLinesRaw } = await this.supabase
      .from("cs_return_lines")
      .select("*")
      .eq("location", loc)
      .eq("return_id", id);
    const prevLines = (prevLinesRaw ?? []).map((r) => stripLocation(r) as CsReturnLine);
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

    // Lines cascade-delete via Postgres FK ON DELETE CASCADE.
    const { error } = await this.supabase
      .from("cs_returns")
      .delete()
      .eq("location", loc)
      .eq("id", id);
    if (error) throw error;
  }

  /**
   * Walk the BOM graph from each proposed component edge. Returns the cycle
   * path (e.g. "A → B → A") if any descendant references back to `rootId`,
   * else null. Read-only — safe to call before write transactions.
   */
  private async findBomCycle(
    rootId: string,
    proposedComponents: { child_product_id: string; qty_per_unit: number }[],
    maxDepth = 10,
  ): Promise<string | null> {
    const root = await this.getProduct(rootId);
    const rootCode = root?.code ?? rootId;
    for (const direct of proposedComponents) {
      const stack: { id: string; depth: number; ancestorCodes: string[] }[] = [
        { id: direct.child_product_id, depth: 0, ancestorCodes: [rootCode] },
      ];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const { id, depth, ancestorCodes } = stack.pop()!;
        if (id === rootId) return [...ancestorCodes, rootCode].join(" → ");
        if (visited.has(id) || depth > maxDepth) continue;
        visited.add(id);
        // eslint-disable-next-line no-await-in-loop
        const node = await this.getProduct(id);
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
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Strip the `location` column from a fetched row before returning it to the
 * UI. The `location` is an implementation detail of the multi-tenant layout
 * — the rest of the app expects the original Zod shape with no location field.
 *
 * Returns `any` deliberately. supabase-js types row data loosely, and the
 * public repo methods enforce their own concrete return types via their
 * signatures — so loosening this internal helper preserves type safety
 * at the API boundary while keeping the helper ergonomic to call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripLocation(row: any): any {
  if (!row || typeof row !== "object") return row;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { location: _loc, ...rest } = row;
  return rest;
}

/** Same sortable ledger ID format DexieRepo uses. */
function nextLedgerId(): string {
  const ms = Date.now().toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${ms}-${rand}`;
}

/**
 * Inventory-deduction rule for CS cases: deduct only when status is
 * 'shipped' AND a tracking number is set. 'query' is a holding state and
 * must NOT trigger stock movement. Mirrors the DexieRepo function of the
 * same name (the source of truth lives in both repos since they don't
 * share helpers).
 */
function csCaseShouldDeductInventory(c: CsCase): boolean {
  if (c.status !== "shipped") return false;
  if (!c.tracking_number || c.tracking_number.trim() === "") return false;
  return true;
}
