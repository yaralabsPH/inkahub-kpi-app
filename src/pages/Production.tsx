import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Settings as SettingsIcon, LogOut, ScanLine,
  Play, Check, X as XIcon,
} from "lucide-react";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAppStore } from "@/lib/state/appStore";
import {
  loadStationConfig, saveStationConfig, clearStationConfig,
  type StationConfig,
} from "@/lib/state/productionStation";
import {
  routeSkuToDepartment,
  isSkuProductionRelevant,
  isSkuVerifiable,
  isLineMyDept,
  describeSku,
  skuTypeBadge,
  variantChipClass,
  friendlySize,
  friendlyVariant,
  parseSku,
  detectOrientation,
  shouldDeductAtDept,
  routeShopifyLineToCatalogueLines,
  PACKAGE_TYPES,
  packageFromShortcut,
  packageFromBarcode,
  autoMailTubeForUnframedOrder,
  stationRequiresPackages,
  MAIL_TUBE_LABELS,
  PRODUCTION_DEPARTMENT_LABELS,
  LOCATION_LABELS,
  lineProductionDepartment,
  type LocationKey,
  type Product,
  type ProductionDepartment,
} from "@/lib/domain";
import { cn } from "@/lib/utils/cn";
import { ProductionCountStatus } from "@/components/ProductionCountStatus";
import { useProductionEvidence, type ProductionEvidenceState } from "@/lib/hooks/useProductionSummary";
import { isReportSite, productionDateAt, productionRange } from "@/lib/domain/productionPeriods";
import { buildProductionCounterView, type ProductionCounterView } from "@/lib/domain/productionCounterView";
import { snapshotCovers, type WorkType } from "@/lib/domain/productionCounts";
import { OrderNotesPanel } from "@/components/OrderNotesPanel";
import { Modal } from "@/components/ui/Modal";

/**
 * Production / Order Submission tablet page.
 *
 * Lives at `/production`, outside the standard app shell — no sidebar,
 * no topbar. The page binds itself to one department on first load via
 * a localStorage station config, then runs an idle ↔ active loop:
 *
 *   Idle    — large "Scan your lanyard" prompt. Hidden input captures
 *             barcode-scanner keystrokes. A successful lanyard scan
 *             flips to Active mode with that staff member.
 *
 *   Active  — staff name + today's stats + an order-scan input. The
 *             actual order-scan logic + Start/Complete events land in
 *             task #94; this slice ships the shell only.
 *
 * Auto-switch: any subsequent lanyard scan replaces the active staff.
 * Idle timeout: 30 minutes of no events → return to idle.
 *
 * Hardware: USB barcode scanners act as keyboards. We capture every
 * keypress while no other input is focused, accumulate into a buffer,
 * and treat Enter (the terminator most scanners send) as the trigger.
 */

const IDLE_TIMEOUT_MS = 60 * 1000; // 60s for kiosk between-worker handoff

interface ActiveStaff {
  user_id: string;
  display_name: string;
}

/**
 * One line of a fetched Shopify order, after we've matched it against
 * our product catalogue and routed to the active department.
 */
interface OrderLine {
  sku: string;          // Shopify SKU as scanned
  title: string;        // Human title from Shopify
  quantity: number;     // Quantity of this SKU in the order
  product: Product | null; // Matched against our catalogue, null if no match
  // Phase 4: routing + verification context
  dept: ProductionDepartment | null;
  belongsToThisDept: boolean;
  // Legacy fallback: Shopify variant title ("A4 21x30 cm / Framed Print
  // (Black)") used to describe pre-v6 SKUs that don't encode size/variant.
  variantTitle: string | null;
}

interface CurrentOrder {
  number: string;       // Raw order number without "#"
  display_name: string; // With "#" for human display
  /** Lines that belong to THIS department. Others stripped at fetch time. */
  lines: OrderLine[];
  /** Total lines on the order across all departments — to show "3 of 5 lines for your department". */
  total_lines: number;
  /** Shopify cancelledAt (ISO) when the order is cancelled; null otherwise. */
  cancelled_at: string | null;
  /** Cancellation reason if cancelled; null otherwise. */
  cancel_reason: string | null;
}

/**
 * Per-line state machine on the bench. "idle" = waiting to start.
 * "started" = clock running. "completed" = done.
 */
type LineState = "idle" | "started" | "completed";

interface LineRecord {
  state: LineState;
  /** Date.now() at Start, for live timer + duration on Complete. */
  started_at?: number;
  completed_at?: number;
}

/** A line key combining order number + SKU — used as the Map key. */
/**
 * Insert a one-off "auto-tag" order_note for an order if no matching
 * auto-note already exists. Idempotent: looks for the [auto-tag:KEY]
 * sentinel string in existing note bodies for that order to avoid
 * duplicating on re-scan.
 */
async function ensureAutoTagNote(
  supabase: ReturnType<typeof getSupabase>,
  location: string,
  orderNumber: string,
  author: { user_id: string; display_name: string },
  tagKey: string,
  body: string,
): Promise<void> {
  try {
    const sentinel = "[auto-tag:" + tagKey + "]";
    const { data } = await supabase
      .from("order_notes")
      .select("id, body")
      .eq("location", location)
      .eq("order_number", orderNumber);
    const already = (data ?? []).some((n: { body?: string | null }) =>
      typeof n.body === "string" && n.body.includes(sentinel),
    );
    if (already) return;
    await supabase.from("order_notes").insert([{
      id: crypto.randomUUID(),
      location,
      order_number: orderNumber,
      staff_id: author.user_id,
      staff_display_name: "Auto-flag (" + tagKey + ")",
      body,
      resolved: false,
    }]);
  } catch {
    // Swallow - this is a non-critical UX nicety, not a blocker.
  }
}

function lineKey(order: string, sku: string): string {
  return `${order}__${sku}`;
}

/** Compact human duration: "12s" / "3m 27s" / "1h 4m". */
function fmtDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec - min * 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const mn = min - hr * 60;
  return `${hr}h ${mn}m`;
}

/** Random 16-char id for production_event PKs. */
function nextEventId(): string {
  const ms = Date.now().toString().padStart(13, "0");
  const rnd = Math.random().toString(36).slice(2, 8).padStart(6, "0");
  return `${ms}-${rnd}`;
}

export function Production() {
  // Supabase-only — the production page reads staff data that only exists
  // in Supabase mode. Dexie mode is the local dev fallback; if someone
  // lands here without auth, redirect them home.
  if (getBackendMode() !== "supabase") {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 p-8 text-center">
        Production tab requires Supabase mode (your local dev environment isn't set up for it).
      </div>
    );
  }

  // Station config — department + optional label. If absent, show the picker.
  const [station, setStation] = useState<StationConfig | null>(() => loadStationConfig());
  const [activeStaff, setActiveStaff] = useState<ActiveStaff | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const handlePickStation = (cfg: StationConfig) => {
    saveStationConfig(cfg);
    setStation(cfg);
  };

  // Department wasn't set, or operator clicked the gear → show the picker.
  if (!station || showSettings) {
    return (
      <DepartmentPicker
        current={station}
        onPick={(cfg) => { handlePickStation(cfg); setShowSettings(false); }}
        onClose={station ? () => setShowSettings(false) : undefined}
        onReset={station ? () => {
          clearStationConfig();
          setStation(null);
          setActiveStaff(null);
          setShowSettings(false);
        } : undefined}
      />
    );
  }

  return (
    <ProductionStation
      station={station}
      activeStaff={activeStaff}
      onSetActiveStaff={setActiveStaff}
      scanError={scanError}
      onScanError={setScanError}
      onOpenSettings={() => setShowSettings(true)}
    />
  );
}

// ============================================================
// Station shell — wraps idle/active, owns scan capture + timeout.
// ============================================================

function ProductionStation({
  station, activeStaff, onSetActiveStaff, scanError, onScanError, onOpenSettings,
}: {
  station: StationConfig;
  activeStaff: ActiveStaff | null;
  onSetActiveStaff: (s: ActiveStaff | null) => void;
  scanError: string | null;
  onScanError: (s: string | null) => void;
  onOpenSettings: () => void;
}) {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const auth = useAuthOptional();
  const { data: dataset } = useDataset();
  const [scanBuffer, setScanBuffer] = useState("");
  const [busy, setBusy] = useState(false);
  const lastActivityRef = useRef<number>(Date.now());
  // In-flight guard against duplicate line_verified writes. Records line
  // keys whose insertEvent is currently awaiting. Synchronous check at
  // top of handleVerifyLine blocks rapid double-taps from creating two
  // events for the same SKU/order/dept.
  const verifyingKeysRef = useRef<Set<string>>(new Set());
  // Order numbers the worker just confirmed to re-process from a
  // preflight warning. The next verifiedLines fetch for that order
  // starts empty (fresh state) so the worker has to physically re-
  // verify at least one line before the Complete guard is satisfied.
  const resendOrderRef = useRef<Set<string>>(new Set());
  // Mirror of verifiedLines that updates synchronously in every state
  // setter path. handleCompleteOrder reads from this ref so a fast
  // verify -> Complete tap doesn't see a stale empty map from a
  // closure that hasn't been rebuilt yet.
  const verifiedLinesRef = useRef<Map<string, unknown>>(new Map());
  // Order + line tracking state. Cleared when the active staff changes.
  const [currentOrder, setCurrentOrder] = useState<CurrentOrder | null>(null);

  const [lineStates, setLineStates] = useState<Map<string, LineRecord>>(new Map());
  /** A 1-second tick to drive live timers on started lines. */
  const [tick, setTick] = useState(0);
  /**
   * Today's counter for the active worker (F1): read from saved evidence for
   * the site's production day, never incremented locally. Every successful
   * save calls refreshCounter() without awaiting it, so capture and stock
   * deduction never wait on reporting.
   */
  const counterSite = isReportSite(location) ? location : null;
  const [dayTick, setDayTick] = useState(0);
  const counterDate = useMemo(
    () => (counterSite ? productionDateAt(new Date(), counterSite) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counterSite, dayTick],
  );
  const counterRange = useMemo(
    () => (counterSite && counterDate ? productionRange(counterSite, counterDate, counterDate) : null),
    [counterSite, counterDate],
  );
  // Roll over at the next site-local 04:00 (re-checked at most every 5 minutes).
  useEffect(() => {
    if (!counterRange) return;
    const ms = Math.max(1_000, Math.min(Date.parse(counterRange.endUtcExclusive) - Date.now() + 1_000, 5 * 60_000));
    const t = setTimeout(() => setDayTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [counterRange, dayTick]);
  // Returning to the page re-derives the production date first, then refreshes it.
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") setDayTick((n) => n + 1);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
  const counterEvidence = useProductionEvidence({ client: supabase, site: location, range: counterRange, refreshKey: dayTick });
  const refreshCounter = counterEvidence.refresh;
  // A worker/station/day switch only shows counts read after the switch:
  // the previous worker's numbers are never shown for the next one.
  const counterKey = activeStaff && counterDate ? `${activeStaff.user_id}|${station.department}|${counterDate}` : "";
  const counterSince = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  if (counterSince.current.key !== counterKey) counterSince.current = { key: counterKey, at: Date.now() };
  const counterSinceAt = counterSince.current.at;
  useEffect(() => {
    if (counterKey) refreshCounter();
  }, [counterKey, refreshCounter]);
  const counter = useMemo(() => {
    const snap = counterEvidence.snapshot;
    if (!activeStaff || !counterSite || !counterDate || !counterEvidence.prepared || !snap) return null;
    if (!snapshotCovers(snap, counterRange)) return null;
    if (Date.parse(snap.asOfUtc) < counterSinceAt) return null;
    return buildProductionCounterView(counterEvidence.prepared, {
      site: counterSite,
      date: counterDate,
      staffId: activeStaff.user_id,
      workType: station.department as WorkType,
    });
  }, [counterEvidence.prepared, counterEvidence.snapshot, activeStaff, counterSite, counterDate, counterRange, station.department, counterSinceAt]);
  /** Dispatch confirmation flash — order # that was just dispatched. */
  const [dispatchFlash, setDispatchFlash] = useState<string | null>(null);
  /**
   * Package selection state for this scan session. Map<package_code -> qty>.
   * - At a0_framed + dispatch: workers scan the BOX BARCODE on the side
   *   of each package (e.g. +48= = A0 Double). Each scan = +1 box of that type.
   * - At unframed: auto-populated with the mail tube id on order load.
   * - At framed: not used (framed never closes an order directly).
   */
  const [packages, setPackages] = useState<Map<string, number>>(new Map());
  // Phase 2: promise-based confirm dialog. preflightScan sets this record,
  // the modal renders, the user's click resolves the promise.
  // Phase 4: per-line verification state.
  // verifiedLines: keyed by lineKey(orderNum, sku) -> who verified + when.
  // Populated on scan from prior line_verified events, mutated on tap.
  const [verifiedLines, setVerifiedLines] = useState<Map<string, {
    event_id: string;
    staff_id: string;
    dept: string;
    time: string;
  }>>(new Map());
  // Active CS Case id - set when the preflight modal's replacement
  // variant is accepted. Tagged onto every line_verified event so
  // replacement work is auditably tied to its case.
  // Phase 5: full case object (not just id) so the REPLACEMENT banner can
  // show issue + urgency + customer name without re-querying.
  const [activeCase, setActiveCase] = useState<{
    caseId: string;
    issueType: string;
    urgency: string;
    customerName: string | null;
  } | null>(null);
  // Cached staff_id -> display_name for the verifier-name labels.
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [editOrderWarning, setEditOrderWarning] = useState<{ orderNumber: string } | null>(null);
  const [pendingPreflight, setPendingPreflight] = useState<{
    title: string;
    message: string;
    resolve: (proceed: boolean) => void;
    // Phase 3: when set, the modal renders the replacement-work variant
    // (blue panel + 'Start replacement' CTA + case details surfaced).
    caseInfo?: {
      caseId: string;
      issueType: string;
      urgency: string;
      customerName: string | null;
    } | null;
  } | null>(null);

  // Auto-assign mail tube at unframed station based on order contents.
  // Runs whenever the current order changes. Cleared when order clears.
  useEffect(() => {
    if (!currentOrder) return;
    if (station.department !== "unframed") return;
    const skus = currentOrder.lines.map((l) => l.sku);
    const tubeId = autoMailTubeForUnframedOrder(skus);
    if (tubeId) {
      setPackages((m) => {
        if (m.has(tubeId)) return m; // already set
        const next = new Map(m);
        next.set(tubeId, 1);
        return next;
      });
    }
  }, [currentOrder, station.department]);
  // Phase 5: when an order loads, fetch line_verified + cancelled events,
  // filter out verifies that have been cancelled, and resolve the verifier
  // display names via staff_barcodes.
  useEffect(() => {
    if (!currentOrder) {
      verifiedLinesRef.current = new Map();
      setVerifiedLines(new Map());
      setStaffNames(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("production_events")
        .select("id, parent_event_id, event_type, staff_id, department, line_sku, created_at")
        .eq("location", location)
        .eq("order_number", currentOrder.number)
        .eq("department", station.department)
        .in("event_type", ["line_verified", "cancelled"])
        .order("created_at", { ascending: true });
      if (cancelled || error || !data) return;

      // Any verify whose id appears as a parent_event_id of a
      // cancelled event is considered un-verified.
      const cancelledIds = new Set<string>();
      for (const row of data) {
        if (row.event_type === "cancelled" && row.parent_event_id) {
          cancelledIds.add(row.parent_event_id as string);
        }
      }

      const map = new Map<string, { event_id: string; staff_id: string; dept: string; time: string }>();
      const staffIds = new Set<string>();
      for (const row of data) {
        if (row.event_type !== "line_verified") continue;
        if (cancelledIds.has(row.id as string)) continue;
        const sku = row.line_sku as string | null;
        if (!sku) continue;
        map.set(lineKey(currentOrder.number, sku), {
          event_id: row.id as string,
          staff_id: row.staff_id as string,
          dept: row.department as string,
          time: row.created_at as string,
        });
        staffIds.add(row.staff_id as string);
      }
      // If the worker just confirmed a resend for this order, wipe the
      // prior verifies so the "verify at least one before Complete"
      // guard actually bites. One-shot: clear the ref after applying.
      if (resendOrderRef.current.has(currentOrder.number)) {
        resendOrderRef.current.delete(currentOrder.number);
        verifiedLinesRef.current = new Map();
        setVerifiedLines(new Map());
      } else {
        verifiedLinesRef.current = map as unknown as Map<string, unknown>;
        setVerifiedLines(map);
      }

      // Resolve verifier names (cached in staffNames map).
      if (staffIds.size > 0) {
        const { data: barcodes } = await supabase
          .from("staff_barcodes")
          .select("user_id, display_name")
          .eq("location", location)
          .in("user_id", Array.from(staffIds));
        if (cancelled) return;
        const names = new Map<string, string>();
        for (const r of barcodes ?? []) {
          names.set(r.user_id as string, r.display_name as string);
        }
        setStaffNames(names);
      }
    })();
    return () => { cancelled = true; };
  }, [currentOrder, location, supabase, station.department]);

  // When the active staff changes, reset all order state (different worker,
  // different in-progress lines). The counter refreshes through counterKey.
  useEffect(() => {
    setCurrentOrder(null);
    setLineStates(new Map());
    setDispatchFlash(null);
  }, [activeStaff, supabase, location, station.department]);

  // Live timer — re-render every second while any line is "started" so
  // the timer chips count up.
  useEffect(() => {
    const anyRunning = Array.from(lineStates.values()).some((s) => s.state === "started");
    if (!anyRunning) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [lineStates]);
  void tick;

  /**
   * Fetch a Shopify order via the existing /api/shopify/order endpoint
   * (same one CS Cases uses), match each line against our product
   * catalogue, and filter to lines belonging to this station's
   * department. Returns null on error (caller surfaces the message).
   */
  const fetchOrder = useCallback(async (orderNumber: string): Promise<CurrentOrder | null> => {
    // Always read a FRESH session at call time. Supabase auto-refreshes the
    // JWT inside getSession() if its expiry is near, so a long-running kiosk
    // session won't send a stale token.
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token ?? null;
    if (!token) {
      onScanError("Session expired or not signed in to Inka Hub. Please refresh the page (Ctrl+F5) and try again.");
      return null;
    }
    if (!dataset) {
      onScanError("Product catalogue still loading — try again in a second.");
      return null;
    }
    try {
      const res = await fetch(
        `/api/shopify/order?order_number=${encodeURIComponent(orderNumber)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const body = (await res.json()) as {
        found?: boolean;
        order_name?: string;
        line_items?: Array<{ sku: string | null; title: string | null; quantity: number; variant_title?: string | null }>;
        cancelled_at?: string | null;
        cancel_reason?: string | null;
        tags?: string[];
        error?: string;
      };
      if (!res.ok || !body.found) {
        onScanError(body.error || `Order #${orderNumber} not found in Shopify`);
        return null;
      }
      const allLines = body.line_items ?? [];
      // Auto-flag notes from Shopify tags. Fire-and-forget so it does NOT
      // block the scan; the worker may see the note appear a moment later.
      const tags = body.tags ?? [];
      if (tags.includes("NZ-HighValue") && activeStaff) {
        void ensureAutoTagNote(
          supabase,
          location,
          orderNumber,
          activeStaff,
          "NZ-HighValue",
          "NZ-HighValue tag detected in Shopify - handle with extra care. [auto-tag:NZ-HighValue]",
        );
      }
      // Manager-check tags: "Edit Order" (Shopify default) and
      // "oe-staff-edit" (Order Editor app tag). Treat both identically -
      // popup at framing stations + auto-note paper trail. Dispatch is
      // unaffected since the manager check happens upstream.
      const EDIT_TRIGGER_TAGS = ["Edit Order", "oe-staff-edit"];
      const editTrigger = EDIT_TRIGGER_TAGS.find((t) => tags.includes(t));
      if (editTrigger) {
        const isFramingDept = station.department === "a0_framed"
          || station.department === "framed"
          || station.department === "unframed";
        if (isFramingDept) {
          setEditOrderWarning({ orderNumber });
        }
        if (activeStaff) {
          void ensureAutoTagNote(
            supabase,
            location,
            orderNumber,
            activeStaff,
            editTrigger,
            editTrigger + " tag - check with a manager that this order is correct, edits applied. [auto-tag:" + editTrigger + "]",
          );
        }
      }
      // Phase 4: keep ALL lines, tag each with its dept + belongsToThisDept flag.
      // The UI handles which ones the current station can interact with.
      const matched: OrderLine[] = [];
      for (const it of allLines) {
        const sku = (it.sku ?? "").trim();
        if (!sku) continue;
        const product = dataset.products.find(
          (p) => p.code.trim().toLowerCase() === sku.toLowerCase(),
        ) ?? null;
        // Compute the line dept. Try catalogue first, fall back to SKU
        // pattern routing so new INKA-XXXNNNN-SIZE-FRAME SKUs route
        // correctly even before they land in the catalogue.
        let lineDept: ProductionDepartment | null = product
          ? lineProductionDepartment(product)
          : null;
        if (lineDept === null) {
          const routed = routeSkuToDepartment(sku);
          if (routed === "a0_framed" || routed === "framed" || routed === "unframed") {
            lineDept = routed as ProductionDepartment;
          }
        }
        // belongsToThisDept now reflects "directly actioning" per the
        // station-specific routing rules. Gift cards belong to no station;
        // dispatch handles everything else; framed picks up mixed orders
        // end-to-end (except A0 framed); A0 framed + unframed handle their
        // own scope. AUX items follow each station's rule.
        const belongsToThisDept = isLineMyDept(sku, station.department);
        matched.push({
          sku,
          title: it.title ?? "",
          quantity: it.quantity > 0 ? it.quantity : 1,
          product,
          dept: lineDept,
          belongsToThisDept,
          variantTitle: it.variant_title ?? null,
        });
      }
      return {
        number: orderNumber,
        display_name: body.order_name ?? `#${orderNumber}`,
        lines: matched,
        total_lines: allLines.length,
        cancelled_at: body.cancelled_at ?? null,
        cancel_reason: body.cancel_reason ?? null,
      };
    } catch (e) {
      onScanError(`Couldn't reach Shopify: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }, [auth, dataset, station.department, onScanError]);

  /** Insert a production_event row. Returns the inserted row's id. */
  const insertEvent = useCallback(async (args: {
    staff_id: string;
    order_number: string;
    line_sku: string | null;
    line_quantity: number | null;
    event_type: "started" | "completed" | "cancelled" | "dispatched" | "line_verified";
    note?: string;
    cs_case_id?: string | null;
    parent_event_id?: string | null;
  }): Promise<string | null> => {
    const id = nextEventId();
    const { error } = await supabase.from("production_events").insert({
      id,
      location,
      staff_id: args.staff_id,
      department: station.department,
      order_number: args.order_number,
      line_sku: args.line_sku,
      line_quantity: args.line_quantity,
      event_type: args.event_type,
      station_id: station.station_id,
      note: args.note ?? "",
      created_at: new Date().toISOString(),
      cs_case_id: args.cs_case_id ?? null,
      parent_event_id: args.parent_event_id ?? null,
    });
    if (error) {
      onScanError(`Couldn't save event: ${error.message}`);
      return null;
    }
    return id;
  }, [supabase, location, station, onScanError]);

  // Phase 5: un-verify a line. Inserts a `cancelled` event whose
  // parent_event_id points at the original line_verified, then drops
  // the row from the local map. Both events stay in the log forever
  // for the audit chain.
  const handleUnverifyLine = useCallback(async (line: OrderLine) => {
    if (!activeStaff || !currentOrder) return;
    const key = lineKey(currentOrder.number, line.sku);
    const rec = verifiedLines.get(key);
    if (!rec) return;
    const inserted = await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: line.sku,
      line_quantity: line.quantity,
      event_type: "cancelled",
      parent_event_id: rec.event_id,
      note: "Un-verify from /production",
    });
    if (!inserted) return;
    setVerifiedLines((m) => {
      const next = new Map(m);
      next.delete(key);
      verifiedLinesRef.current = next as unknown as Map<string, unknown>;
      return next;
    });
    // Saved: re-read the counter (the saved parent's value is removed by the shared rules).
    refreshCounter();
    lastActivityRef.current = Date.now();
  }, [activeStaff, currentOrder, verifiedLines, insertEvent, refreshCounter]);

  // Phase 4: tap-to-verify. Writes a line_verified event tagged with
  // activeCaseId (when present) and updates local map for instant UI.
  const handleVerifyLine = useCallback(async (line: OrderLine) => {
    if (!activeStaff || !currentOrder) return;
    if (!line.belongsToThisDept) return;
    const key = lineKey(currentOrder.number, line.sku);
    if (verifiedLines.has(key)) return; // already verified
    // In-flight guard: rapid double-taps both pass verifiedLines.has
    // before either insertEvent await resolves and setVerifiedLines runs.
    // Block the second one at the synchronous level.
    if (verifyingKeysRef.current.has(key)) return;
    verifyingKeysRef.current.add(key);
    let inserted: string | null = null;
    try {
      inserted = await insertEvent({
        staff_id: activeStaff.user_id,
        order_number: currentOrder.number,
        line_sku: line.sku,
        line_quantity: line.quantity,
        event_type: "line_verified",
        cs_case_id: activeCase?.caseId ?? null,
      });
    } finally {
      verifyingKeysRef.current.delete(key);
    }
    if (!inserted) return;
    setVerifiedLines((m) => {
      const next = new Map(m);
      next.set(key, {
        event_id: inserted,
        staff_id: activeStaff.user_id,
        dept: station.department,
        time: new Date().toISOString(),
      });
      verifiedLinesRef.current = next as unknown as Map<string, unknown>;
      return next;
    });
    setStaffNames((m) => {
      if (m.has(activeStaff.user_id)) return m;
      const next = new Map(m);
      next.set(activeStaff.user_id, activeStaff.display_name);
      return next;
    });
    // Saved: re-read the counter from saved evidence (no local +quantity).
    refreshCounter();
    lastActivityRef.current = Date.now();
  }, [activeStaff, currentOrder, verifiedLines, insertEvent, activeCase, station.department, refreshCounter]);

  /** Worker tapped Start on a line. Insert event, transition state. */
  const handleStartLine = useCallback(async (line: OrderLine) => {
    if (!activeStaff || !currentOrder) return;
    const key = lineKey(currentOrder.number, line.sku);
    const inserted = await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: line.sku,
      line_quantity: line.quantity,
      event_type: "started",
    });
    if (!inserted) return;
    setLineStates((m) => {
      const next = new Map(m);
      next.set(key, { state: "started", started_at: Date.now() });
      return next;
    });
    lastActivityRef.current = Date.now();
  }, [activeStaff, currentOrder, insertEvent]);

  /**
   * Look up prior events for this order at this location. If the order
   * has already been dispatched, or this same department has already
   * completed it, show a confirm prompt before letting the scan proceed.
   * Returns true if scan should proceed, false if user cancelled.
   * Fails OPEN (returns true) on query errors so a Supabase blip cant block work.
   */
  const preflightScan = useCallback(async (orderNum: string): Promise<boolean> => {
    try {
      // Parallel: prior production events + open CS Cases for this order.
      const [eventsRes, casesRes] = await Promise.all([
        supabase
          .from("production_events")
          .select("event_type, department, created_at")
          .eq("location", location)
          .eq("order_number", orderNum)
          .order("created_at", { ascending: false }),
        supabase
          .from("cs_cases")
          .select("id, issue_type, urgency, status, customer_name")
          .eq("location", location)
          .eq("order_number", orderNum)
          .in("status", ["new", "approved"])
          .order("created_at", { ascending: false }),
      ]);

      const events = eventsRes.error ? [] : (eventsRes.data ?? []);
      const openCase = casesRes.error ? null : (casesRes.data?.[0] ?? null);

      const fmt = (iso: string) =>
        new Date(iso).toLocaleString(undefined, {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });

      const askPreflight = (
        title: string,
        message: string,
        caseInfo: { caseId: string; issueType: string; urgency: string; customerName: string | null } | null = null,
        isResend: boolean = false,
      ): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          setPendingPreflight({
            title,
            message,
            caseInfo,
            resolve: (ok: boolean) => {
              if (ok && isResend) resendOrderRef.current.add(orderNum);
              resolve(ok);
            },
          });
        });

      // PRIORITY 1: open CS Case - replacement work is the intended action.
      // Surface case details so the worker knows exactly why they are reworking.
      if (openCase) {
        return askPreflight(
          "Replacement work pending",
          `Order #${orderNum} has an open replacement case. Verify the items as you complete them.`,
          {
            caseId: openCase.id,
            issueType: openCase.issue_type,
            urgency: openCase.urgency,
            customerName: openCase.customer_name,
          },
          true, // isResend - clear prior verifies so worker has to re-tick each replacement line
        );
      }

      if (events.length === 0) return true;

      // PRIORITY 2: already dispatched - warn before logging duplicate.
      const dispatched = events.find((e) => e.event_type === "dispatched");
      // Station-aware: only treat as "this dept already dispatched"
      // when the worker IS at dispatch. For other stations (A0 framer
      // arriving second on a mixed order), this is just the normal
      // mixed-order flow, not a re-do.
      if (dispatched) {
        if (station.department === "dispatch") {
          return askPreflight(
            "You already dispatched this order",
            `Order #${orderNum} was dispatched on ${fmt(dispatched.created_at)}. Re-dispatching will log a duplicate event but will not double-deduct stock (per-order idempotency). Continue if this is intentional.`,
            null,
            true, // isResend
          );
        } else {
          return askPreflight(
            "Dispatch already completed their part",
            `Order #${orderNum} was dispatched on ${fmt(dispatched.created_at)}. You are handling your own dept's part of the order now - continue?`,
          );
        }
      }

      // PRIORITY 3: same dept already completed - calmly note it.
      const sameDept = events.find(
        (e) => e.event_type === "completed" && e.department === station.department,
      );
      if (sameDept) {
        const label = PRODUCTION_DEPARTMENT_LABELS[station.department];
        return askPreflight(
          "Order already completed by your dept",
          `Order #${orderNum} was completed by ${label} on ${fmt(sameDept.created_at)}. Continue if this is rework or a missed step.`,
          null,
          true, // isResend
        );
      }

      // PRIORITY 4: another dept already completed THEIR part of this
      // order. Informational - this is the normal mixed-order flow
      // where two depts each do their slice. The order-based source_id
      // idempotency means no double-deduct can happen.
      // PRIORITY 4 silenced for dispatch - they normally arrive after framed/
      // a0_framed/unframed have completed their parts, so the prompt is noise
      // for them. Other stations still get the mixed-order context.
      const otherDeptCompleted = station.department !== "dispatch"
        ? events.find(
            (e) => e.event_type === "completed" && e.department !== station.department,
          )
        : undefined;
      if (otherDeptCompleted) {
        const otherLabel = PRODUCTION_DEPARTMENT_LABELS[otherDeptCompleted.department as keyof typeof PRODUCTION_DEPARTMENT_LABELS] ?? otherDeptCompleted.department;
        return askPreflight(
          `${otherLabel} already completed their part`,
          `Order #${orderNum} was partially completed by ${otherLabel} on ${fmt(otherDeptCompleted.created_at)}. You are handling your dept's part now - continue?`,
        );
      }

      return true;
    } catch {
      return true; // Fail open on unexpected errors.
    }
  }, [supabase, location, station.department]);

  /** Worker tapped Complete. Insert event, transition state, bump today's count. */
  const handleCompleteLine = useCallback(async (line: OrderLine) => {
    if (!activeStaff || !currentOrder) return;
    const key = lineKey(currentOrder.number, line.sku);
    const inserted = await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: line.sku,
      line_quantity: line.quantity,
      event_type: "completed",
    });
    if (!inserted) return;
    setLineStates((m) => {
      const next = new Map(m);
      const prev = next.get(key);
      next.set(key, {
        state: "completed",
        started_at: prev?.started_at,
        completed_at: Date.now(),
      });
      return next;
    });
    refreshCounter();
    lastActivityRef.current = Date.now();
  }, [activeStaff, currentOrder, insertEvent, refreshCounter]);

  /** Worker tapped Cancel mid-progress. Insert cancel event, reset to idle. */
  const handleCancelLine = useCallback(async (line: OrderLine) => {
    if (!activeStaff || !currentOrder) return;
    
    const key = lineKey(currentOrder.number, line.sku);
    const inserted = await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: line.sku,
      line_quantity: line.quantity,
      event_type: "cancelled",
      note: "Mid-progress cancel from /production",
    });
    if (!inserted) return;
    setLineStates((m) => {
      const next = new Map(m);
      next.delete(key);
      return next;
    });
    lastActivityRef.current = Date.now();
  }, [activeStaff, currentOrder, insertEvent]);

  /** Clear the current order, ready for the next scan. */
  /**
   * Complete the entire order at once. Inserts a 'completed' event for
   * every line that's currently in the 'started' state. Updates lineStates
   * + today's count. Clears the order afterward so the bench is ready
   * for the next scan.
   */
  // === unified-per-order workflow ===
  // One scan -> one completed event for the whole order, with the total
  // item count stored as line_quantity. line_sku is null because we no
  // longer track per-SKU completion.
  const handleCompleteOrder = useCallback(async () => {
    if (!activeStaff || !currentOrder) return;
    if (busy) return;
    // Framing depts require at least one verified line before Complete
    // fires. Prevents "scan then Complete with nothing done" from
    // adding to the tally, and also blocks resends that the worker
    // actually meant to scrap. Dispatch is a one-tap finalise so it's
    // exempt. Read from the ref so a fast "verify -> click Complete"
    // never sees a stale empty map from a not-yet-rebuilt closure.
    if (station.department !== "dispatch") {
      const verifiedCount = Math.max(verifiedLinesRef.current.size, verifiedLines.size);
      if (verifiedCount === 0) {
        onScanError("Verify at least one item before completing the order.");
        return;
      }
    }
    const totalItems = currentOrder.lines.reduce(
      (s, l) => s + (typeof l.quantity === "number" ? l.quantity : 1),
      0,
    );
    const evType = station.department === "dispatch" ? "dispatched" : "completed";
    const inserted = await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: null,
      line_quantity: totalItems > 0 ? totalItems : null,
      event_type: evType,
      // Tag with the active CS Case if this is replacement work - so the
      // RPC can skip deduction (CS Cases owns those movements).
      cs_case_id: activeCase?.caseId ?? null,
    });
    if (!inserted) return;
    // Saved: re-read the counter. Not awaited, so deduction below never waits on reporting.
    refreshCounter();
    lastActivityRef.current = Date.now();

    // Phase A: auto-deduct catalogue components for lines this dept owns.
    // The RPC skips events tagged with cs_case_id and is idempotent on
    // (event_id, component_code), so re-runs are safe.
    try {
      const componentMap = new Map<string, number>();
      for (const line of currentOrder.lines) {
        if (!shouldDeductAtDept(line.sku, station.department, evType)) continue;
        const route = routeShopifyLineToCatalogueLines(line.sku, line.quantity);
        for (const c of route.lines) {
          componentMap.set(c.code, (componentMap.get(c.code) ?? 0) + c.qty);
        }
      }
      // Add packages to the deduction list. They deduct from the same RPC -
      // the cache key is the product code (for scanned packages) or product
      // id (for auto-assigned mail tubes); the RPC handles both.
      for (const [pkgKey, qty] of packages.entries()) {
        componentMap.set(pkgKey, (componentMap.get(pkgKey) ?? 0) + qty);
      }
      if (componentMap.size > 0) {
        const componentArray = Array.from(componentMap.entries()).map(
          ([code, qty]) => ({ code, qty }),
        );
        const { data: deductResult, error: deductErr } = await supabase.rpc(
          "deduct_inventory_for_event",
          { p_event_id: inserted, p_lines: componentArray },
        );
        if (deductErr) {
          console.error("[auto-deduct] RPC error:", deductErr);
        } else {
          console.log("[auto-deduct] result:", deductResult);
        }
      } else {
        console.log("[auto-deduct] no components to deduct for this event");
      }
    } catch (e) {
      console.error("[auto-deduct] exception:", e);
    }
    window.setTimeout(() => {
      setCurrentOrder(null);
      setLineStates(new Map());
    }, 400);
  }, [activeStaff, currentOrder, busy, insertEvent, station.department, activeCase, supabase, packages, verifiedLines, refreshCounter]);

  /**
   * Scrap the entire order. Inserts a 'cancelled' event for every line on
   * the order. Since the deriveCompletedLines reducer in Reports drops
   * latestStart on cancel BEFORE a completed event lands, this means
   * scrapped orders contribute 0 units / 0 time to the staff's KPIs.
   * Inventory + CS Cases are untouched (frames weren't used).
   */
  const handleScrapOrder = useCallback(async () => {
    if (!activeStaff || !currentOrder) return;
    if (busy) return;
    await insertEvent({
      staff_id: activeStaff.user_id,
      order_number: currentOrder.number,
      line_sku: null,
      line_quantity: null,
      event_type: "cancelled",
      note: "Order scrapped from /production",
    });
    setCurrentOrder(null);
    setLineStates(new Map());
  }, [activeStaff, currentOrder, busy, insertEvent]);
  const handleClearOrder = useCallback(() => {
    setCurrentOrder(null);
    setLineStates(new Map());
    setVerifiedLines(new Map());
    setActiveCase(null);
    setStaffNames(new Map());
    onScanError(null);
  }, [onScanError]);

  /**
   * Resolve a scanned barcode to a staff identity. Returns null if no
   * active barcode matches in the current location. If a barcode with
   * the same value exists in a DIFFERENT location, we surface that
   * specifically so the operator knows the problem is a location grant,
   * not a typo.
   */
  const lookupStaff = useCallback(async (barcode: string, silent: boolean = false): Promise<ActiveStaff | null> => {
    const trimmed = barcode.trim().toUpperCase();
    if (!trimmed) return null;
    // First, narrow query to the current location.
    const { data, error } = await supabase
      .from("staff_barcodes")
      .select("user_id, display_name")
      .eq("location", location)
      .eq("barcode", trimmed)
      .eq("active", true)
      .maybeSingle();
    if (error) {
      onScanError(`Lookup failed: ${error.message}`);
      return null;
    }
    if (data) return { user_id: data.user_id, display_name: data.display_name };
    // No match in this location. Check if the barcode exists ANYWHERE so
    // we can give a precise error message.
    const { data: anyMatch } = await supabase
      .from("staff_barcodes")
      .select("location, display_name")
      .eq("barcode", trimmed)
      .eq("active", true);
    if (silent) {
      // Caller has a staff already active - a non-match just means this
      // barcode is an order scan, not a lanyard switch. Skip the error
      // banner and let the caller fall through to order handling.
      return null;
    }
    if (anyMatch && anyMatch.length > 0) {
      const otherLocs = anyMatch.map((r: { location: string }) => r.location).join(", ");
      const owner = anyMatch[0] as { display_name: string };
      onScanError(
        `Barcode ${trimmed} belongs to ${owner.display_name}, but only in locations: ${otherLocs}. ` +
        `This station is "${LOCATION_LABELS[location as LocationKey] ?? location}". ` +
        `Grant them access to this location in Settings → Team members, then re-issue the barcode.`,
      );
    } else {
      onScanError(
        `Barcode ${trimmed} doesn't match any active lanyard in "${LOCATION_LABELS[location as LocationKey] ?? location}". ` +
        `Check Settings → Team members to issue or regenerate.`,
      );
    }
    return null;
  }, [supabase, location, onScanError]);

  /**
   * Process a complete scan. Two cases:
   *
   *   - 8 hex chars: try as lanyard first. If matched, switch active staff
   *     and clear any in-progress order state (different worker).
   *
   *   - Anything else (or 8-hex that didn't match a lanyard): treat as
   *     an order scan. Dispatch dept logs a one-tap "dispatched" event;
   *     framing depts fetch the order from Shopify and render line cards.
   *
   * Lanyards take precedence because the same 8-char shape could in theory
   * collide with an 8-digit Shopify order number. If the value matches a
   * lanyard, treat it as a lanyard (probability of a real collision is
   * vanishingly small).
   */
  const processScan = useCallback(async (raw: string) => {
    if (busy) return;
    setBusy(true);
    onScanError(null);
    setDispatchFlash(null);
    try {
      const value = raw.trim();
      if (!value) return;
      lastActivityRef.current = Date.now();
      // eslint-disable-next-line no-console
      console.log("[scan] value:", JSON.stringify(value), "dept:", station.department);

      // Try lanyard first.
      if (/^[0-9A-Fa-f]{8}$/.test(value)) {
        const staff = await lookupStaff(value, !!activeStaff);
        if (staff) {
          // Clock-in flow: figure out if this worker is currently signed
          // in today. If not, ask the operator to confirm and write a
          // clock_in event before activating them.
          //
          // No silent catches - any DB error gets surfaced via onScanError
          // and we DON'T activate the worker, so the operator knows the
          // sign-in didn't land.
          try {
            const dayStart = new Date();
            dayStart.setHours(0, 0, 0, 0);
            // eslint-disable-next-line no-console
            console.log("[clock-in] checking", { user: staff.display_name, user_id: staff.user_id, dayStart: dayStart.toISOString(), location });
            const lookup = await supabase
              .from("production_events")
              .select("event_type, created_at")
              .eq("location", location)
              .eq("staff_id", staff.user_id)
              .in("event_type", ["clock_in", "clock_out"])
              .gte("created_at", dayStart.toISOString())
              .order("created_at", { ascending: false })
              .limit(1);
            if (lookup.error) {
              onScanError(`Clock-state check failed: ${lookup.error.message}. Not signing in.`);
              // eslint-disable-next-line no-console
              console.error("[clock-in] SELECT error", lookup.error);
              return;
            }
            const lastClockRows = lookup.data ?? [];
            const lastEvent = lastClockRows.length > 0 ? lastClockRows[0] : null;
            const isSignedIn = lastEvent ? lastEvent.event_type === "clock_in" : false;
            // eslint-disable-next-line no-console
            console.log("[clock-in] state", { lastEvent, isSignedIn });
            if (!isSignedIn) {
              const ok = window.confirm(`Sign in ${staff.display_name}?`);
              // eslint-disable-next-line no-console
              console.log("[clock-in] confirmed?", ok);
              if (!ok) return;
              const clockInId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const payload = {
                location,
                id: clockInId,
                staff_id: staff.user_id,
                department: station.department,
                event_type: "clock_in",
                note: "Sign in via lanyard scan",
              };
              // eslint-disable-next-line no-console
              console.log("[clock-in] inserting", payload);
              const ins = await supabase.from("production_events").insert(payload);
              if (ins.error) {
                onScanError(`Clock-in failed: ${ins.error.message}`);
                // eslint-disable-next-line no-console
                console.error("[clock-in] INSERT error", ins.error);
                return;
              }
              // eslint-disable-next-line no-console
              console.log("[clock-in] OK", clockInId);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            onScanError(`Clock-in flow threw: ${msg}. Not signing in.`);
            // eslint-disable-next-line no-console
            console.error("[clock-in] threw:", e);
            return;
          }
          onSetActiveStaff(staff);
          return;
        }
        // Fall through to order-scan handling — same shape might still
        // be a legit 8-digit Shopify order number.
      }

      // Not a lanyard. Order scan only valid if a worker is signed in.
      if (!activeStaff) {
        onScanError(
          `Lanyard not recognised in "${LOCATION_LABELS[location as LocationKey] ?? location}". ` +
          `Workers must sign in with a lanyard before scanning orders.`,
        );
        return;
      }

      // Package barcode (e.g. "+48=" -> A0 Double). Scanner emits this
      // pattern when a worker scans a box barcode at A0 Framed or Dispatch.
      // Adds to the packages map; doesn't require an active order, so
      // workers can pre-stage boxes before scanning the order.
      // Package barcode (e.g. "+48=" -> A0 Double). Tolerant of leading
      // or trailing garbage in the buffer (stray keystrokes, scanner
      // prefix bytes) - we extract the first "+NN=" substring rather
      // than requiring the whole value to match.
      const pkgMatch = value.match(/\+\d+=/);
      if (pkgMatch) {
        const pkgBarcode = pkgMatch[0];
        const pkg = packageFromBarcode(pkgBarcode, station.department);
        // eslint-disable-next-line no-console
        console.log("[package] match?", pkgBarcode, "(from value", JSON.stringify(value) + ")", station.department, "->", pkg ? pkg.key : "NO MATCH");
        if (pkg) {
          setPackages((m) => {
            const next = new Map(m);
            next.set(pkg.key, (next.get(pkg.key) ?? 0) + 1);
            return next;
          });
          return;
        }
        onScanError(
          `Unknown package barcode "${pkgBarcode}" - expected an A0 / A1 / A2 / A3-A4 / NZ box code. ` +
          `Check the barcode catalogue or scan a known box.`,
        );
        return;
      }

      // Strip a leading "#" if the operator scanned a Shopify-style label.
      let orderNum = value.replace(/^#+/, "");
      if (!orderNum) return;

      // Barcode scanners drop the leading "10" of the Shopify order number
      // (scanner produces "190203", real order is "10190203"). Re-add it if
      // the value is purely numeric and doesn't already start with "10".
      if (/^\d+$/.test(orderNum) && !orderNum.startsWith("10")) {
        orderNum = "10" + orderNum;
      }

      // Reset replacement context from any previous order before processing
      // this new scan. The preflight modal will re-set activeCase only if
      // the scanned order has its own open CS Case.
      setActiveCase(null);

      // All depts: fetch order, render lines, verify per-line.
      // Parallel preflight + Shopify fetch. preflight may show a confirm
      // dialog but the Shopify call keeps going during it - by the time
      // the user clicks Yes/No the order is already here. If they cancel,
      // we discard the fetched order (small Shopify rate-limit cost only).
      const [proceed, order] = await Promise.all([
        preflightScan(orderNum),
        fetchOrder(orderNum),
      ]);
      if (!proceed) return;
      if (!order) return; // error already surfaced by fetchOrder

      // Cancelled-order check. The Shopify query returns cancelled
      // orders too (so workers know they exist), but we always prompt
      // before processing one. Worker can OK to handle anyway (rare
      // rework case) or Cancel to back out.
      if (order.cancelled_at) {
        const when = new Date(order.cancelled_at).toLocaleString(undefined, {
          month: "short", day: "numeric", year: "numeric",
        });
        const reasonBit = order.cancel_reason ? ` (reason: ${order.cancel_reason.toLowerCase()})` : "";
        const cancelOk = await new Promise<boolean>((resolve) => {
          setPendingPreflight({
            title: "This order was cancelled",
            message: `${order.display_name} was cancelled on ${when}${reasonBit}. Continue only if this is intentional rework.`,
            resolve,
            caseInfo: null,
          });
        });
        if (!cancelOk) return;
      }
      if (order.lines.length === 0) {
        onScanError(
          `${order.display_name} has ${order.total_lines} line${order.total_lines === 1 ? "" : "s"}, ` +
          `but none of them belong to the ${PRODUCTION_DEPARTMENT_LABELS[station.department]} bench.`,
        );
        return;
      }
      setCurrentOrder(order);
      setLineStates(new Map()); // reset for the new order
      // Phase 2a: bracket the order with a started event. line_sku is null
      // because this is an order-level bracket, not a line-level start.
      // The matching completed event fires when the worker hits Complete
      // (or dispatched at the dispatch dept). Between started and that
      // matching close, the shift helper treats the time as in-progress
      // work that cannot be deducted as a break - regardless of duration.
      // Errors are swallowed: the kiosk should never block an order load
      // because the auxiliary bracket event failed to write.
      if (activeStaff) {
        // Skip dup started event if same worker scanned this order recently
        // (within 5 min). Re-scans are common and the 0031 idempotency keeps
        // dispatched/completed safe, but the started brackets just pile up.
        const dedupKey = `${activeStaff.user_id}__${order.number}`;
        const FIVE_MIN_MS = 5 * 60 * 1000;
        const lastTs = recentStartedRef.current.get(dedupKey);
        const nowMs = Date.now();
        if (!lastTs || nowMs - lastTs > FIVE_MIN_MS) {
          recentStartedRef.current.set(dedupKey, nowMs);
          void insertEvent({
            staff_id: activeStaff.user_id,
            order_number: order.number,
            line_sku: null,
            line_quantity: null,
            event_type: "started",
            note: "Order scanned - shift bracket",
          }).catch((e) => {
            // eslint-disable-next-line no-console
            console.warn("[shift-bracket] started event failed:", e);
          });
        }
      }
      


    } finally {
      setBusy(false);
    }
  }, [busy, lookupStaff, activeStaff, station.department, onSetActiveStaff, onScanError, fetchOrder, insertEvent, location]);

  /**
   * Global keystroke capture. USB barcode scanners type the value as
   * fast keystrokes; most send Enter as a terminator but some don't.
   * We submit on Enter OR after a 200ms idle gap (real keyboards type
   * way slower than 200ms between chars, so the gap only fires after
   * a complete scan).
   */
  const autoSubmitTimer = useRef<number | null>(null);
  // Dedup map for started/shift-bracket events. Keyed by
  // <staff_id>__<order_number>; value is the ms timestamp of the
  // last bracket written for that pair. Re-scans within 5 minutes
  // skip the second insert.
  const recentStartedRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't intercept if the user is typing into a real input.
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      if (e.key === "Enter") {
        if (autoSubmitTimer.current !== null) {
          clearTimeout(autoSubmitTimer.current);
          autoSubmitTimer.current = null;
        }
        if (scanBuffer.length > 0) {
          void processScan(scanBuffer);
          setScanBuffer("");
        }
        return;
      }
      if (e.key === "Escape") {
        if (autoSubmitTimer.current !== null) {
          clearTimeout(autoSubmitTimer.current);
          autoSubmitTimer.current = null;
        }
        setScanBuffer("");
        return;
      }
      if (e.key.length === 1) {
        setScanBuffer((b) => (b + e.key).slice(-128)); // cap length
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scanBuffer, processScan]);

  // Auto-submit strategy:
  //
  //   1. If the buffer is EXACTLY 8 hex chars — it's the shape of a
  //      lanyard token. Submit immediately (no debounce). This is the
  //      hot path: workers scan their badge, screen flips instantly.
  //
  //   2. Otherwise, debounce 200ms after the last keystroke. Covers
  //      scanners that don't send Enter and order numbers of any
  //      length (Shopify order numbers like "10186629" happen to also
  //      be 8 digits, so they take path 1 — same lookup logic handles
  //      both. Longer formats wait the 200ms.)
  useEffect(() => {
    if (autoSubmitTimer.current !== null) {
      clearTimeout(autoSubmitTimer.current);
      autoSubmitTimer.current = null;
    }
    // Path 1: exact lanyard shape → instant submit.
    if (/^[0-9A-Fa-f]{8}$/.test(scanBuffer)) {
      const value = scanBuffer;
      void processScan(value);
      setScanBuffer("");
      return;
    }
    // Path 2: debounced submit.
    if (scanBuffer.length >= 4) {
      autoSubmitTimer.current = window.setTimeout(() => {
        void processScan(scanBuffer);
        setScanBuffer("");
        autoSubmitTimer.current = null;
      }, 200);
    }
    return () => {
      if (autoSubmitTimer.current !== null) {
        clearTimeout(autoSubmitTimer.current);
        autoSubmitTimer.current = null;
      }
    };
  }, [scanBuffer, processScan]);

  // Idle timeout. Resets on any keystroke (captured above by lastActivityRef).
  useEffect(() => {
    if (!activeStaff) return;
    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_TIMEOUT_MS) {
        onSetActiveStaff(null);
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [activeStaff, onSetActiveStaff]);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950">
      {/* Top bar — brand left, station/location middle, controls right. */}
      <header className="h-14 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80">
        <div className="font-serif tracking-[0.2em] text-sm text-slate-700 dark:text-slate-300 select-none">
          INKA ARTHOUSE
        </div>
        <div className="text-sm font-semibold tracking-tight text-center">
          {PRODUCTION_DEPARTMENT_LABELS[station.department]}
          {station.station_id ? <span className="text-slate-400"> · {station.station_id}</span> : null}
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-normal">
            Location: {LOCATION_LABELS[location as LocationKey] ?? location}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {activeStaff ? (
            <button
              type="button"
              onClick={async () => {
                // Write a clock_out event for the active worker before
                // clearing them. If the write fails (network blip), still
                // idle the station so the operator isn't stuck.
                if (activeStaff) {
                  try {
                    const clockOutId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    const { error: coErr } = await supabase
                      .from("production_events")
                      .insert({
                        location,
                        id: clockOutId,
                        staff_id: activeStaff.user_id,
                        department: station.department,
                        event_type: "clock_out",
                        note: "Sign out via Sign out button",
                      });
                    if (coErr) {
                      onScanError(`Clock-out write failed: ${coErr.message}. Idling station anyway.`);
                    }
                  } catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn("[clock-out] write failed:", e);
                  }
                }
                onSetActiveStaff(null);
              }}
              className="inline-flex items-center gap-1 text-xs px-2 h-8 rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              title="Sign out (writes clock_out event and idles the station)"
            >
              <LogOut size={14} /> Sign out
            </button>
          ) : null}
          <a
            href="/returns"
            className="inline-flex items-center gap-1 text-xs px-2 h-8 rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            title="Return to the rest of the app (Returns page)"
          >
            Back to app
          </a>
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Station settings"
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center p-6 overflow-y-auto">
        {activeStaff ? (
          <ActiveScreen
            staff={activeStaff}
            department={station.department}
            scanBuffer={scanBuffer}
            error={scanError}
            counter={counter}
            counterState={counterEvidence}
            currentOrder={currentOrder}
            lineStates={lineStates}
            dispatchFlash={dispatchFlash}
            onStartLine={(line) => void handleStartLine(line)}
            onCompleteLine={(line) => void handleCompleteLine(line)}
            onCancelLine={(line) => void handleCancelLine(line)}
            onClearOrder={handleClearOrder}
            onCompleteOrder={() => void handleCompleteOrder()}
            onScrapOrder={() => void handleScrapOrder()}
            onManualOrderSubmit={(n) => void processScan(n)}
            packages={packages}
            onRemovePackage={(key) =>
              setPackages((m) => {
                const next = new Map(m);
                const cur = next.get(key) ?? 0;
                if (cur <= 1) next.delete(key);
                else next.set(key, cur - 1);
                return next;
              })
            }
            onClearPackages={() => setPackages(new Map())}
            verifiedLines={verifiedLines}
            onVerifyLine={(line) => void handleVerifyLine(line)}
            onUnverifyLine={(line) => void handleUnverifyLine(line)}
            staffNames={staffNames}
            activeCase={activeCase}
                    supabase={supabase}
          location={location}
            onSetActiveStaff={onSetActiveStaff}
          />
        ) : (
          <IdleScreen
            department={station.department}
            scanBuffer={scanBuffer}
            error={scanError}
          />
        )}
      </main>

      {/* Footer — current time + tiny instructions. */}
      <footer className="px-4 py-2 text-[10px] text-slate-400 flex items-center justify-between border-t border-slate-200 dark:border-slate-800">
        <span>Scanner active · type Esc to clear the buffer</span>
        <span><LiveClock /></span>
      </footer>
          {editOrderWarning ? (
            <Modal
              open
              onClose={() => setEditOrderWarning(null)}
              title={"Edit Order â€” #" + editOrderWarning.orderNumber}
              width="max-w-md"
            >
              <div className="mb-4 rounded-md ring-1 ring-amber-200 dark:ring-amber-900/40 bg-amber-50/60 dark:bg-amber-900/20 px-3 py-3">
                <div className="text-[11px] uppercase tracking-wide font-semibold text-amber-800 dark:text-amber-200 mb-1">
                  Manager check required
                </div>
                <div className="text-sm text-slate-800 dark:text-slate-100">
                  Check with a manager that this order is correct - edits applied.
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700"
                  onClick={() => setEditOrderWarning(null)}
                  autoFocus
                >
                  Acknowledge
                </button>
              </div>
            </Modal>
          ) : null}
          {pendingPreflight ? (
            <Modal
              open
              onClose={() => {
                pendingPreflight.resolve(false);
                setPendingPreflight(null);
              }}
              title={pendingPreflight.title}
              width="max-w-md"
            >
              <p className="text-sm text-slate-700 dark:text-slate-300 mb-4">{pendingPreflight.message}</p>
              {pendingPreflight.caseInfo ? (
                <div className="mb-4 rounded-md ring-1 ring-blue-200 dark:ring-blue-900/40 bg-blue-50/60 dark:bg-blue-900/20 px-3 py-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-blue-700 dark:text-blue-300">
                    Case #{pendingPreflight.caseInfo.caseId}
                  </div>
                  <div className="text-sm text-slate-800 dark:text-slate-100">
                    Issue: <span className="font-medium">{pendingPreflight.caseInfo.issueType.replace(/_/g, " ")}</span>
                    <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 text-blue-800 text-[10px] font-semibold uppercase px-2 py-0.5 dark:bg-blue-900/40 dark:text-blue-200">
                      {pendingPreflight.caseInfo.urgency}
                    </span>
                  </div>
                  {pendingPreflight.caseInfo.customerName ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      Customer: {pendingPreflight.caseInfo.customerName}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded ring-1 ring-slate-300 dark:ring-slate-700 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  onClick={() => {
                    pendingPreflight.resolve(false);
                    setPendingPreflight(null);
                  }}
                >
                  Cancel scan
                </button>
                <button
                  type="button"
                  className={
                    pendingPreflight.caseInfo
                      ? "px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
                      : "px-3 py-1.5 rounded bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700"
                  }
                  onClick={() => {
                    if (pendingPreflight.caseInfo) {
                      setActiveCase({
                        caseId: pendingPreflight.caseInfo.caseId,
                        issueType: pendingPreflight.caseInfo.issueType,
                        urgency: pendingPreflight.caseInfo.urgency,
                        customerName: pendingPreflight.caseInfo.customerName,
                      });
                    }
                    pendingPreflight.resolve(true);
                    setPendingPreflight(null);
                  }}
                >
                  {pendingPreflight.caseInfo ? "Start replacement" : "Continue anyway"}
                </button>
              </div>
            </Modal>
          ) : null}
    </div>
  );
}

// ============================================================
// Idle screen
// ============================================================

function IdleScreen({
  department, scanBuffer, error,
}: {
  department: ProductionDepartment;
  scanBuffer: string;
  error: string | null;
}) {
  return (
    <div className="text-center space-y-6 max-w-2xl">
      <ScanLine size={96} className="mx-auto text-slate-300 dark:text-slate-700" />
      <h1 className="text-4xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        Scan your lanyard
      </h1>
      <p className="text-lg text-slate-500 dark:text-slate-400">
        This station is set to <strong>{PRODUCTION_DEPARTMENT_LABELS[department]}</strong>.
        Swipe your lanyard across the scanner to sign in for the day.
      </p>
      {scanBuffer ? (
        <div className="text-xs text-slate-400 font-mono">
          buffer: {scanBuffer}
        </div>
      ) : null}
      {error ? (
        <div className="text-sm text-red-600 dark:text-red-400 rounded-md ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 inline-block">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================
// Active screen — staff is signed in
// ============================================================

function ActiveScreen({
  staff, department, scanBuffer, error, counter, counterState,
  currentOrder, lineStates, dispatchFlash,
  onStartLine, onCompleteLine, onCancelLine, onClearOrder, onCompleteOrder, onScrapOrder,
  onManualOrderSubmit,
  packages, onRemovePackage, onClearPackages,
  verifiedLines, onVerifyLine, onUnverifyLine, staffNames, activeCase,
  supabase, location, onSetActiveStaff,
}: {
  staff: ActiveStaff;
  department: ProductionDepartment;
  scanBuffer: string;
  error: string | null;
  counter: ProductionCounterView | null;
  counterState: ProductionEvidenceState;
  currentOrder: CurrentOrder | null;
  lineStates: Map<string, LineRecord>;
  dispatchFlash: string | null;
  onStartLine: (line: OrderLine) => void;
  onCompleteLine: (line: OrderLine) => void;
  onCancelLine: (line: OrderLine) => void;
  onClearOrder: () => void;
  onCompleteOrder: () => void;
  onScrapOrder: () => void;
  onManualOrderSubmit: (orderNum: string) => void;
  packages: Map<string, number>;
  onRemovePackage: (key: string) => void;
  onClearPackages: () => void;
  verifiedLines: Map<string, { event_id: string; staff_id: string; dept: string; time: string }>;
  onVerifyLine: (line: OrderLine) => void;
  onUnverifyLine: (line: OrderLine) => void;
  staffNames: Map<string, string>;
  activeCase: { caseId: string; issueType: string; urgency: string; customerName: string | null } | null;
  supabase: ReturnType<typeof getSupabase>;
  location: string;
  onSetActiveStaff: (s: ActiveStaff | null) => void;
}) {
  // Done-ness summary across the current order's lines.
  const linesDone = useMemo(() => {
    if (!currentOrder) return 0;
    return currentOrder.lines.filter((l) => {
      const r = lineStates.get(lineKey(currentOrder.number, l.sku));
      return r?.state === "completed";
    }).length;
  }, [currentOrder, lineStates]);
  const allDone = !!currentOrder && linesDone === currentOrder.lines.length && currentOrder.lines.length > 0;

  return (
    <div className="w-full max-w-4xl space-y-6">
      {/* Header — staff + today's count */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400">
            Signed in as
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 mt-1">
            {staff.display_name}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-center">
            <div className={cn("text-2xl font-semibold tabular-nums", counterState.updating && "opacity-60")}>
              {counter ? counter.normal.orders : "—"}
              <span className="text-base font-normal text-slate-500 ml-1">orders</span>
            </div>
            <div className={cn("text-2xl font-semibold tabular-nums", counterState.updating && "opacity-60")}>
              {counter ? (counter.normal.items === null ? "too many" : counter.normal.items) : "—"}
              <span className="text-base font-normal text-slate-500 ml-1">items</span>
            </div>
            {counter && ((counter.rework.items ?? 0) > 0 || counter.rework.orders > 0) ? (
              <div className="text-xs text-amber-700 dark:text-amber-300 tabular-nums">
                + CS/rework {counter.rework.items ?? "—"} items · {counter.rework.orders} orders
              </div>
            ) : null}
            <div className="text-[10px] uppercase tracking-widest text-slate-500">
              today (since 4am{counter ? ` ${counter.range.timeZone.split("/").pop()?.replace("_", " ")}` : ""})
            </div>
            <ProductionCountStatus
              className="mt-1 max-w-[16rem] text-left"
              state={counterState}
              range={counter?.range ?? null}
              coverage={counter?.coverage ?? null}
              compact
            />
          </div>
        </div>
      </div>

      {/* Dispatch flash — short-lived confirmation banner */}
      {dispatchFlash ? (
        <div className="rounded-2xl ring-1 ring-emerald-200 dark:ring-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-900/20 px-6 py-5 text-center">
          <Check className="mx-auto text-emerald-600 dark:text-emerald-400" size={48} />
          <div className="text-2xl font-semibold text-emerald-700 dark:text-emerald-300 mt-2">
            Order #{dispatchFlash} dispatched
          </div>
          <div className="text-sm text-emerald-700/80 dark:text-emerald-400/80 mt-1">
            Ready for the next scan
          </div>
        </div>
      ) : null}

      {/* Scan prompt — visible when no order is loaded */}
      {!currentOrder ? (
        <div className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-8 text-center">
          <ScanLine size={48} className="mx-auto text-slate-300 dark:text-slate-700 mb-3" />
          <div className="text-lg font-medium text-slate-700 dark:text-slate-200">
            {department === "dispatch"
              ? "Scan an order to log dispatch"
              : "Scan an order to see line items"}
          </div>
          <div className="text-sm text-slate-500 mt-1">
            Or swipe another lanyard to switch user.
          </div>
          {/* Manual order input - for packing slips without a barcode. */}
          <ManualOrderForm onSubmit={onManualOrderSubmit} />
          {scanBuffer ? (
            <div className="text-xs text-slate-400 font-mono mt-4">
              buffer: {scanBuffer}
            </div>
          ) : null}
          {error ? (
            <div className="text-sm text-red-600 dark:text-red-400 mt-4 inline-block rounded-md ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2 text-left max-w-xl">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Prominent Clock out button - between scan card and order panel.
          Only shows when someone is signed in AND no order is loaded, so
          it does not clutter the work-in-progress view. Orange-on-white
          as a reminder color: stands out without screaming error. */}
      {!currentOrder && staff ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={async () => {
              if (!staff) return;
              try {
                const clockOutId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const { error: coErr } = await supabase
                  .from("production_events")
                  .insert({
                    location,
                    id: clockOutId,
                    staff_id: staff.user_id,
                    department: department,
                    event_type: "clock_out",
                    note: "Sign out via prominent button",
                  });
                if (coErr) {
                  console.error(`Clock-out failed: ${coErr.message}. Idling station anyway.`);
                }
              } catch (e) {
                // eslint-disable-next-line no-console
                console.warn("[clock-out] write failed:", e);
              }
              onSetActiveStaff(null);
            }}
            className="inline-flex items-center gap-2 px-8 py-4 rounded-xl bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white font-semibold text-lg shadow-lg shadow-orange-500/40 ring-2 ring-orange-300 dark:ring-orange-700/50 transition"
            title="Clock out reminder - writes a clock_out event and idles the station"
            data-prominent-clockout="ProminentClockOutPrompt"
          >
            <LogOut size={20} /> Clock out
          </button>
        </div>
      ) : null}

      {/* Order panel — visible when an order is loaded */}
      {currentOrder ? (
        <div className="space-y-3">
          <div className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-widest text-slate-500">Working on</div>
                <h2 className="text-3xl font-semibold tracking-tight font-mono">
                  {currentOrder.display_name}
                </h2>
                <div className="mt-1 space-y-1">
                  <div className="text-3xl font-semibold tabular-nums">
                    {currentOrder.lines.reduce(
                      (s, l) => s + (typeof l.quantity === "number" ? l.quantity : 1),
                      0,
                    )}
                    <span className="text-base font-normal text-slate-500 ml-2">
                      item{currentOrder.lines.reduce(
                        (s, l) => s + (typeof l.quantity === "number" ? l.quantity : 1),
                        0,
                      ) === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500">
                    {currentOrder.lines.length} of {currentOrder.total_lines} lines for your department
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onClearOrder}
                className="text-xs px-3 h-8 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                Clear order
              </button>
            </div>
          </div>

          {/* Phase 5: replacement banner - persistent for the duration of
              the scan once "Start replacement" is accepted on the modal. */}
          {activeCase ? (
            <div className="rounded-2xl ring-2 ring-orange-300 dark:ring-orange-700 bg-orange-50/70 dark:bg-orange-900/20 px-5 py-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-[10px] uppercase tracking-widest font-bold text-orange-700 dark:text-orange-300">
                    Replacement work - case #{activeCase.caseId}
                  </div>
                  <div className="text-sm text-slate-700 dark:text-slate-200 mt-0.5">
                    Issue: <span className="font-semibold">{activeCase.issueType.replace(/_/g, " ")}</span>
                    <span className="ml-2 inline-flex items-center rounded-full bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 text-[10px] font-bold uppercase px-2 py-0.5">
                      {activeCase.urgency}
                    </span>
                  </div>
                  {activeCase.customerName ? (
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Customer: {activeCase.customerName}
                    </div>
                  ) : null}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-orange-700/80 dark:text-orange-300/80 font-semibold">
                  Every verify is logged against this case
                </div>
              </div>
            </div>
          ) : null}

          {/* Order notes - shown to next person who scans this order */}
          <OrderNotesPanel
            supabase={supabase}
            location={location}
            orderNumber={currentOrder.number}
            author={null}
            variant="loud"
          />
          {/* Phase 4: per-line verification list with three colour states. */}
          <div className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-2 text-xs uppercase tracking-widest text-slate-500 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span>Items in this order</span>
              <span>
                {currentOrder.lines.filter((l) => l.belongsToThisDept && verifiedLines.has(lineKey(currentOrder.number, l.sku))).length}
                {" / "}
                {currentOrder.lines.filter((l) => l.belongsToThisDept).length}
                {" verified"}
              </span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {currentOrder.lines.map((line) => {
                const key = lineKey(currentOrder.number, line.sku);
                const verifiedRec = verifiedLines.get(key);
                const isVerified = !!verifiedRec;
                const isMine = line.belongsToThisDept;
                const verifiable = isSkuVerifiable(line.sku, department);
                const parsed = parseSku(line.sku);
                const orient = detectOrientation(line.variantTitle);
                // orientStripe replaced by the absolute-positioned rail div
                // below. Left in place as a stub so any stale references fail loud.
                const orientStripe = ""; void orientStripe;
                const verifiedTime = isVerified
                  ? new Date(verifiedRec.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
                  : "";
                let containerCls: string;
                if (isVerified) {
                  containerCls = "px-5 py-3 flex items-center gap-3 bg-emerald-50/40 dark:bg-emerald-900/10";
                } else if (!verifiable) {
                  containerCls = "px-5 py-3 flex items-center gap-3 bg-slate-100/80 dark:bg-slate-800/40 opacity-70";
                } else if (isMine) {
                  containerCls = "px-5 py-3 flex items-center gap-3 bg-blue-50/40 dark:bg-blue-900/20 hover:bg-blue-100/70 dark:hover:bg-blue-900/30 cursor-pointer";
                } else {
                  containerCls = "px-5 py-3 flex items-center gap-3 bg-white dark:bg-slate-900/40 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer";
                }
                return (
                  <li
                    key={line.sku}
                    className={containerCls + (orient ? " relative pl-3" : "")}
                    onClick={verifiable && !isVerified ? () => onVerifyLine(line) : undefined}
                  >
                    <div className={
                      "text-xl font-bold tabular-nums w-12 text-right " +
                      (line.quantity > 1 ? "text-red-600 dark:text-red-400" : "text-slate-700 dark:text-slate-300")
                    }>
                      {"x" + line.quantity}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={"text-sm font-semibold truncate " + (isMine ? "text-slate-900 dark:text-slate-100" : "text-slate-500")}>
                          {line.title || line.sku}
                        </div>
                        <span className="shrink-0 inline-flex items-center rounded-full bg-slate-200 dark:bg-slate-700 text-[9px] font-bold uppercase tracking-wide text-slate-700 dark:text-slate-200 px-1.5 py-0.5">
                          {skuTypeBadge(line.sku)}
                        </span>
                        {!isMine && verifiable && !isVerified ? (
                          <span className="shrink-0 inline-flex items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5">
                            {line.dept ? PRODUCTION_DEPARTMENT_LABELS[line.dept] : "Other dept"}
                          </span>
                        ) : null}
                      </div>
                      {parsed && parsed.size ? (
                        <div className="mt-1 flex items-center gap-2 flex-wrap text-[12px] text-slate-700 dark:text-slate-200">
                          <span className="font-semibold">{friendlySize(parsed.size)}</span>
                          {parsed.variant ? (
                            <span className={variantChipClass(parsed.variant)}>
                              {friendlyVariant(parsed.variant)}
                            </span>
                          ) : null}
                          {orient ? (
                            <span
                              className={
                                "inline-flex items-center gap-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 ring-1 " +
                                (orient === "portrait"
                                  ? "bg-blue-100 text-blue-900 ring-blue-400 dark:bg-blue-900/40 dark:text-blue-100 dark:ring-blue-600"
                                  : "bg-orange-100 text-orange-900 ring-orange-400 dark:bg-orange-900/40 dark:text-orange-100 dark:ring-orange-600")
                              }
                              aria-label={orient === "portrait" ? "Portrait orientation" : "Landscape orientation"}
                            >
                              <span
                                className={
                                  orient === "portrait"
                                    ? "inline-block w-1.5 h-2.5 bg-blue-800 dark:bg-blue-200 rounded-[1px]"
                                    : "inline-block w-2.5 h-1.5 bg-orange-800 dark:bg-orange-200 rounded-[1px]"
                                }
                                aria-hidden="true"
                              />
                              {orient === "portrait" ? "Portrait" : "Landscape"}
                            </span>
                          ) : null}
                          {parsed.type === "set_print" ? (
                            <span className="text-[10px] uppercase tracking-wide text-slate-500">
                              Set of {parsed.setCount}
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="text-[12px] text-slate-600 dark:text-slate-300 mt-0.5 truncate">
                          {line.variantTitle ?? describeSku(line.sku)}
                        </div>
                      )}
                      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 truncate mt-0.5">
                        {line.sku}
                      </div>
                    </div>
                    {isVerified ? (
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300 font-semibold whitespace-nowrap">
                          <Check size={14} />
                          <span>
                            {staffNames.get(verifiedRec.staff_id) ?? "Staff"} - {verifiedTime}
                          </span>
                        </div>
                        {isMine ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onUnverifyLine(line); }}
                            className="text-[11px] text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 underline underline-offset-2 font-medium"
                          >
                            Undo
                          </button>
                        ) : null}
                      </div>
                    ) : !verifiable ? (
                      <div className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold whitespace-nowrap">
                        No verify needed
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onVerifyLine(line); }}
                        className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 whitespace-nowrap"
                      >
                        Verify
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Quality prompt banner - copy changes by dept */}
          <div className="rounded-2xl ring-1 ring-amber-200 dark:ring-amber-900/40 bg-amber-50/60 dark:bg-amber-900/20 px-5 py-4 text-center">
            <div className="text-base font-semibold text-amber-800 dark:text-amber-300">
              {department === "dispatch"
                ? "Check all items are packed and labelled before dispatching"
                : "Check your print quality before framing"}
            </div>
          </div>

          {/* Package selector - shown when station requires packaging */}
          {stationRequiresPackages(department) ? (
            <div className="rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-5">
              <div className="text-xs uppercase tracking-widest text-slate-500 mb-3 flex items-center justify-between">
                <span>Packages for this shipment</span>
                {packages.size > 0 ? (
                  <button
                    type="button"
                    onClick={onClearPackages}
                    className="text-[10px] text-slate-500 hover:text-rose-600 underline"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
              {packages.size === 0 ? (
                <div className="text-sm text-slate-500 italic">
                  Scan a box barcode to add. Each scan = 1 box. Scan again for multi-box orders.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {Array.from(packages.entries()).map(([key, qty]) => {
                    const pkgType = PACKAGE_TYPES.find((p) => p.key === key);
                    const label = pkgType?.label ?? MAIL_TUBE_LABELS[key] ?? key;
                    return (
                      <li
                        key={key}
                        className="flex items-center justify-between px-3 py-2 rounded-md bg-slate-50 dark:bg-slate-800/40 ring-1 ring-slate-200 dark:ring-slate-700"
                      >
                        <div className="text-sm font-medium">
                          <span className="text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100 mr-2">
                            x{qty}
                          </span>
                          {label}
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemovePackage(key)}
                          className="text-[11px] text-slate-500 hover:text-rose-600 underline whitespace-nowrap"
                        >
                          - 1
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}

          {/* Auto mail-tube info shown at unframed station */}
          {department === "unframed" && packages.size > 0 ? (
            <div className="rounded-2xl ring-1 ring-emerald-200 dark:ring-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20 p-4">
              <div className="text-[10px] uppercase tracking-widest text-emerald-700 dark:text-emerald-300 font-bold mb-1">
                Auto-assigned packaging
              </div>
              {Array.from(packages.entries()).map(([key, qty]) => (
                <div key={key} className="text-sm text-slate-700 dark:text-slate-200">
                  x{qty} {MAIL_TUBE_LABELS[key] ?? key}
                </div>
              ))}
            </div>
          ) : null}

          {/* Complete + Scrap buttons */}
          <OrderActionBar
            onCompleteOrder={onCompleteOrder}
            onScrapOrder={onScrapOrder}
            department={department}
            packagesSet={packages.size > 0}
          />
          {/* Inline error during line operations */}
          {error ? (
            <div className="text-sm text-red-600 dark:text-red-400 rounded-md ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2">
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One line in the current order. Renders one of three visual states:
 *
 *   idle      — big "Start" button
 *   started   — live timer + "Complete" / "Cancel" buttons
 *   completed — checkmark + total time taken
 *
 * Footprint is uniform across states so the grid doesn't reflow when
 * a card transitions.
 */
function ManualOrderForm({ onSubmit }: { onSubmit: (orderNum: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="mt-5 flex flex-wrap items-center gap-2 justify-center"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setValue("");
      }}
    >
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="Type order number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-10 w-56 px-3 rounded-md ring-1 ring-slate-300 dark:ring-slate-700 bg-white dark:bg-slate-900 text-base text-center tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-400"
      />
      <button
        type="submit"
        className="h-10 px-4 rounded-md bg-slate-900 text-white text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        disabled={!value.trim()}
      >
        Look up
      </button>
    </form>
  );
}

function LineCard({
  line, record, onStart, onComplete, onCancel,
}: {
  line: OrderLine;
  record: LineRecord | undefined;
  onStart: () => void;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const state: LineState = record?.state ?? "idle";
  // Live elapsed for started lines (driven by the parent's tick).
  let elapsed: number | null = null;
  if (state === "started" && record?.started_at) {
    elapsed = Date.now() - record.started_at;
  } else if (state === "completed" && record?.started_at && record?.completed_at) {
    elapsed = record.completed_at - record.started_at;
  }
  const sizeBadge = line.product?.size ?? "?";
  return (
    <div className={cn(
      "rounded-2xl ring-1 p-4 flex flex-col gap-3 transition",
      state === "completed"
        ? "ring-emerald-200 dark:ring-emerald-900/40 bg-emerald-50/40 dark:bg-emerald-900/10 opacity-80"
        : state === "started"
          ? "ring-amber-200 dark:ring-amber-900/40 bg-amber-50/40 dark:bg-amber-900/10"
          : "ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900",
    )}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-base font-semibold truncate">{line.sku}</div>
          <div className="text-xs text-slate-500 truncate">{line.title || "—"}</div>
        </div>
        <div className="text-right whitespace-nowrap">
          <div className="inline-flex items-center gap-1 px-3 py-1 rounded-md text-sm font-bold uppercase tracking-wide bg-slate-200 dark:bg-slate-700">
            {sizeBadge}
          </div>
          {/* Red bold qty text for multi-unit lines (no box) */}
          <div className={cn(
            "text-3xl font-extrabold tabular-nums leading-none mt-1",
            line.quantity > 1
              ? "text-red-600 dark:text-red-500"
              : "text-slate-900 dark:text-slate-100",
          )}>
            ×{line.quantity}
          </div>
        </div>
      </div>

      {state === "idle" ? (
        // Auto-start fires the moment an order is scanned, so the idle
        // state is only ever a transient ~100ms. No clickable Start button.
null
      ) : state === "started" ? (
        <div className="mt-auto flex items-center gap-2">
          <div className="flex-1 h-14 rounded-xl bg-amber-100 dark:bg-amber-900/30 text-amber-900 dark:text-amber-200 text-lg font-semibold inline-flex items-center justify-center gap-2">
            <Play size={18} fill="currentColor" /> In progress
            {elapsed !== null ? (
              <span className="ml-2 text-base tabular-nums opacity-90">{fmtDuration(elapsed)}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="h-14 px-3 rounded-xl ring-1 ring-slate-200 dark:ring-slate-700 text-slate-400 hover:text-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
            title="Cancel this line (start time discarded)"
          >
            <XIcon size={20} />
          </button>
        </div>
      ) : (
        <div className="mt-auto rounded-xl bg-emerald-100 dark:bg-emerald-900/30 px-4 py-3 inline-flex items-center justify-center gap-2 text-emerald-800 dark:text-emerald-200">
          <Check size={20} />
          <span className="font-semibold">Done</span>
          {elapsed !== null ? (
            <span className="text-xs opacity-80 tabular-nums">in {fmtDuration(elapsed)}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Department / station picker
// ============================================================

function DepartmentPicker({
  current, onPick, onClose, onReset,
}: {
  current: StationConfig | null;
  onPick: (cfg: StationConfig) => void;
  onClose?: () => void;
  onReset?: () => void;
}) {
  const [dept, setDept] = useState<ProductionDepartment>(current?.department ?? "framed");

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-lg rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-8 space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Set up this station</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Which bench is this tablet on? Pick one — saved on this device so you only do it once.
          </p>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Department</div>
          <div className="grid grid-cols-2 gap-2">
            {(["a0_framed", "framed", "unframed", "dispatch"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDept(d)}
                className={cn(
                  "px-4 py-3 rounded-lg ring-1 text-left transition",
                  dept === d
                    ? "ring-slate-900 dark:ring-slate-100 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                    : "ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800",
                )}
              >
                <div className="font-semibold">{PRODUCTION_DEPARTMENT_LABELS[d]}</div>
                <div className="text-xs opacity-70 mt-0.5">
                  {d === "dispatch"
                    ? "Single-scan log when packing"
                    : "Start / Complete per line item"}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between pt-2">

          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              className="text-xs text-slate-500 hover:text-red-600 dark:hover:text-red-400 underline-offset-2 hover:underline"
            >
              Clear binding (re-prompt next load)
            </button>
          ) : <span />}
          <div className="flex gap-2">
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                className="px-3 h-9 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm"
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onPick({ department: dept, station_id: null })}
              className="px-4 h-9 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-sm font-medium hover:opacity-90"
            >
              Save station
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Tiny live clock in the footer
// ============================================================

function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return <>{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</>;
}

// ============================================================
// OrderActionBar â€” Complete + Scrap buttons shown beneath the
// line cards on framing benches. Scrap is two-click: first
// click reveals red "Are you sure?" confirm text; second click
// fires onScrapOrder.
// ============================================================
function OrderActionBar({
  onCompleteOrder, onScrapOrder, department, packagesSet,
}: {
  onCompleteOrder: () => void;
  onScrapOrder: () => void;
  department: ProductionDepartment;
  packagesSet: boolean;
}) {
  const blocked = (department === "a0_framed" || department === "dispatch" || department === "unframed") && !packagesSet;
  const [scrapConfirm, setScrapConfirm] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onCompleteOrder}
        disabled={blocked}
        title={blocked ? "Set at least 1 package before completing" : ""}
        className={
          "w-full h-16 rounded-2xl text-white text-xl font-semibold inline-flex items-center justify-center gap-2 active:scale-[0.99] transition " +
          (blocked
            ? "bg-slate-400 cursor-not-allowed"
            : "bg-emerald-600 hover:bg-emerald-700")
        }
      >
        <Check size={22} /> {department === "dispatch" ? "Dispatch order" : "Complete order"}
      </button>
      <button
        type="button"
        onClick={() => {
          if (scrapConfirm) {
            onScrapOrder();
            setScrapConfirm(false);
          } else {
            setScrapConfirm(true);
            // Auto-reset after 5s if they hesitate.
            window.setTimeout(() => setScrapConfirm(false), 5000);
          }
        }}
        className={cn(
          "w-full h-12 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-2 transition ring-1",
          scrapConfirm
            ? "bg-red-600 text-white ring-red-700 hover:bg-red-700"
            : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-700 dark:hover:bg-slate-800",
        )}
      >
        {scrapConfirm ? (
          <>
            <XIcon size={16} /> Are you sure? Tap again to scrap
          </>
        ) : (
          <>Scrap order</>
        )}
      </button>
    </div>
  );
}

