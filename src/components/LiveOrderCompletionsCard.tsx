import { useEffect, useRef, useState } from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { olderThanFilter, type KeysetCursor } from "@/lib/repository/supabase/keysetFilter";
import {
  PRODUCTION_DEPARTMENT_LABELS,
  type ProductionDepartment,
} from "@/lib/domain";

/**
 * Live order-completion log for /reports. Loads on first render, then
 * snapshots until the operator hits Refresh. Useful for spot-checking
 * "did Sarah dispatch order #12345 yet?" without scrolling the kiosk's
 * event history.
 *
 * Each row = one completed (framing) or dispatched (dispatch) event. So
 * a single physical order that goes through framed then dispatch shows
 * twice (once per dept) - which is correct: two workers did real work.
 *
 * Bounded, never silently truncated (Task 17): one snapshot fixes the upper
 * cutoff; pages of PAGE rows (newest first, created_at then id) are read
 * under it, and "Load older" continues the same snapshot by KEYSET (strictly
 * older than the last shown row), never by offset, so rows inserted or
 * deleted earlier in the window cannot duplicate or skip a row. A full page
 * may have more behind it, so the log is only called complete after a short page.
 */
const PAGE = 500;
interface Snapshot { sinceIso: string; cutoffIso: string; fetchedAt: Date }
export function LiveOrderCompletionsCard() {
  if (getBackendMode() !== "supabase") return null;
  return <LiveOrderCompletionsCardInner />;
}

interface Row {
  id: string;
  created_at: string;
  display_name: string;
  order_number: string;
  department: ProductionDepartment;
  event_type: "completed" | "dispatched";
}

function LiveOrderCompletionsCardInner() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** True while the shown rows may not be the whole snapshot (a full last page). */
  const [hasMore, setHasMore] = useState(false);
  /** The last shown row: the next older page starts strictly after it. */
  const [cursor, setCursor] = useState<KeysetCursor | null>(null);
  const seq = useRef(0);
  const fetchedAt = snapshot?.fetchedAt ?? null;

  /**
   * One bounded page of the snapshot, newest first, strictly older than `cursor` (null = the newest page);
   * `more` = the page was full (older rows may exist); `cursor` = its last row.
   */
  const readPage = async (snap: Snapshot, cursor: KeysetCursor | null): Promise<{ rows: Row[]; more: boolean; cursor: KeysetCursor | null }> => {
    let q = supabase
      .from("production_events")
      .select("id, created_at, staff_id, order_number, department, event_type")
      .eq("location", location)
      .in("event_type", ["completed", "dispatched"])
      .gte("created_at", snap.sinceIso)
      .lte("created_at", snap.cutoffIso);
    if (cursor) q = q.or(olderThanFilter(cursor));
    const [evRes, barcodesRes] = await Promise.all([
      q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(0, PAGE - 1),
      supabase
        .from("staff_barcodes")
        .select("user_id, display_name")
        .eq("location", location),
    ]);
    if (evRes.error) throw new Error(evRes.error.message);
    if (barcodesRes.error) throw new Error(barcodesRes.error.message);
    const nameByUser = new Map<string, string>();
    for (const r of (barcodesRes.data ?? [])) {
      if (!nameByUser.has(r.user_id)) nameByUser.set(r.user_id, r.display_name);
    }
    const page = evRes.data ?? [];
    const last = page.length ? page[page.length - 1] : null;
    return {
      cursor: last ? { createdAt: last.created_at, id: last.id } : null,
      rows: page.map((e) => ({
        id: e.id as string,
        created_at: e.created_at as string,
        display_name: nameByUser.get(e.staff_id as string) ?? `User ${String(e.staff_id).slice(0, 8)}`,
        order_number: e.order_number as string,
        department: e.department as ProductionDepartment,
        event_type: e.event_type as "completed" | "dispatched",
      })),
      more: page.length === PAGE,
    };
  };

  /** A new snapshot (Refresh / first load): the newest page of the last 7 days up to now. */
  const fetchOnce = async () => {
    const mine = ++seq.current;
    setLoading(true);
    setErr(null);
    const now = Date.now();
    // Look back 7 days. Tweak if you want a longer window.
    const snap: Snapshot = { sinceIso: new Date(now - 7 * 24 * 3600 * 1000).toISOString(), cutoffIso: new Date(now).toISOString(), fetchedAt: new Date(now) };
    try {
      const page = await readPage(snap, null);
      if (mine !== seq.current) return;
      setRows(page.rows);
      setHasMore(page.more);
      setCursor(page.cursor);
      setSnapshot(snap);
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  /** The next older page of the SAME snapshot (appended; a failure keeps the shown rows and the "more" state). */
  const loadOlder = async () => {
    if (!snapshot || !hasMore || !cursor) return;
    const mine = ++seq.current;
    const snap = snapshot;
    const after = cursor;
    setLoading(true);
    setErr(null);
    try {
      const page = await readPage(snap, after);
      if (mine !== seq.current) return;
      setRows((prev) => [...prev, ...page.rows]);
      setHasMore(page.more);
      if (page.cursor) setCursor(page.cursor);
    } catch (e) {
      if (mine !== seq.current) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  };

  // Initial load. Does NOT poll.
  useEffect(() => {
    setRows([]);
    setHasMore(false);
    setCursor(null);
    setSnapshot(null);
    void fetchOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const fmtFetchedAt = (d: Date | null) => {
    if (!d) return "";
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="inline-flex items-center gap-2">
            <ClipboardList size={16} /> Live order completions
          </CardTitle>
          <Button
            onClick={() => { void fetchOnce(); }}
            disabled={loading}
            className="inline-flex items-center gap-1 text-xs h-7"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
        <span className="text-xs text-slate-500">
          Last 7 days. Snapshot - data is frozen until you hit Refresh.
          {fetchedAt ? ` Fetched at ${fmtFetchedAt(fetchedAt)}.` : ""}
        </span>
      </CardHeader>
      <CardBody className="p-0">
        {err && rows.length === 0 ? (
          <div className="px-4 py-3 text-xs text-red-600 dark:text-red-400">Couldnt load: {err}</div>
        ) : loading && rows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500">No completions in the last 7 days.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-2 w-px">Time</th>
                  <th className="text-left font-medium px-3 py-2">Worker</th>
                  <th className="text-left font-medium px-3 py-2">Order #</th>
                  <th className="text-left font-medium px-3 py-2">Dept</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-1.5 tabular-nums text-slate-600 dark:text-slate-300 whitespace-nowrap">
                      {fmtTime(r.created_at)}
                    </td>
                    <td className="px-3 py-1.5 font-medium text-slate-900 dark:text-slate-100">
                      {r.display_name}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-slate-700 dark:text-slate-300">
                      #{r.order_number}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={
                        r.event_type === "dispatched"
                          ? "text-[11px] uppercase tracking-wide px-2 py-0.5 rounded ring-1 ring-blue-300 bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
                          : "text-[11px] uppercase tracking-wide px-2 py-0.5 rounded ring-1 ring-slate-300 text-slate-600 dark:text-slate-300"
                      }>
                        {PRODUCTION_DEPARTMENT_LABELS[r.department] ?? r.department}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-4 py-2 text-xs text-slate-500 flex items-center gap-2" role="status">
              {hasMore
                ? `Showing the newest ${rows.length.toLocaleString()} completions; older ones in the last 7 days are not loaded yet.`
                : `All ${rows.length.toLocaleString()} completions in the last 7 days (to the snapshot time).`}
              {hasMore ? (
                <Button onClick={() => { void loadOlder(); }} disabled={loading} className="text-xs h-7">
                  Load older
                </Button>
              ) : null}
              {err ? <span className="text-red-600 dark:text-red-400">Couldnt load older rows: {err}</span> : null}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}