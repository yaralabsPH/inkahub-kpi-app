/**
 * Browser hook for F1 production evidence (Reports, Welcome, Production).
 *
 * One refresh = one fixed `asOfUtc`, one evidence RPC, one prepared snapshot.
 * The query identity (user, site, window, visibility) is part of every result:
 * changing it clears the previous result at once, and a late response for an
 * older identity or an older refresh is discarded. A failed refresh of the
 * same identity keeps the previous snapshot, marked stale with the error.
 * Never constructs a Supabase client; the caller passes the signed-in one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import {
  prepareProductionEvidence,
  summarizeProduction,
  type PreparedProductionEvidence,
  type ProductionScope,
  type ProductionSnapshot,
  type ProductionSummary,
  type ProductionVisibility,
  type UtcWindow,
} from "@/lib/domain/productionCounts";
import { isReportSite } from "@/lib/domain/productionPeriods";
import {
  loadProductionEvidence,
  ProductionReadError,
  productionVisibilityFor,
} from "@/lib/repository/supabase/productionEvidence";

export type ProductionLoadStatus = "unavailable" | "loading" | "current" | "stale" | "error";

export interface ProductionEvidenceState {
  status: ProductionLoadStatus;
  /** True while a refresh is in flight (also when an older result is still shown). */
  updating: boolean;
  snapshot: ProductionSnapshot | null;
  prepared: PreparedProductionEvidence | null;
  error: string | null;
  /** Why the period is unavailable (unsupported site, no client). */
  unavailableReason: string | null;
  visibility: ProductionVisibility | null;
  refresh: () => void;
}

export interface ProductionEvidenceOptions {
  client: SupabaseClient | null;
  site: string;
  /** Enclosing window to load; null = nothing to load yet. */
  range: UtcWindow | null;
  /** Bump to force a refresh of the same identity. */
  refreshKey?: number;
  /** Also refresh when the tab regains focus or becomes visible. */
  refreshOnFocus?: boolean;
  /** Retries after a failed/incomplete read (default 2). */
  retries?: number;
  /** Per-attempt time limit in ms (default 30 s). */
  timeoutMs?: number;
}

interface Result {
  identity: string;
  snapshot: ProductionSnapshot | null;
  prepared: PreparedProductionEvidence | null;
  error: string | null;
  loading: boolean;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ProductionReadError("aborted", "Production read was cancelled."));
    }, { once: true });
  });

export function useProductionEvidence(opts: ProductionEvidenceOptions): ProductionEvidenceState {
  const auth = useAuthOptional();
  const userId = auth?.user?.id ?? null;
  const role = auth?.profile?.role ?? null;
  const supported = isReportSite(opts.site);
  const visibility = useMemo<ProductionVisibility | null>(
    () => (supported ? productionVisibilityFor(role, !!auth?.locations?.includes(opts.site)) : null),
    [supported, role, auth?.locations, opts.site],
  );
  const unavailableReason = !supported
    ? `Production periods are defined for AU, UK and US only; "${opts.site}" has no production timezone.`
    : !opts.client
      ? "Production counts need the Supabase backend."
      : null;
  const identity = unavailableReason || !opts.range || !visibility
    ? ""
    : [userId ?? "anon", opts.site, opts.range.startUtc, opts.range.endUtcExclusive, visibility.kind].join("|");

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const [result, setResult] = useState<Result>({ identity: "", snapshot: null, prepared: null, error: null, loading: false });
  const seq = useRef(0);

  useEffect(() => {
    if (!opts.refreshOnFocus) return;
    const onFocus = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [opts.refreshOnFocus, refresh]);

  const client = opts.client;
  const range = opts.range;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  useEffect(() => {
    if (!identity || !client || !range || !visibility) return;
    const mine = ++seq.current;
    const controller = new AbortController();
    // Same identity keeps the shown result while updating; a new identity clears it.
    setResult((r) => (r.identity === identity ? { ...r, loading: true } : { identity, snapshot: null, prepared: null, error: null, loading: true }));
    const asOfUtc = new Date().toISOString();
    (async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (attempt > 0) await sleep(500 * attempt, controller.signal);
          const snapshot = await loadProductionEvidence(client, {
            site: opts.site,
            range,
            asOfUtc,
            visibility,
            signal: controller.signal,
            deadlineMs: Date.now() + timeoutMs,
          });
          const prepared = prepareProductionEvidence(snapshot);
          if (mine !== seq.current) return;
          setResult({ identity, snapshot, prepared, error: null, loading: false });
          return;
        } catch (e) {
          if (mine !== seq.current || controller.signal.aborted) return;
          lastError = e;
          const retryable = e instanceof ProductionReadError && (e.kind === "failed" || e.kind === "incomplete");
          if (!retryable) break;
        }
      }
      if (mine !== seq.current) return;
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      setResult((r) => (r.identity === identity ? { ...r, error: message, loading: false } : { identity, snapshot: null, prepared: null, error: message, loading: false }));
    })();
    return () => controller.abort();
    // opts.site is part of identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, client, opts.refreshKey, nonce, retries, timeoutMs]);

  const own = result.identity === identity && identity !== "";
  const snapshot = own ? result.snapshot : null;
  const prepared = own ? result.prepared : null;
  const error = own ? result.error : null;
  const loading = !own || result.loading;
  const status: ProductionLoadStatus = unavailableReason
    ? "unavailable"
    : snapshot && error
      ? "stale"
      : snapshot
        ? "current"
        : error && !loading
          ? "error"
          : "loading";
  return { status, updating: !unavailableReason && loading, snapshot, prepared, error, unavailableReason, visibility, refresh };
}

/** Evidence plus one summary for a display scope. */
export function useProductionSummary(
  opts: ProductionEvidenceOptions,
  scope: ProductionScope | null,
): ProductionEvidenceState & { summary: ProductionSummary | null } {
  const state = useProductionEvidence(opts);
  const summary = useMemo(
    () => (state.prepared && scope ? summarizeProduction(state.prepared, scope) : null),
    [state.prepared, scope],
  );
  return { ...state, summary };
}
