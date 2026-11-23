/**
 * F9 Frame timing section, under the published summary. It always asks for the
 * summary's DISPLAYED generationId and filters, through the same request
 * lifecycle (identity = trusted scope + filters + generation; old answers are
 * dropped), so its cutoff can never differ from the figures above it.
 */
import { useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { csvCell, overviewQuery, type OverviewRequest } from "@/lib/domain/reportsOverview";
import { frameTimingCsv, type FrameTimingBody } from "@/lib/domain/frameTimingReport";
import type { PublishedMeta } from "@/lib/domain/productionReporting";
import { createOverviewLoader, IDLE_OVERVIEW, type OverviewState } from "@/lib/hooks/useReportsOverview";

export type TimingRequest = OverviewRequest & { generationId: string };
export interface FrameTimingResultView extends FrameTimingBody { meta: PublishedMeta; request: TimingRequest }

export const timingQuery = (r: TimingRequest) => `${overviewQuery(r)}&generationId=${encodeURIComponent(r.generationId)}`;

export function useFrameTiming(supabase: SupabaseClient, scopeKey: string | null, request: TimingRequest | null, refreshKey: number): OverviewState<FrameTimingResultView> {
  const [state, setState] = useState<OverviewState<FrameTimingResultView>>({ ...IDLE_OVERVIEW, data: null });
  const loader = useMemo(
    () =>
      createOverviewLoader<TimingRequest, FrameTimingResultView>({
        path: "/api/reports/timing",
        queryOf: timingQuery,
        fetch: (url, init) => window.fetch(url, init),
        token: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        onChange: setState,
      }),
    [supabase],
  );
  const key = request && scopeKey ? `${scopeKey}|${timingQuery(request)}` : "";
  useEffect(() => {
    void loader.load(scopeKey, request);
    // the key captures every request field and the pinned generation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, key, refreshKey]);
  useEffect(() => () => loader.dispose(), [loader]);
  return state.key === key ? state : { ...IDLE_OVERVIEW, data: null, key, status: key ? "loading" : "idle" };
}

const m = (n: number | null) => (n === null ? "—" : n.toFixed(1));

export function FrameTimingSection({ supabase, scopeKey, request }: { supabase: SupabaseClient; scopeKey: string; request: TimingRequest }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const state = useFrameTiming(supabase, scopeKey, request, refreshKey);
  return <FrameTimingView state={state} onRetry={() => setRefreshKey((n) => n + 1)} />;
}

export function FrameTimingView({ state, onRetry }: { state: OverviewState<FrameTimingResultView>; onRetry: () => void }) {
  const d = state.status === "ready" ? state.data : null;
  const download = () => {
    if (!d) return;
    const f = d.request;
    const filters = [f.staffId ? `person ${f.staffId}` : null, f.workType ? `work ${f.workType}` : null, f.departmentId ? `department ${f.departmentId}` : null].filter(Boolean).join("; ") || "none";
    const csv = frameTimingCsv(d, { site: f.site, firstDate: f.firstDate, lastDate: f.lastDate, generationId: d.meta.generationId, sourceCutoffUtc: d.meta.sourceCutoffUtc, filters }, (v) => csvCell(v));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `frame-timing_${f.site}_${f.firstDate}_to_${f.lastDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label="Frame timing" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Frame timing</h3>
        <Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw size={14} /> Refresh</Button>
        <Button variant="secondary" size="sm" onClick={download} disabled={!d}><Download size={14} /> Timing CSV</Button>
      </div>
      <p className="text-[11px] text-slate-500">
        Measured = scan gaps: minutes since the same person's previous framing scan (gaps over 30 minutes, or across a clock-in/out, another kind of scan or the 04:00 day start, are not timed). This is not stopwatch timing.
        Estimated = Max method: 405/450 of verified shift attendance (at most 450 minutes) minus measured minutes, shared by size weights. The two are never combined.
      </p>
      {state.status === "loading" ? <div className="text-xs text-slate-500" role="status">Loading frame timing…</div> : null}
      {state.status === "not_ready" ? <div className="text-xs text-slate-600" role="status">Frame timing is not ready: {state.error} <button type="button" className="underline" onClick={onRetry}>Check again</button></div> : null}
      {state.status === "error" ? <div className="text-xs text-rose-700 dark:text-rose-300" role="alert">Couldn't load frame timing: {state.error} <button type="button" className="underline" onClick={onRetry}>Retry</button></div> : null}
      {d ? (
        <>
          <div className="text-[11px] text-slate-500" role="status">
            Same report version as the summary ({d.meta.generationId.slice(0, 8)}).{" "}
            {d.weights ? `Estimates use size weights version ${d.weights.version} — an assumption applied to this report.` : "No size weights saved for this site: estimates are unavailable."}{" "}
            Coverage: {d.coverage.timedPieces} of {d.coverage.framePieces} frame pieces measured; {d.coverage.estimatedPieces} estimated; {d.coverage.unavailablePieces} unavailable
            {d.coverage.noAttendancePieces ? ` (${d.coverage.noAttendancePieces} without a verified shift` : " ("}
            {d.coverage.missingWeightPieces ? `${d.coverage.noAttendancePieces ? ", " : ""}${d.coverage.missingWeightPieces} missing a weight${d.coverage.missingWeightSizes.length ? `: ${d.coverage.missingWeightSizes.join(", ")}` : ""}` : ""})
            {d.coverage.malformedAttendanceDays ? `; ${d.coverage.malformedAttendanceDays} day(s) with incomplete clock records` : ""}.
          </div>
          {d.groups.length === 0 ? (
            <div className="text-xs text-slate-500">No framing scans in this period.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="py-1">Frame</th><th>Work</th><th>Pieces</th><th>Measured pieces</th><th>Measured min/piece</th><th>Estimated pieces</th><th>Estimated min/piece</th><th>Unavailable</th>
                </tr>
              </thead>
              <tbody>
                {d.groups.map((g) => (
                  <tr key={`${g.key}|${g.rework}`} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1">{g.key}</td>
                    <td>{g.rework ? "CS/rework" : "normal"}</td>
                    <td className="tabular-nums">{g.pieces}</td>
                    <td className="tabular-nums">{g.timedPieces}</td>
                    <td className="tabular-nums">{m(g.measuredAvg)}</td>
                    <td className="tabular-nums">{g.estimatedPieces}</td>
                    <td className="tabular-nums">{m(g.estimatedAvg)}</td>
                    <td className="tabular-nums">{g.unavailablePieces}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </section>
  );
}
