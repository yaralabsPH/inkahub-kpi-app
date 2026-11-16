/**
 * Task 17: management views (Reports, Welcome) from ONE published generation.
 *
 * The identity of a view is (user, site, view, date range, staff, work type).
 * Changing it clears the previous result at once and aborts its requests; a
 * late response for an older identity or request is discarded. A refresh is
 * UNPINNED, so it discovers a newer published generation (pages of the old one
 * are dropped). Detail tables page within the DISPLAYED generation only; a 410
 * (expired generation) or a stale cursor reloads the whole view at the latest
 * generation and drops every loaded page, never mixing generations or reusing
 * a stale cursor. A failed refresh of the same identity keeps the previous
 * result, marked stale with the error. A site not yet on published reads reports
 * `legacy` so the page keeps its existing path (an explicit mode, not a silent
 * fallback). Whole-period totals always come from the summary, never from
 * loaded pages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { DETAIL_PAGE_MAX, type DetailKind, type Page, type PublishedDetailRow, type SummaryRequest, type SummaryResult } from "@/lib/domain/productionReporting";
import { detailKey, type PublishedState } from "@/lib/domain/productionPublishedState";
import { fetchPublishedDetail, fetchPublishedSummary, PublishedReadError, type FetchLike } from "@/lib/repository/supabase/productionPublished";

export interface PublishedIdentity extends Omit<SummaryRequest, "generationId"> {
  userId: string;
}
// The state shape and detail key live in the pure domain module; re-exported for existing callers.
export { detailKey, type PublishedState, type PublishedStatus } from "@/lib/domain/productionPublishedState";
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
  /** Running collectAll exports (aborted when the view is cleared or its identity changes). */
  private collectors = new Set<AbortController>();
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
  /**
   * Load (or refresh) a view at the LATEST published generation (never pinned); a new identity clears
   * the old result immediately. `dropPages` (stale cursor / expired generation) discards every loaded
   * page even when the generation is unchanged.
   */
  async load(identity: PublishedIdentity, opts: { dropPages?: boolean } = {}): Promise<void> {
    const key = identityKey(identity);
    const same = this.state.identityKey === key;
    this.abort?.abort();
    if (!same) this.abortCollectors();
    const ac = new AbortController();
    this.abort = ac;
    const mine = ++this.seq;
    // A stale-cursor/expired reload drops the pages at once, so even a failed reload never keeps the stale cursor.
    this.set(same ? { ...this.state, status: this.state.summary ? this.state.status : "loading", ...(opts.dropPages ? { details: {} } : {}) } : { ...EMPTY, status: "loading", identityKey: key });
    try {
      const token = await this.deps.token();
      if (!token) throw new PublishedReadError(401, "UNAUTHENTICATED", "Sign in again to load reports");
      const { userId: _u, ...req } = identity;
      void _u;
      const summary = await fetchPublishedSummary(this.deps.fetch, token, req, ac.signal); // unpinned: the latest publication
      if (mine !== this.seq || this.state.identityKey !== key) return; // superseded
      const keepPages = !opts.dropPages && this.state.summary?.meta.generationId === summary.meta.generationId;
      this.set({ status: summary.meta.state === "current" ? "current" : "stale", identityKey: key, summary, error: null, details: keepPages ? this.state.details : {} });
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
    // days/people continue the summary's OWN first page (its signed cursor): never page 1 again, never a duplicate row.
    const seed = !prev && !orderNumber && (kind === "days" || kind === "people") ? (kind === "days" ? s.summary.dailyPage : s.summary.peoplePage).nextCursor : undefined;
    if (seed === null) return; // the summary page already holds every row
    const cursor = prev?.nextCursor ?? seed;
    const token = await this.deps.token();
    if (!token) return void this.set({ ...this.state, status: "stale", error: "Sign in again to load reports" });
    const mine = this.seq;
    let page: Page<PublishedDetailRow>;
    try {
      page = await fetchPublishedDetail(this.deps.fetch, token, {
        site: identity.site, generationId: s.summary.meta.generationId, kind, firstDate: identity.firstDate, lastDate: identity.lastDate,
        ...(identity.staffId ? { staffId: identity.staffId } : {}), ...(identity.workType ? { workType: identity.workType } : {}), ...(orderNumber ? { orderNumber } : {}),
        ...(cursor ? { cursor } : {}), limit,
      });
    } catch (e) {
      if (mine !== this.seq || this.state.identityKey !== key) return;
      if (e instanceof PublishedReadError && (e.expired || e.code === "BAD_CURSOR")) return this.load(identity, { dropPages: true }); // stale cursor/generation: reload the whole view, latest generation
      return void this.set({ ...this.state, status: "stale", error: e instanceof Error ? e.message : String(e) });
    }
    if (mine !== this.seq || this.state.identityKey !== key || this.state.summary?.meta.generationId !== s.summary.meta.generationId) return;
    if (this.state.details[dkey] !== prev) return; // another page landed meanwhile: never append on a stale cursor
    const rows = [...(prev?.rows ?? []), ...page.rows];
    this.set({ ...this.state, details: { ...this.state.details, [dkey]: { rows, nextCursor: page.nextCursor, totalRows: page.totalRows } } });
  }
  private abortCollectors(): void {
    for (const ac of this.collectors) ac.abort();
    this.collectors.clear();
  }
  /**
   * Collect EVERY page of one detail kind (e.g. raw-export for the CSV) in the DISPLAYED generation and
   * filters, and return the rows to the caller (nothing is kept in the view). Opt-in only; bounded:
   * at most DETAIL_PAGE_MAX rows per page, a fresh token per page, the first page's totalRows fixed for
   * the run, and a refusal (never a partial result) on a repeated cursor, an empty page with a cursor,
   * more rows than the total, more pages than rows (each non-final page must add a row), a total that
   * changes, or a short end.
   * A change of identity or generation (or a cleared view) rejects with VIEW_CHANGED; a same-generation
   * refresh does not interrupt it. Typed page errors are rethrown as they are.
   */
  async collectAll(identity: PublishedIdentity, kind: DetailKind, opts: { limit?: number; orderNumber?: string } = {}): Promise<PublishedDetailRow[]> {
    const key = identityKey(identity);
    const s = this.state;
    if (!s.summary) throw new PublishedReadError(409, "NO_REPORT", "No report is shown to export");
    if (s.identityKey !== key) throw new PublishedReadError(409, "VIEW_CHANGED", "The report view changed; export again");
    const asked = opts.limit ?? DETAIL_PAGE_MAX;
    if (!Number.isInteger(asked) || asked < 1) throw new PublishedReadError(400, "BAD_REQUEST", "The page size must be a positive integer");
    const limit = Math.min(asked, DETAIL_PAGE_MAX);
    const generationId = s.summary.meta.generationId;
    const changed = () => this.state.identityKey !== key || this.state.summary?.meta.generationId !== generationId;
    const viewChanged = () => new PublishedReadError(409, "VIEW_CHANGED", "The report changed during the export; export again");
    const noProgress = (why: string) => new PublishedReadError(502, "NO_PROGRESS", `The export stopped: ${why}`);
    const ac = new AbortController();
    this.collectors.add(ac);
    try {
      const rows: PublishedDetailRow[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      let total: number | null = null;
      let pages = 0;
      for (;;) {
        const token = await this.deps.token(); // reauthorized for every page
        if (!token) throw new PublishedReadError(401, "UNAUTHENTICATED", "Sign in again to export");
        if (ac.signal.aborted || changed()) throw viewChanged();
        let page: Page<PublishedDetailRow>;
        try {
          page = await fetchPublishedDetail(this.deps.fetch, token, {
            site: identity.site, generationId, kind, firstDate: identity.firstDate, lastDate: identity.lastDate,
            ...(identity.staffId ? { staffId: identity.staffId } : {}), ...(identity.workType ? { workType: identity.workType } : {}), ...(opts.orderNumber ? { orderNumber: opts.orderNumber } : {}),
            ...(cursor ? { cursor } : {}), limit,
          }, ac.signal);
        } catch (e) {
          // Our own abort (cleared view / new identity) or a changed view: the typed VIEW_CHANGED, never a raw AbortError.
          if (ac.signal.aborted || changed()) throw viewChanged();
          throw e; // any other typed/network failure, unchanged
        }
        if (ac.signal.aborted || changed()) throw viewChanged();
        pages++;
        if (total === null) total = page.totalRows;
        else if (page.totalRows !== total) throw noProgress("the row count changed between pages");
        rows.push(...page.rows);
        if (rows.length > total) throw noProgress("more rows than the report holds");
        if (page.nextCursor === null) {
          if (rows.length !== total) throw new PublishedReadError(502, "INCOMPLETE", `The export ended with ${rows.length} of ${total} rows`);
          return rows;
        }
        if (page.rows.length === 0) throw noProgress("an empty page that is not the last");
        if (page.nextCursor === cursor || seen.has(page.nextCursor)) throw noProgress("a repeated page cursor");
        // every non-final page adds >= 1 row and rows never exceed the total: at most `total` pages
        if (pages >= total) throw noProgress("more pages than the row count allows");
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } finally {
      this.collectors.delete(ac);
    }
  }
  /**
   * Clear the view (its identity is gone: sign-out, unsupported site, no range): abort and invalidate
   * every in-flight summary/page so none can land later, and publish the empty state. Subscribers stay.
   */
  reset(): void {
    this.abort?.abort();
    this.abort = null;
    this.abortCollectors();
    this.seq++;
    this.inflight.clear();
    this.set(EMPTY);
  }
  dispose(): void {
    this.abort?.abort();
    this.abortCollectors();
    this.seq++;
    this.inflight.clear();
    this.listeners.clear();
  }
}

/**
 * React binding. `identity` null = nothing to load (unsupported site, signed
 * out, Dexie mode). The token comes from the caller's signed-in client.
 */
export function usePublishedProduction(identity: PublishedIdentity | null, deps: ControllerDeps | null, refreshKey = 0): PublishedState & {
  nextPage: (kind: DetailKind, limit?: number, orderNumber?: string) => void;
  refresh: () => void;
  /** Every page of one kind in the displayed generation (opt-in export); rejects when no report is shown. */
  collectAll: (kind: DetailKind, opts?: { limit?: number; orderNumber?: string }) => Promise<PublishedDetailRow[]>;
} {
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
    if (!idRef.current) {
      ctrl?.reset(); // no identity: nothing in flight may repopulate the old view
      return void setState(EMPTY);
    }
    if (!ctrl) return void setState(EMPTY);
    void ctrl.load(idRef.current);
  }, [ctrl, key, refreshKey]);
  return {
    ...state,
    nextPage: (kind, limit, orderNumber) => void (ctrl && idRef.current && ctrl.nextPage(idRef.current, kind, limit, orderNumber)),
    refresh: () => void (ctrl && idRef.current && ctrl.load(idRef.current)),
    collectAll: (kind, opts) =>
      ctrl && idRef.current ? ctrl.collectAll(idRef.current, kind, opts) : Promise.reject(new PublishedReadError(409, "NO_REPORT", "No report is shown to export")),
  };
}
