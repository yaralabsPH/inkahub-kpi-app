import { useEffect, useMemo, useRef, useState } from "react";
import { prepareProductionEvidence, snapshotCovers, type ProductionSnapshot } from "@/lib/domain/productionCounts";
import { isReportSite, productionDateAt, productionRange } from "@/lib/domain/productionPeriods";
import type { EvidenceRpcClient } from "@/lib/repository/supabase/productionEvidence";
import type { ScanMode } from "@/lib/scanners/dispatch";
import { buildScannerWallTotals, type WallTotalsView } from "@/lib/scanners/wallTotals";
import { loadScannerWallEvidence, WALL_READ_DEADLINE_MS } from "@/lib/scanners/wallTotalsClient";
import { createWallTotalsRefresh } from "@/lib/scanners/wallTotalsRefresh";

/** A snapshot older than this is shown as stale. */
export const WALL_STALE_MS = 90_000;

export interface UseScannerWallTotalsArgs {
  client: EvidenceRpcClient | null;
  site: string;
  callerId: string | null;
  mode: ScanMode;
  roleAllowed: boolean;
  /** People currently verified on the wall's scanners (duplicates allowed). */
  personIds: readonly string[];
  /** Stable scanner→person map; changes only when a scanner changes hands. */
  bindingKey: string;
  /** Bumped by the controller on saved / already-recorded answers. */
  saveRevision: number;
  online: boolean;
  visible: boolean;
  /** Wall clock (ms), ticking. */
  now: number;
}

interface Loaded {
  snapshot: ProductionSnapshot;
  /** The scanner→person map when this read started. */
  bindingKey: string;
}

/**
 * scanner-wall-redesign: today's per-person totals for the wall. One shared
 * read per wall, current site production day (04:00 local), refreshed after
 * saves and every minute. Display only.
 */
export function useScannerWallTotals(a: UseScannerWallTotalsArgs): WallTotalsView {
  const site = isReportSite(a.site) ? a.site : null;
  const day = site ? productionDateAt(new Date(a.now), site) : null;
  const range = useMemo(() => (site && day ? productionRange(site, day, day) : null), [site, day]);
  const enabled = !!a.client && !!site && !!a.callerId && a.roleAllowed && a.mode === "framing" && a.online && a.visible;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest map, read synchronously when a read starts.
  const bindingRef = useRef(a.bindingKey);
  bindingRef.current = a.bindingKey;
  const startedKey = useRef(a.bindingKey);
  const lastKnown = useRef<Record<string, { orders: number; pieces: number | null }>>({});
  const refresher = useRef<ReturnType<typeof createWallTotalsRefresh<ReturnType<typeof setTimeout>>> | null>(null);

  // A new account, site, day or mode starts from nothing: never show another scope's numbers.
  const scopeKey = `${a.callerId ?? ""}|${site ?? ""}|${day ?? ""}|${a.mode}`;
  useEffect(() => {
    setLoaded(null);
    setError(null);
    lastKnown.current = {};
    const client = a.client;
    if (!client || !site) return;
    const r = createWallTotalsRefresh<ReturnType<typeof setTimeout>>({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h),
      read: () => {
        // Built when the read starts: today's day and cutoff at that moment.
        startedKey.current = bindingRef.current;
        const today = productionRange(site, productionDateAt(new Date(), site), productionDateAt(new Date(), site));
        return loadScannerWallEvidence(client, {
          site,
          range: { startUtc: today.startUtc, endUtcExclusive: today.endUtcExclusive },
          asOfUtc: new Date().toISOString(),
          visibility: { kind: "site" }, // owner/manager/kiosk only (roleAllowed)
          deadlineMs: Date.now() + WALL_READ_DEADLINE_MS,
        });
      },
      publish: ({ snapshot, error: e }) => {
        if (snapshot) {
          setLoaded({ snapshot, bindingKey: startedKey.current });
          setError(null);
        } else {
          setError(e);
        }
      },
    });
    refresher.current = r;
    return () => {
      r.dispose();
      if (refresher.current === r) refresher.current = null;
    };
    // a.client is stable for the station's lifetime; scopeKey covers the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  useEffect(() => {
    refresher.current?.setEnabled(enabled);
  }, [enabled, scopeKey]);

  // A scanner changing hands: everyone on the wall waits for a read started after it.
  useEffect(() => {
    refresher.current?.request();
  }, [a.bindingKey]);

  // A save: re-read (coalesced and rate-limited by the refresher).
  useEffect(() => {
    if (a.saveRevision > 0) refresher.current?.request();
  }, [a.saveRevision]);

  const people = useMemo(() => [...new Set(a.personIds)].sort(), [a.personIds]);
  const fresh = loaded && range && snapshotCovers(loaded.snapshot, range) ? loaded : null;
  const totals = useMemo(() => {
    if (!fresh || !range) return null;
    try {
      return buildScannerWallTotals(prepareProductionEvidence(fresh.snapshot), range, people);
    } catch {
      return null;
    }
  }, [fresh, range, people]);

  if (totals) {
    for (const [id, t] of Object.entries(totals.byPerson)) lastKnown.current[id] = { orders: t.orders, pieces: t.pieces };
  }

  // Numbers read under another scanner→person map are not shown as current.
  const pendingPersonIds = fresh && fresh.bindingKey === a.bindingKey ? [] : people;
  const age = fresh ? a.now - Date.parse(fresh.snapshot.loadedAtUtc) : Number.POSITIVE_INFINITY;
  const status: WallTotalsView["status"] = totals
    ? age > WALL_STALE_MS || error ? "stale" : "current"
    : error ? "unavailable" : "loading";
  return {
    status,
    totals,
    pendingPersonIds,
    loadedAtUtc: fresh?.snapshot.loadedAtUtc ?? null,
    message: error,
    lastKnown: lastKnown.current,
  };
}
