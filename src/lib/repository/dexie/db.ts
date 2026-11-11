import Dexie, { type Table } from "dexie";
import type {
  Product, WeeklySales, WeeklyEntry, IncomingShipment, DemandChangeEvent,
  Bay, PalletAssignment, GlobalSettings, LocationKey, PaperUsageEntry,
  LedgerEntry, CsCase, CsCaseLine, CsReturn, CsReturnLine,
  StaffBarcode, StaffRate, ProductionEvent, ProductionSizeEffort,
  ProductionBenchmark,
} from "@/lib/domain";

/**
 * IndexedDB schema. Each location ("default", "uk", "us", "au") gets its own
 * isolated Dexie database — fully separate datasets.
 */
export class StockDB extends Dexie {
  products!: Table<Product, string>;
  weeklySales!: Table<WeeklySales & { id: string }, string>;
  /**
   * Framed-department weekly entries. PK is `iso_week_start`.
   *
   * Why not a compound `[department, iso_week_start]` key? Dexie doesn't
   * support changing an existing table's primary key during an upgrade
   * ("Not yet support for changing primary key" is the literal error it
   * throws), and we have to ship to existing browsers with this DB already
   * created. So we split the data by table instead: framed rows here,
   * unframed rows in `weeklyEntriesUnframed`. Each row also carries a
   * `department` field — redundant in Dexie but kept to match the
   * Supabase schema and keep the Zod model uniform.
   */
  weeklyEntries!: Table<WeeklyEntry, string>;
  /** Unframed-department weekly entries. Added in v4 — starts empty. */
  weeklyEntriesUnframed!: Table<WeeklyEntry, string>;
  shipments!: Table<IncomingShipment, string>;
  demandEvents!: Table<DemandChangeEvent, string>;
  bays!: Table<Bay, string>;
  palletAssignments!: Table<PalletAssignment, string>;
  settings!: Table<GlobalSettings & { id: "global" }, string>;
  /** Persisted snapshots of weekly paper-roll consumption. Keyed by iso_week_start. */
  paperUsage!: Table<PaperUsageEntry, string>;
  /**
   * Append-only inventory ledger. Every stock movement (sale, shipment,
   * usage snapshot, manual adjustment) writes a row here. Phase 1 of the
   * ledger rollout — rows are written but not yet read for correctness.
   */
  ledger!: Table<LedgerEntry, string>;
  /** CS Cases — customer service replacements / complaints (v7). */
  csCases!: Table<CsCase, string>;
  csCaseLines!: Table<CsCaseLine, string>;
  /** CS Returns — customer-initiated returns (v8). */
  csReturns!: Table<CsReturn, string>;
  csReturnLines!: Table<CsReturnLine, string>;
  /** Production / Order Submission tables (v10). All keyed by their own
   *  single primary key — Dexie compound-key change is forbidden mid-life,
   *  so we use natural single keys. */
  staffBarcodes!: Table<StaffBarcode, string>;
  staffRates!: Table<StaffRate, string>;
  productionEvents!: Table<ProductionEvent, string>;
  productionSizeEffort!: Table<ProductionSizeEffort, string>;
  productionBenchmarks!: Table<ProductionBenchmark, string>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      products: "id, code, size, colour, supplier",
      weeklySales: "id, product_id, iso_week_start",
      shipments: "id, product_id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
    });
    this.version(2).stores({
      products: "id, code, size, colour, supplier",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      shipments: "id, product_id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
    });
    this.version(3).stores({
      // Drop product_id from shipments index since it's now multi-line.
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
    });
    // v4: split unframed-department entries into their own table. Existing
    // weeklyEntries stays untouched (treated as framed). The new table
    // starts empty and is purely additive — no data migration needed.
    this.version(4).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
    });
    // v5: paperUsage table for the Paper Usage page's persisted snapshots.
    // Additive — older data is untouched; the table starts empty.
    this.version(5).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
    });
    // v6: append-only inventory ledger. Indexed by product_id (per-SKU
    // history queries), ts (time-range queries), source_id (reversal
    // lookups by originating event), and reason (filter by movement type).
    // Additive — existing data is untouched; ledger starts empty and
    // future inventory movements append a row.
    this.version(6).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
      ledger: "id, product_id, ts, source_id, reason",
    });
    // v7: CS Cases (replacements + complaints + customer service).
    // Two new tables: csCases (parent rows) and csCaseLines (line items).
    // Additive — both start empty, existing data untouched.
    this.version(7).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
      ledger: "id, product_id, ts, source_id, reason",
      csCases: "id, status, created_at, order_number, issue_type",
      csCaseLines: "id, case_id, product_id",
    });
    // v8: CS Returns — inbound customer returns. Two new tables, both
    // additive. Inventory is NOT auto-adjusted when a return is received
    // (intentional; future versions can add a restock-on-receive toggle).
    this.version(8).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
      ledger: "id, product_id, ts, source_id, reason",
      csCases: "id, status, created_at, order_number, issue_type",
      csCaseLines: "id, case_id, product_id",
      csReturns: "id, status, created_at, order_number, expected_return_date",
      csReturnLines: "id, return_id, product_id",
    });
    // v9: Department split — Dexie edition.
    //
    // Dexie can't change a primary key in an upgrade, so we keep
    // weeklyEntries' PK as `iso_week_start` and store unframed rows in
    // the sibling table weeklyEntriesUnframed (which has existed since v4,
    // just dormant). The DexieRepo layer routes reads/writes based on
    // entry.department.
    //
    // The schema string for weeklyEntries is intentionally identical to v8
    // — Dexie sees "no schema change" and just runs the upgrade callback.
    // The callback backfills department='framed' on legacy rows so the
    // application code can rely on the field being present.
    //
    // Note: Supabase has a single weekly_entries table with a composite
    // (location, department, iso_week_start) primary key. The two storage
    // engines diverge internally but expose the same Repository interface.
    this.version(9).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
      ledger: "id, product_id, ts, source_id, reason",
      csCases: "id, status, created_at, order_number, issue_type",
      csCaseLines: "id, case_id, product_id",
      csReturns: "id, status, created_at, order_number, expected_return_date",
      csReturnLines: "id, return_id, product_id",
    }).upgrade(async (tx) => {
      // Backfill department on legacy rows. Anything pre-v9 was framed.
      await tx.table("weeklyEntries").toCollection().modify((e) => {
        if (!e.department) e.department = "framed";
      });
      // Defensive: tag the (so far empty) unframed table's rows too,
      // in case anyone manually wrote data into it in a previous build.
      await tx.table("weeklyEntriesUnframed").toCollection().modify((e) => {
        if (!e.department) e.department = "unframed";
      });
    });
    // v10: Production / Order Submission. Five new tables, all additive,
    // all keyed by simple PKs to avoid the compound-key upgrade trap.
    //   staffBarcodes        — barcode → user mapping
    //   staffRates           — per-user hourly rate
    //   productionEvents     — append-only event log
    //   productionSizeEffort — size-weighted volume scoring
    //   productionBenchmarks — estimated-time targets
    this.version(10).stores({
      products: "id, code, size, colour, supplier, display_order",
      weeklySales: "id, product_id, iso_week_start",
      weeklyEntries: "iso_week_start, is_reference",
      weeklyEntriesUnframed: "iso_week_start, is_reference",
      shipments: "id, status, expected_arrival_date, actual_arrival_date",
      demandEvents: "id, product_id, start_date, end_date",
      bays: "id, row, column",
      palletAssignments: "id, bay_id, product_id, slot_index",
      settings: "id",
      paperUsage: "iso_week_start",
      ledger: "id, product_id, ts, source_id, reason",
      csCases: "id, status, created_at, order_number, issue_type",
      csCaseLines: "id, case_id, product_id",
      csReturns: "id, status, created_at, order_number, expected_return_date",
      csReturnLines: "id, return_id, product_id",
      // Production tables. `staffBarcodes.barcode` is the PK (8-char hex
      // token). `staffRates.user_id` is the PK (one rate per user).
      // Events get a synthetic id; we index on staff_id, order_number,
      // department, and created_at so reports stay snappy.
      staffBarcodes: "barcode, user_id, active",
      staffRates: "user_id",
      productionEvents: "id, staff_id, order_number, department, line_sku, created_at, event_type",
      productionSizeEffort: "size",
      // Composite key encoded as `${product_id}__${department}` for
      // single-PK simplicity (Dexie's compound-key change is irreversible).
      productionBenchmarks: "id, product_id, department",
    });
  }
}

export function salesRowId(productId: string, isoWeek: string): string {
  return `${productId}__${isoWeek}`;
}

const DB_NAME_PREFIX = "inkaar-stock";

/** Convert a location key into a Dexie database name. */
export function dbNameForLocation(loc: LocationKey): string {
  return loc === "default" ? DB_NAME_PREFIX : `${DB_NAME_PREFIX}-${loc}`;
}

const _instances = new Map<string, StockDB>();
/** Reuse a singleton per location so multiple components share the same connection. */
export function getDb(loc: LocationKey = "default"): StockDB {
  const name = dbNameForLocation(loc);
  let db = _instances.get(name);
  if (!db) {
    db = new StockDB(name);
    _instances.set(name, db);
  }
  return db;
}
