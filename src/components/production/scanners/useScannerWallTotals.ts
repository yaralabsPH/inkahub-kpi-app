import { useEffect, useMemo, useRef, useState } from "react";
import { prepareProductionEvidence, snapshotCovers, type ProductionSnapshot } from "@/lib/domain/productionCounts";
import { isReportSite, productionDateAt, productionRange } from "@/lib/domain/productionPeriods";
import type { EvidenceRpcClient } from "@/lib/repository/supabase/productionEvidence";
import type { ScanMode } from "@/lib/scanners/dispatch";
import { buildScannerWallTotals, type WallTotalsView } from "@/lib/scanners/wallTotals";
import { loadScannerWallEvidence, WALL_READ_DEADLINE_MS } from "@/lib/scanners/wallTotalsClient";
import { createWallTotalsRefresh } from "@/lib/scanners/wallTotalsRefresh";
import { createBindingGeneration, wallTotalsAccess } from "@/lib/scanners/wallTotalsScope";

/** A snapshot older than this is shown as delayed. */
export const WALL_STALE_MS = 90_000;

export interface UseScannerWallTotalsArgs {
  client: EvidenceRpcClient | null;
  site: string;
  callerId: string | null;
  /** The caller's role (owner/manager/kiosk read the whole site). */
  role: string | null;
  /** The caller is a confirmed member of this site. */
  siteMember: boolean;
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
  /** Access/site/day/mode scope the read ran under. */
  scope: string;
  /** Binding generation current when the read started. */
  gen: number;
}

const EMPTY: WallTotalsView = { status: "unavailable", totals: null, pendingPersonIds: [], loadedAtUtc: null, message: null, lastKnown: {} };

/**
 * scanner-wall-redesign: today's per-person totals for the wall. One shared
 * read per wall, current site production day (04:00 local), refreshed after
 * saves and every minute. Display only; shown only to an account that can
 * read the whole site (owner/manager/kiosk with confirmed site membership).
 */
export function useScannerWallTotals(a: UseScannerWallTotalsArgs): WallTotalsView {
  const site = isReportSite(a.site) ? a.site : null;
  const day = site ? productionDateAt(new Date(a.now), site) : null;
  const range = useMemo(() => (site && day ? productionRange(site, day, day) : null), [site, day]);
  const access = wallTotalsAccess({
    hasClient: !!a.client, site: a.site, callerId: a.callerId, roleAllowed: a.roleAllowed, role: a.role, siteMember: a.siteMember,
  });
  const enabled = access && a.mode === "framing" && a.online && a.visible;
  // Everything that decides what may be shown; a change hides old numbers in the same render.
  const scope = `${a.callerId ?? ""}|${a.role ?? ""}|${a.siteMember}|${a.roleAllowed}|${site ?? ""}|${day ?? ""}|${a.mode}`;

  // Monotonic binding generation, bumped in the same render the map changes.
  const bindings = useRef<ReturnType<typeof createBindingGeneration> | null>(null);
  if (!bindings.current) bindings.current = createBindingGeneration(a.bindingKey);
  const gen = bindings.current.observe(a.bindingKey);
  const genRef = useRef(gen);
  genRef.current = gen;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ scope: string; message: string } | null>(null);
  const lastKnown = useRef<{ scope: string; byPerson: Record<string, { orders: number; pieces: number | null; asOfUtc: string }> }>({ scope, byPerson: {} });
  const refresher = useRef<ReturnType<typeof createWallTotalsRefresh<ReturnType<typeof setTimeout>>> | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    const client = a.client;
    if (!client || !site || !access) return;
    const readSite = site;
    const readScope = scope;
    let started = { gen: genRef.current };
    const r = createWallTotalsRefresh<ReturnType<typeof setTimeout>>({
      now: () => Date.now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h),
      read: (signal) => {
        // Built when the read starts: today's day, cutoff and binding at that moment.
        started = { gen: genRef.current };
        const today = productionDateAt(new Date(), readSite);
        const span = productionRange(readSite, today, today);
        return loadScannerWallEvidence(client, {
          site: readSite,
          range: { startUtc: span.startUtc, endUtcExclusive: span.endUtcExclusive },
          asOfUtc: new Date().toISOString(),
          visibility: { kind: "site" }, // access above requires a site-wide role and membership
          signal,
          deadlineMs: Date.now() + WALL_READ_DEADLINE_MS,
        });
      },
      publish: ({ snapshot, error: e }) => {
        if (scopeRef.current !== readScope) return;
        if (snapshot) {
          setLoaded({ snapshot, scope: readScope, gen: started.gen });
          setError(null);
        } else {
          setError({ scope: readScope, message: e ?? "Read failed" });
        }
      },
    });
    refresher.current = r;
    return () => {
      r.dispose(); // aborts a running read; nothing late is published
      if (refresher.current === r) refresher.current = null;
    };
    // a.client is stable for the station's lifetime; `scope` covers the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, access]);

  useEffect(() => {
    refresher.current?.setEnabled(enabled);
  }, [enabled, scope, access]);

  // A scanner changing hands: everyone on the wall waits for a read started after it.
  useEffect(() => {
    refresher.current?.request();
  }, [a.bindingKey]);

  // A save: re-read (coalesced and rate-limited by the refresher).
  useEffect(() => {
    if (a.saveRevision > 0) refresher.current?.request();
  }, [a.saveRevision]);

  const people = useMemo(() => [...new Set(a.personIds)].sort(), [a.personIds]);
  const fresh = access && loaded && loaded.scope === scope && range && snapshotCovers(loaded.snapshot, range) ? loaded : null;
  const ready = !!fresh && fresh.gen === gen;
  const totals = useMemo(() => {
    if (!fresh || !range) return null;
    try {
      return buildScannerWallTotals(prepareProductionEvidence(fresh.snapshot), range, people);
    } catch {
      return null;
    }
  }, [fresh, range, people]);

  if (!access) return EMPTY;

  if (lastKnown.current.scope !== scope) lastKnown.current = { scope, byPerson: {} };
  // Only numbers read for the current people are remembered (for goodbyes).
  if (totals && ready) {
    for (const [id, t] of Object.entries(totals.byPerson)) {
      lastKnown.current.byPerson[id] = { orders: t.orders, pieces: t.pieces, asOfUtc: fresh!.snapshot.asOfUtc };
    }
  }

  const err = error && error.scope === scope ? error.message : null;
  const age = fresh ? a.now - Date.parse(fresh.snapshot.loadedAtUtc) : Number.POSITIVE_INFINITY;
  const status: WallTotalsView["status"] = totals
    ? age > WALL_STALE_MS || err ? "stale" : "current"
    : err ? "unavailable" : "loading";
  return {
    status,
    totals,
    pendingPersonIds: ready ? [] : people,
    loadedAtUtc: fresh?.snapshot.loadedAtUtc ?? null,
    message: err,
    lastKnown: lastKnown.current.byPerson,
  };
}
