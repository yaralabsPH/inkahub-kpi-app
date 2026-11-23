/**
 * F8 Reports v2: load one published period overview from /api/reports/overview.
 *
 * Identity = signed-in user + every request filter. A new identity clears the
 * shown data at once, aborts the previous request and ignores any late answer
 * for an older identity, so one user's or site's figures never appear under
 * another. The bearer token is read at call time; the server re-authorizes.
 */
import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { overviewKey, overviewQuery, type OverviewRequest, type OverviewResult } from "@/lib/domain/reportsOverview";

export type OverviewStatus = "idle" | "loading" | "ready" | "not_ready" | "error";
export interface OverviewState {
  key: string;
  status: OverviewStatus;
  data: OverviewResult | null;
  error: string | null;
  code: string | null;
}
export const IDLE_OVERVIEW: OverviewState = { key: "", status: "idle", data: null, error: null, code: null };

/** Not an error to retry blindly: the site has no usable publication (yet). */
const NOT_READY = new Set(["READ_MODE_LEGACY", "READ_MODE_SHADOW", "UNAVAILABLE"]);

export interface OverviewLoaderDeps {
  fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  token: () => Promise<string | null>;
  onChange: (s: OverviewState) => void;
}

export function createOverviewLoader(deps: OverviewLoaderDeps) {
  let state: OverviewState = IDLE_OVERVIEW;
  let ac: AbortController | null = null;
  let seq = 0;
  const set = (s: OverviewState) => {
    state = s;
    deps.onChange(s);
  };
  return {
    state: () => state,
    /** Load (or reload, for Retry) one identity. */
    async load(userId: string | null, request: OverviewRequest | null): Promise<void> {
      ac?.abort();
      const key = overviewKey(userId, request);
      const mine = ++seq;
      if (!request || !userId) {
        ac = null;
        set(IDLE_OVERVIEW);
        return;
      }
      const controller = new AbortController();
      ac = controller;
      // a different identity never keeps the previous figures on screen
      set({ key, status: "loading", data: state.key === key ? state.data : null, error: null, code: null });
      const current = () => mine === seq && !controller.signal.aborted;
      try {
        const token = await deps.token();
        if (!current()) return;
        if (!token) return set({ key, status: "error", data: null, error: "Sign in again to load the report", code: "UNAUTHENTICATED" });
        const res = await deps.fetch(`/api/reports/overview?${overviewQuery(request)}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!current()) return;
        if (!res.ok) {
          const code = typeof body?.code === "string" ? body.code : `HTTP_${res.status}`;
          const error = typeof body?.error === "string" ? body.error : `The report could not be loaded (${res.status})`;
          return set({ key, status: NOT_READY.has(code) ? "not_ready" : "error", data: null, error, code });
        }
        set({ key, status: "ready", data: body as unknown as OverviewResult, error: null, code: null });
      } catch (e) {
        if (!current()) return;
        set({ key, status: "error", data: null, error: e instanceof Error ? e.message : String(e), code: "NETWORK" });
      }
    },
    dispose() {
      ac?.abort();
      seq++;
    },
  };
}

/** React binding. `request` null = nothing to load. `refreshKey` forces a reload of the same identity. */
export function useReportsOverview(supabase: SupabaseClient, userId: string | null, request: OverviewRequest | null, refreshKey: number): OverviewState {
  const [state, setState] = useState<OverviewState>(IDLE_OVERVIEW);
  const loader = useMemo(
    () =>
      createOverviewLoader({
        fetch: (url, init) => window.fetch(url, init),
        token: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        onChange: setState,
      }),
    [supabase],
  );
  const key = overviewKey(userId, request);
  useEffect(() => {
    void loader.load(userId, request);
    // the key captures every request field
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, refreshKey]);
  useEffect(() => () => loader.dispose(), [loader]);
  // Render-time guard: never show a state that belongs to another identity.
  return state.key === key ? state : { ...IDLE_OVERVIEW, key, status: request && userId ? "loading" : "idle" };
}
