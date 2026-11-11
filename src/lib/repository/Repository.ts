import type {
  Product,
  WeeklySales,
  WeeklyEntry,
  IncomingShipment,
  DemandChangeEvent,
  StorageLayout,
  GlobalSettings,
  Backup,
  PaperUsageEntry,
  LedgerEntry,
  CsCase,
  CsCaseLine,
  CsCaseWithLines,
  CsReturn,
  CsReturnLine,
  CsReturnWithLines,
} from "@/lib/domain";

/**
 * Storage-agnostic repository contract. Dexie/IndexedDB implementation lives
 * in `dexie/DexieRepo.ts`; a Postgres/Supabase implementation can drop in
 * later without touching the UI or the forecasting engine.
 */
export interface Repository {
  // products
  listProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | undefined>;
  upsertProduct(p: Product): Promise<void>;
  deleteProduct(id: string): Promise<void>;
  /**
   * Atomically apply a delta to `current_on_hand`. Used by the auto-adjust
   * pipeline so multiple in-flight sales upserts can't race each other and
   * lose a deduction. Result is clamped at zero.
   *
   * `context` (optional) lets the caller categorize the resulting ledger
   * row. Without it the row is recorded as `reason: "manual"`. Call sites
   * that know they're processing a sale / usage / etc should pass the
   * appropriate reason so the audit trail is meaningful.
   */
  adjustOnHand(
    productId: string,
    delta: number,
    context?: { reason: LedgerEntry["reason"]; source_id?: string | null; note?: string; parent_event_id?: string | null },
  ): Promise<void>;

  // weekly sales (per SKU per week)
  listSales(productId?: string): Promise<WeeklySales[]>;
  upsertSale(s: WeeklySales): Promise<void>;
  bulkUpsertSales(rows: WeeklySales[]): Promise<void>;
  deleteSale(productId: string, isoWeekStart: string): Promise<void>;

  // weekly entries (one ledger; framed/unframed distinction is gone).
  /**
   * List every weekly entry across both departments. Callers filter to the
   * active department at the UI layer (the dataset hook returns the full
   * set so multi-department dashboards can read both if needed later).
   */
  listWeeklyEntries(): Promise<WeeklyEntry[]>;
  upsertWeeklyEntry(e: WeeklyEntry): Promise<void>;
  /** Delete a single weekly entry plus the matching WeeklySales rows.
   *  Department is required — framed and unframed each have their own row
   *  for the same iso_week_start, so the lookup needs both keys.
   *  Pre-v9 callers passing just iso_week_start should default to 'framed'. */
  deleteWeeklyEntry(isoWeekStart: string, department: "framed" | "unframed"): Promise<void>;
  /** Move an entry (and its matching WeeklySales rows) to a new date.
   *  Department is preserved across the rename. */
  renameWeeklyEntry(
    oldIsoWeekStart: string,
    newIsoWeekStart: string,
    department: "framed" | "unframed",
  ): Promise<void>;
  /**
   * Bulk-delete many weekly entries (and their per-SKU sales rows) in a
   * single round-trip. Skips the inventory credit-back / BOM cascade that
   * single-row delete performs, in exchange for ~100x speedup on big
   * selections. Use this when you're cleaning up data you intend to
   * re-import — on_hand will be off by the deleted units_sold until the
   * next sales rewrite. Use single-row deleteWeeklyEntry when you need
   * the cascade.
   */
  bulkDeleteWeeklyEntries(
    weeks: Array<{ iso_week_start: string; department: "framed" | "unframed" }>,
  ): Promise<{ entries: number; sales: number }>;

  // shipments
  listShipments(productId?: string): Promise<IncomingShipment[]>;
  upsertShipment(s: IncomingShipment): Promise<void>;
  deleteShipment(id: string): Promise<void>;

  // demand events
  listDemandEvents(): Promise<DemandChangeEvent[]>;
  upsertDemandEvent(e: DemandChangeEvent): Promise<void>;
  deleteDemandEvent(id: string): Promise<void>;

  // storage layout
  getStorage(): Promise<StorageLayout>;
  setStorage(s: StorageLayout): Promise<void>;

  // global settings
  getSettings(): Promise<GlobalSettings>;
  setSettings(s: GlobalSettings): Promise<void>;

  // backup
  exportBackup(): Promise<Backup>;
  importBackup(b: Backup): Promise<void>;
  wipe(): Promise<void>;

  /**
   * Delete "ghost" WeeklyEntry rows — entries with no `total_orders`, no
   * name, not flagged reference, and no WeeklySales attached. Used by the
   * Settings cleanup button.
   */
  deleteEmptyWeeklyEntries(): Promise<{ deleted: number }>;

  // paper usage history (one persisted snapshot per week)
  listPaperUsage(): Promise<PaperUsageEntry[]>;
  upsertPaperUsage(e: PaperUsageEntry): Promise<void>;
  deletePaperUsage(isoWeekStart: string): Promise<void>;

  // ---------- Inventory ledger (Phase 1: write-only) ----------
  /**
   * List ledger rows, optionally filtered by product. Sorted by `ts` desc
   * by default. Returns at most `limit` rows when supplied (used for the
   * SKU-detail audit panel which only needs recent activity).
   */
  listLedger(productId?: string, limit?: number): Promise<LedgerEntry[]>;

  // ---------- CS Cases (customer service replacements) ----------
  /**
   * List all cases for this location, with their lines pre-joined. Sorted
   * by created_at desc. Used by the kanban / table views on the CS Cases
   * page. Volume isn't expected to exceed ~50/month, so no pagination yet.
   */
  listCsCases(): Promise<CsCaseWithLines[]>;
  /**
   * Insert or update a case + replace its lines atomically. The repo
   * detects status transitions to/from "shipped+tracking_number" and
   * fires inventory deductions via adjust_on_hand with reason="replacement".
   */
  upsertCsCase(c: CsCase, lines: CsCaseLine[]): Promise<void>;
  /**
   * Delete a case. If the case had previously deducted inventory (status
   * 'shipped' with tracking), the lines are credited back to inventory
   * before removal so on-hand isn't left artificially low.
   */
  deleteCsCase(id: string): Promise<void>;

  // ---------- CS Returns (customer returns — inbound) ----------
  /**
   * List all returns for this location, with their lines pre-joined. Sorted
   * by created_at desc. Used by the Returns kanban / list views. v1 does
   * not auto-adjust inventory when a return is marked received, so this is
   * purely a tracking surface.
   */
  listCsReturns(): Promise<CsReturnWithLines[]>;
  /**
   * Insert or update a return + replace its lines atomically. Auto-sets
   * `received_at` when status first becomes 'received', and `closed_at`
   * when status first becomes 'closed'.
   */
  upsertCsReturn(r: CsReturn, lines: CsReturnLine[]): Promise<void>;
  /** Delete a return. Lines cascade-delete via the composite FK. */
  deleteCsReturn(id: string): Promise<void>;
}
