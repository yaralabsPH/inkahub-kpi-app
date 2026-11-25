import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { canManagePackagingRules } from "@/lib/domain/packaging/editing";
import { completionsWithoutPick, type CompletionEvent, type MissingPick, type PickKey } from "@/lib/domain/packaging/usage";
import { usePackagingCatalogue } from "@/lib/hooks/usePackagingCatalogue";
import { getBackendMode, getSupabase } from "@/lib/repository/supabase/client";
import {
  loadPackagingConfig,
  newRequestId,
  parsePick,
  retryPackaging,
  type PackagingPick,
} from "@/lib/repository/supabase/orderPackaging";
import { useAppStore } from "@/lib/state/appStore";

/**
 * F4 box-auto-pick: the short list managers check. Three kinds of row:
 *   - flagged:  no box rule matched, nothing was deducted;
 *   - stock:    packaging was used but stock was short (negative or not yet deducted);
 *   - missing:  an order was completed at a packing station in auto mode and
 *               no packaging record ever arrived.
 * Bounded by the Reports date range and by row caps; never scans all events.
 */

const STATION: Record<string, string> = { a0_framed: "A0 Framed", dispatch: "Dispatch", unframed: "Unframed" };
const PICK_CAP = 200;
const EVENT_CAP = 1000;
/** A save can take a moment (or sit in a device queue briefly); don't cry wolf. */
const MISSING_GRACE_MS = 2 * 60 * 1000;

export interface AttentionViewProps {
  picks: PackagingPick[];
  missing: MissingPick[];
  labels: ReadonlyMap<string, string>;
  truncated: boolean;
  busyPickId: string | null;
  message: string | null;
  onRetry: (pick: PackagingPick) => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function packagesText(q: Record<string, number>, labels: ReadonlyMap<string, string>): string {
  const parts = Object.entries(q).filter(([, n]) => n > 0).map(([id, n]) => `×${n} ${labels.get(id) ?? id}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function PackagingAttentionView(props: AttentionViewProps) {
  const { picks, missing, labels } = props;
  if (picks.length === 0 && missing.length === 0) {
    return <p className="text-sm text-slate-500">Nothing needs attention in this range.</p>;
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
        {picks.map((p) => {
          const stock = p.stock_state !== "posted";
          return (
            <li key={p.id} className="py-2 flex flex-wrap items-center justify-between gap-2" data-attention={stock ? p.stock_state : "flagged"}>
              <div>
                <div className="font-medium">
                  #{p.order_number} · {STATION[p.packing_point] ?? p.packing_point}
                  {p.shipment_key !== "orig" ? " · replacement" : ""}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {p.state === "unresolved" ? "No box rule matched. Nothing was deducted. " : ""}
                  {p.stock_state === "short" ? `Stock went below zero for: ${packagesText(p.target, labels)}. ` : ""}
                  {p.stock_state === "unposted" ? `Not deducted yet, stock too low: ${packagesText(p.target, labels)}. ` : ""}
                  {when(p.created_at)}
                </div>
              </div>
              {stock ? (
                <Button type="button" variant="secondary" size="sm" disabled={props.busyPickId !== null}
                  aria-label={`Retry stock for order ${p.order_number}`} onClick={() => props.onRetry(p)}>
                  {props.busyPickId === p.id ? "Retrying…" : "Retry"}
                </Button>
              ) : null}
            </li>
          );
        })}
        {missing.map((m) => (
          <li key={`${m.order_number}|${m.packing_point}|${m.shipment_key}`} className="py-2" data-attention="missing">
            <div className="font-medium">
              #{m.order_number} · {STATION[m.packing_point] ?? m.packing_point}
              {m.shipment_key !== "orig" ? " · replacement" : ""}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Completed with no packaging record. Nothing was deducted. Rescan the order at that station to record it. {when(m.completed_at)}
            </div>
          </li>
        ))}
      </ul>
      {props.truncated ? (
        <p className="text-xs text-slate-500">Showing the most recent rows only. Narrow the date range to see the rest.</p>
      ) : null}
      {props.message ? <p className="text-sm text-red-600 dark:text-red-400" role="alert">{props.message}</p> : null}
    </div>
  );
}

export function PackagingAttentionCard(props: { fromIso: string; toIso: string }) {
  // Optional: local (Dexie) mode has no AuthProvider, and the card renders
  // nothing there anyway (the backend check below).
  const profile = useAuthOptional()?.profile ?? null;
  if (getBackendMode() !== "supabase") return null;
  if (!canManagePackagingRules(profile?.role)) return null;
  return <PackagingAttentionCardInner {...props} />;
}

function PackagingAttentionCardInner({ fromIso, toIso }: { fromIso: string; toIso: string }) {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const labels = usePackagingCatalogue();
  const [picks, setPicks] = useState<PackagingPick[]>([]);
  const [missing, setMissing] = useState<MissingPick[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [inUse, setInUse] = useState(false);
  const [busyPickId, setBusyPickId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const config = await loadPackagingConfig(supabase, location);
    const autoSince = config.mode === "auto" || config.warning ? config.modeChangedAt : null;

    const flagged = await supabase
      .from("packaging_picks")
      .select("*")
      .eq("location", location)
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .or("state.eq.unresolved,stock_state.neq.posted")
      .order("created_at", { ascending: false })
      .limit(PICK_CAP);
    // Tables not there yet (migration not applied): show nothing at all.
    if (flagged.error) {
      setInUse(false);
      return;
    }
    const flaggedPicks = ((flagged.data ?? []) as unknown[]).map(parsePick).filter((p): p is PackagingPick => p !== null);
    let cut = flaggedPicks.length >= PICK_CAP;

    let missingRows: MissingPick[] = [];
    if (autoSince) {
      const start = Date.parse(autoSince) > Date.parse(fromIso) ? autoSince : fromIso;
      const graceEnd = new Date(Date.now() - MISSING_GRACE_MS).toISOString();
      const end = Date.parse(graceEnd) < Date.parse(toIso) ? graceEnd : toIso;
      if (Date.parse(start) < Date.parse(end)) {
        const ev = await supabase
          .from("production_events")
          .select("id, order_number, department, event_type, created_at, cs_case_id")
          .eq("location", location)
          .in("department", ["a0_framed", "dispatch", "unframed"])
          .in("event_type", ["completed", "dispatched"])
          .gte("created_at", start)
          .lte("created_at", end)
          .order("created_at", { ascending: false })
          .limit(EVENT_CAP);
        const events = (ev.data ?? []) as CompletionEvent[];
        if (events.length >= EVENT_CAP) cut = true;
        const orders = [...new Set(events.map((e) => e.order_number))];
        const keys: PickKey[] = [];
        for (let i = 0; i < orders.length; i += 150) {
          const res = await supabase
            .from("packaging_picks")
            .select("order_number, packing_point, shipment_key")
            .eq("location", location)
            .in("order_number", orders.slice(i, i + 150));
          keys.push(...((res.data ?? []) as PickKey[]));
        }
        missingRows = completionsWithoutPick(events, keys, autoSince);
      }
    }

    setPicks(flaggedPicks);
    setMissing(missingRows);
    setTruncated(cut);
    setInUse(autoSince !== null || flaggedPicks.length > 0 || labels.size > 0);
  }, [supabase, location, fromIso, toIso, labels]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRetry = (pick: PackagingPick) => {
    setBusyPickId(pick.id);
    setMessage(null);
    void retryPackaging(supabase, { location, requestId: newRequestId("retry"), pickId: pick.id })
      .then((res) => {
        if (res.outcome !== "retried") setMessage(res.message);
        else if (res.pick.stock_state === "unposted") setMessage(`Still not enough stock for order #${pick.order_number}. Correct the stock level, then retry.`);
      })
      .finally(() => {
        setBusyPickId(null);
        void load();
      });
  };

  // Sites that have never used packaging rules see no extra card.
  if (!inUse) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <AlertTriangle size={16} /> Packaging needing attention
        </CardTitle>
      </CardHeader>
      <CardBody>
        <PackagingAttentionView picks={picks} missing={missing} labels={labels} truncated={truncated}
          busyPickId={busyPickId} message={message} onRetry={onRetry} />
      </CardBody>
    </Card>
  );
}
