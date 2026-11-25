import { useEffect, useRef, useState } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tag } from "@/components/ui/Tag";
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
    <Section
      title="Live order completions"
      subtitle="Last 7 days. Snapshot: data is frozen until you hit Refresh."
      storageKey="inka-reports-collapse:live-completions"
      actions={
        <>
          {fetchedAt ? (
            <span className="flex items-center gap-1.5 text-xs text-hub-faint">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-hub-faint" />
              Snapshot · fetched {fmtFetchedAt(fetchedAt)}
            </span>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => { void fetchOnce(); }} disabled={loading}>
            <RefreshCw size={14} strokeWidth={1.6} className={loading ? "animate-spin" : ""} aria-hidden /> Refresh
          </Button>
        </>
      }
    >
      {err && rows.length === 0 ? (
        <div className="text-[13px] text-hub-bad">Couldn't load: {err}</div>
      ) : loading && rows.length === 0 ? (
        <div className="text-[13px] text-hub-faint">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Inbox} title="No completions in the last 7 days" hint="Hit Refresh to pull the latest." />
      ) : (
        <>
          <div className="max-h-[420px] overflow-y-auto">
            {rows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-[minmax(64px,auto)_minmax(90px,auto)_1fr_auto] items-center gap-3 border-b border-hub-line px-1.5 py-2 text-[13.5px]"
              >
                <span className="whitespace-nowrap text-[12.5px] tabular-nums text-hub-faint">{fmtTime(r.created_at)}</span>
                <code className="whitespace-nowrap font-mono text-[12.5px] text-hub-muted">#{r.order_number}</code>
                <span>
                  <Tag color={r.event_type === "dispatched" ? "blue" : "gray"}>
                    {PRODUCTION_DEPARTMENT_LABELS[r.department] ?? r.department}
                  </Tag>
                </span>
                <span className="text-[13px] text-hub-muted">{r.display_name}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2.5 text-xs text-hub-faint" role="status">
            {hasMore
              ? `Showing the newest ${rows.length.toLocaleString()} completions; older ones in the last 7 days are not loaded yet.`
              : `All ${rows.length.toLocaleString()} completions in the last 7 days (to the snapshot time).`}
            {hasMore ? (
              <Button variant="secondary" size="sm" onClick={() => { void loadOlder(); }} disabled={loading}>
                Load older
              </Button>
            ) : null}
            {err ? <span className="text-hub-bad">Couldn't load older rows: {err}</span> : null}
          </div>
        </>
      )}
    </Section>
  );
}
