/**
 * Task 17: management views (Reports, Welcome) from ONE published generation.
 *
 * The identity of a view is (user, site, view, date range, staff, work type).
 * Changing it clears the previous result at once and aborts its requests; a
 * late response for an older identity or request is discarded. A result pins
 * its generation; detail tables page within that generation only. A 410
 * (expired generation) reloads the whole view together, never mixing
 * generations. A failed refresh of the same identity keeps the previous result,
 * marked stale with the error. A site not yet on published reads reports
 * `legacy` so the page keeps its existing path (an explicit mode, not a silent
 * fallback). Whole-period totals always come from the summary, never from
 * loaded pages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { DetailKind, Page, PublishedDetailRow, SummaryRequest, SummaryResult } from "@/lib/domain/productionReporting";
import { fetchPublishedDetail, fetchPublishedSummary, PublishedReadError, type FetchLike } from "@/lib/repository/supabase/productionPublished";

export interface PublishedIdentity extends Omit<SummaryRequest, "generationId"> {
  userId: string;
}
export type PublishedStatus = "idle" | "loading" | "current" | "stale" | "legacy" | "error";
export interface PublishedState {
  status: PublishedStatus;
  identityKey: string | null;
  summary: SummaryResult | null;
  error: string | null;
  /** Loaded detail pages per complete selector (`detailKey`), all in the generation of `summary`. */
  details: Partial<Record<string, { rows: PublishedDetailRow[]; nextCursor: string | null; totalRows: number }>>;
}

/** A detail table's complete selector within a view: kind plus every detail-only filter (order number). */
export const detailKey = (kind: DetailKind, orderNumber?: string | null) => JSON.stringify([kind, orderNumber ?? null]);
export const identityKey = (i: PublishedIdentity) => JSON.stringify([i.userId, i.site, i.view, i.firstDate, i.lastDate, i.staffId ?? null, i.workType ?? null]);
const EMPTY: PublishedState = { status: "idle", identityKey: null, summary: null, error: null, details: {} };

export interface ControllerDeps {
  fetch: FetchLike;
  token(): Promise<string | null>;
}

/** Framework-free state machine behind the hook (tested directly). */
export class PublishedViewController {
  private state: PublishedState = EMPTY;
  private seq = 0;
  private abort: AbortController | null = null;
  private listeners = new Set<() => void>();
  /** One in-flight page request per selector (a concurrent call joins it: no duplicate page). */
  private inflight = new Map<string, Promise<void>>();
  constructor(private readonly deps: ControllerDeps) {}
  get(): PublishedState {
    return this.state;
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private set(s: PublishedState) {
    this.state = s;
    for (const fn of this.listeners) fn();
  }
  /** Load (or refresh) a view; a new identity clears the old result immediately. */
  async load(identity: PublishedIdentity): Promise<void> {
    const key = identityKey(identity);
    const same = this.state.identityKey === key;
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    const mine = ++this.seq;
    this.set(same ? { ...this.state, status: this.state.summary ? this.state.status : "loading" } : { ...EMPTY, status: "loading", identityKey: key });
    const pin = same ? this.state.summary?.meta.generationId : undefined;
    const run = async (generationId: string | undefined): Promise<SummaryResult> => {
      const token = await this.deps.token();
      if (!token) throw new PublishedReadError(401, "UNAUTHENTICATED", "Sign in again to load reports");
      const { userId: _u, ...req } = identity;
      void _u;
      return fetchPublishedSummary(this.deps.fetch, token, { ...req, ...(generationId ? { generationId } : {}) }, ac.signal);
    };
    try {
      let summary: SummaryResult;
      try {
        summary = await run(pin);
      } catch (e) {
        // An expired pinned generation: reload the WHOLE view at the current generation (pages are dropped below).
        if (e instanceof PublishedReadError && e.expired && pin) summary = await run(undefined);
        else throw e;
      }
      if (mine !== this.seq || this.state.identityKey !== key) return; // superseded
      const sameGeneration = this.state.summary?.meta.generationId === summary.meta.generationId;
      this.set({ status: summary.meta.state === "current" ? "current" : "stale", identityKey: key, summary, error: null, details: sameGeneration ? this.state.details : {} });
    } catch (e) {
      if (mine !== this.seq || this.state.identityKey !== key) return;
      if (e instanceof PublishedReadError && e.legacyMode) return void this.set({ ...EMPTY, status: "legacy", identityKey: key });
      const message = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted) return;
      this.set(this.state.summary ? { ...this.state, status: "stale", error: message } : { ...EMPTY, status: "error", identityKey: key, error: message });
    }
  }
  /** Load the next page of one detail table in the summary's generation. A 410 reloads the whole view. */
  nextPage(identity: PublishedIdentity, kind: DetailKind, limit = 200, orderNumber?: string): Promise<void> {
    const dk = `${identityKey(identity)}|${String(this.state.summary?.meta.generationId)}|${detailKey(kind, orderNumber)}`;
    const running = this.inflight.get(dk);
    if (running) return running;
    const p = this.fetchPage(identity, kind, limit, orderNumber).finally(() => {
      if (this.inflight.get(dk) === p) this.inflight.delete(dk);
    });
    this.inflight.set(dk, p);
    return p;
  }
  private async fetchPage(identity: PublishedIdentity, kind: DetailKind, limit: number, orderNumber?: string): Promise<void> {
    const key = identityKey(identity);
    const dkey = detailKey(kind, orderNumber);
    const s = this.state;
    if (s.identityKey !== key || !s.summary) return;
    const prev = s.details[dkey];
    if (prev && prev.nextCursor === null) return; // complete
    const token = await this.deps.token();
    if (!token) return void this.set({ ...this.state, status: "stale", error: "Sign in again to load reports" });
    const mine = this.seq;
    let page: Page<PublishedDetailRow>;
    try {
      page = await fetchPublishedDetail(this.deps.fetch, token, {
        site: identity.site, generationId: s.summary.meta.generationId, kind, firstDate: identity.firstDate, lastDate: identity.lastDate,
        ...(identity.staffId ? { staffId: identity.staffId } : {}), ...(identity.workType ? { workType: identity.workType } : {}), ...(orderNumber ? { orderNumber } : {}),
        ...(prev?.nextCursor ? { cursor: prev.nextCursor } : {}), limit,
      });
    } catch (e) {
      if (mine !== this.seq || this.state.identityKey !== key) return;
      if (e instanceof PublishedReadError && (e.expired || e.code === "BAD_CURSOR")) return this.load(identity); // stale cursor/generation: reload the whole view
      return void this.set({ ...this.state, status: "stale", error: e instanceof Error ? e.message : String(e) });
    }
    if (mine !== this.seq || this.state.identityKey !== key || this.state.summary?.meta.generationId !== s.summary.meta.generationId) return;
    if (this.state.details[dkey] !== prev) return; // another page landed meanwhile: never append on a stale cursor
    const rows = [...(prev?.rows ?? []), ...page.rows];
    this.set({ ...this.state, details: { ...this.state.details, [dkey]: { rows, nextCursor: page.nextCursor, totalRows: page.totalRows } } });
  }
  dispose(): void {
    this.abort?.abort();
    this.seq++;
    this.inflight.clear();
    this.listeners.clear();
  }
}

/**
 * React binding. `identity` null = nothing to load (unsupported site, signed
 * out, Dexie mode). The token comes from the caller's signed-in client.
 */
export function usePublishedProduction(identity: PublishedIdentity | null, deps: ControllerDeps | null, refreshKey = 0): PublishedState & { nextPage: (kind: DetailKind, limit?: number, orderNumber?: string) => void; refresh: () => void } {
  const ctrl = useMemo(() => (deps ? new PublishedViewController(deps) : null), [deps]);
  const [state, setState] = useState<PublishedState>(EMPTY);
  const idRef = useRef(identity);
  idRef.current = identity;
  const key = identity ? identityKey(identity) : null;
  useEffect(() => {
    if (!ctrl) return;
    const off = ctrl.subscribe(() => setState(ctrl.get()));
    return () => {
      off();
      ctrl.dispose();
    };
  }, [ctrl]);
  useEffect(() => {
    if (!ctrl || !idRef.current) return void setState(EMPTY);
    void ctrl.load(idRef.current);
  }, [ctrl, key, refreshKey]);
  return {
    ...state,
    nextPage: (kind, limit, orderNumber) => void (ctrl && idRef.current && ctrl.nextPage(idRef.current, kind, limit, orderNumber)),
    refresh: () => void (ctrl && idRef.current && ctrl.load(idRef.current)),
  };
}
