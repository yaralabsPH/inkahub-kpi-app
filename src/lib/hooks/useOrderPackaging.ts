import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PackagingLineInput, PackingPoint } from "@/lib/domain/packaging/contents";
import type { PickedPackage } from "@/lib/domain/packaging/evaluate";
import type { CatalogueItem } from "@/lib/domain/packaging/ruleSet";
import {
  addPackage,
  adjustPackage,
  alternativesFor,
  buildApplyPayload,
  packageFromLegacyBarcode,
  pickStatus,
  predictPackaging,
  stationPackingPoint,
  tapPackage,
  type PackagingPrediction,
  type PickStatus,
} from "@/lib/domain/packaging/session";
import {
  applyRequestId,
  loadPackagingConfig,
  SCAN_CONFIG,
  type PackagingConfig,
  type PackagingMode,
} from "@/lib/repository/supabase/orderPackaging";
import { getPackagingOutbox } from "@/lib/state/packagingOutbox";
import { drainPackagingOutbox, submitPackagingApply } from "@/lib/state/packagingSubmit";

/**
 * F4 box-auto-pick: everything /production needs for packaging, behind one
 * hook so Production.tsx changes stay small.
 *
 * In scan mode (the default) this hook reads the site setting and does
 * nothing else: no prediction, no writes. All old behaviour stays in
 * Production.tsx untouched.
 */

export interface OrderPackagingView {
  point: PackingPoint;
  prediction: PackagingPrediction;
  /** The worker's current choice; equals the prediction until they change it. */
  chosen: PickedPackage[];
  status: PickStatus;
  alternatives: CatalogueItem[];
}

export interface OrderPackaging {
  /** Effective site mode. "scan" = old behaviour. */
  mode: PackagingMode;
  /** Shown when the site asked for auto but had to fall back to scan. */
  warning: string | null;
  /** Null in scan mode, with no order loaded, or at a station that packs nothing. */
  view: OrderPackagingView | null;
  /** Packaging saves waiting on this device for the network. */
  pendingCount: number;
  tap: (item: CatalogueItem) => void;
  adjust: (key: string, delta: number) => void;
  /** Back to what the rules predicted. */
  reset: () => void;
  /** A scanned legacy box barcode. Returns true when it was used as a manual pick. */
  scanLegacyBarcode: (barcode: string) => boolean;
  /** Call once after the completion event is saved. Never throws. */
  applyAfterEvent: (eventId: string, orderNumber: string) => Promise<void>;
}

interface Options {
  client: SupabaseClient;
  location: string;
  department: string;
  order: { number: string; lines: PackagingLineInput[] } | null;
  csCaseId: string | null;
  onError: (message: string) => void;
}

const DRAIN_INTERVAL_MS = 30_000;

export function useOrderPackaging(opts: Options): OrderPackaging {
  const { client, location, department, order, csCaseId, onError } = opts;
  const [config, setConfig] = useState<PackagingConfig>(SCAN_CONFIG);
  const [chosen, setChosen] = useState<PickedPackage[] | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const outbox = useMemo(() => getPackagingOutbox(), []);
  const orderNumber = order?.number ?? null;

  // Re-read the site mode whenever an order loads, so an owner's switch
  // reaches every station on its next order without a deploy or reload.
  useEffect(() => {
    let cancelled = false;
    void loadPackagingConfig(client, location).then((c) => {
      if (!cancelled) setConfig(c);
    });
    return () => {
      cancelled = true;
    };
  }, [client, location, orderNumber]);

  // A new order starts from the prediction again.
  useEffect(() => {
    setChosen(null);
  }, [orderNumber, csCaseId]);

  const refreshPending = useCallback(() => setPendingCount(outbox.pendingCount(location)), [outbox, location]);

  const drain = useCallback(async () => {
    if (outbox.pendingCount() === 0) return;
    await drainPackagingOutbox(client, outbox);
    refreshPending();
  }, [client, outbox, refreshPending]);

  useEffect(() => {
    refreshPending();
    void drain();
    const timer = window.setInterval(() => void drain(), DRAIN_INTERVAL_MS);
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [drain, refreshPending]);

  const point = stationPackingPoint(department);
  const ruleSet = config.mode === "auto" ? config.ruleSet : null;

  const prediction = useMemo<PackagingPrediction | null>(() => {
    if (!ruleSet || !point || !order) return null;
    return predictPackaging(ruleSet.body, point, order.lines, { replacement: !!csCaseId });
  }, [ruleSet, point, order, csCaseId]);

  const view = useMemo<OrderPackagingView | null>(() => {
    if (!ruleSet || !point || !prediction) return null;
    const current = chosen ?? prediction.evaluation.packages;
    return {
      point,
      prediction,
      chosen: current,
      status: pickStatus(prediction, current),
      alternatives: alternativesFor(ruleSet.body, point),
    };
  }, [ruleSet, point, prediction, chosen]);

  // Complete reads the latest view even when its closure is a render old.
  const viewRef = useRef(view);
  viewRef.current = view;
  const ruleSetRef = useRef(ruleSet);
  ruleSetRef.current = ruleSet;

  const tap = useCallback((item: CatalogueItem) => {
    const v = viewRef.current;
    if (v) setChosen(tapPackage(v.chosen, item));
  }, []);

  const adjust = useCallback((key: string, delta: number) => {
    const v = viewRef.current;
    if (v) setChosen(adjustPackage(v.chosen, key, delta));
  }, []);

  const reset = useCallback(() => setChosen(null), []);

  const scanLegacyBarcode = useCallback((barcode: string): boolean => {
    const v = viewRef.current;
    const rs = ruleSetRef.current;
    if (!v || !rs) return false;
    const item = packageFromLegacyBarcode(rs.body, barcode, v.point);
    if (!item) return false;
    // The first scan replaces the prediction; later scans add a box each.
    setChosen(v.status === "changed" ? addPackage(v.chosen, item) : [{ key: item.key, product_id: item.product_id, label: item.label, qty: 1 }]);
    return true;
  }, []);

  const applyAfterEvent = useCallback(
    async (eventId: string, forOrder: string): Promise<void> => {
      const v = viewRef.current;
      const rs = ruleSetRef.current;
      if (!v || !rs) return;
      try {
        const payload = buildApplyPayload({ ruleSet: rs, prediction: v.prediction, chosen: v.chosen });
        const result = await submitPackagingApply(
          client,
          outbox,
          { location, requestId: applyRequestId(eventId), eventId, ...payload },
          forOrder,
        );
        if (result.kind === "failed") onError(result.message);
      } catch (e) {
        onError(`Packaging for #${forOrder} was not recorded: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        refreshPending();
      }
    },
    [client, outbox, location, onError, refreshPending],
  );

  return {
    mode: config.mode,
    warning: config.warning,
    view,
    pendingCount,
    tap,
    adjust,
    reset,
    scanLegacyBarcode,
    applyAfterEvent,
  };
}
