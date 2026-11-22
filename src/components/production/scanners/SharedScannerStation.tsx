import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAppStore } from "@/lib/state/appStore";
import { LOCATION_LABELS, type LocationKey } from "@/lib/domain";
import { DEFAULT_SCANNER_IDS, validateScannerIds } from "@/lib/scanners/protocol";
import { newReceiverId, type SharedScannerConfig } from "@/lib/scanners/config";
import { SharedScannerWall } from "./SharedScannerWall";
import { useSharedScannerStation } from "./useSharedScannerStation";

const OPERATOR_ROLES = new Set(["owner", "manager", "kiosk"]);

/**
 * F6: the opt-in Shared scanners mode of /production. Supabase only (the
 * caller already checked). Identities reset whenever the account, site,
 * receiver or scanner list changes, because the inner station is keyed on
 * all four.
 */
export function SharedScannerStation({ config, onExit }: { config: SharedScannerConfig; onExit(): void }) {
  const auth = useAuthOptional();
  const location = useAppStore((s) => s.location);
  const callerId = auth?.user?.id ?? null;
  if (!callerId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white text-2xl p-8 text-center">
        Signed out. Sign in to Inka Hub to use the shared scanners. Scans queued on this device are kept.
      </div>
    );
  }
  const key = [callerId, location, config.receiverId, config.scannerIds.join(",")].join("|");
  return (
    <Inner
      key={key}
      config={config}
      callerId={callerId}
      location={location}
      roleAllowed={OPERATOR_ROLES.has(auth?.profile?.role ?? "")}
      onExit={onExit}
    />
  );
}

function Inner({ config, callerId, location, roleAllowed, onExit }: {
  config: SharedScannerConfig; callerId: string; location: string; roleAllowed: boolean; onExit(): void;
}) {
  const client = getSupabase();
  const { data: dataset } = useDataset();
  const products = useMemo(() => (dataset ? dataset.products.map((p) => ({ id: p.id, code: p.code })) : null), [dataset]);
  const st = useSharedScannerStation({
    client, location, callerId, receiverId: config.receiverId, label: config.label, scannerIds: config.scannerIds, products,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <SharedScannerWall
      siteLabel={LOCATION_LABELS[location as LocationKey] ?? location}
      receiverLabel={config.label}
      scannerIds={config.scannerIds}
      state={st.state}
      device={st.device}
      roleAllowed={roleAllowed}
      signedIn
      now={now}
      onStart={st.start}
      onRetry={st.retry}
      onDismiss={st.dismiss}
      onSignOutAll={st.signOutAll}
      onExit={onExit}
    />
  );
}

/** One-time setup. Scanner capture is off on this screen. */
export function SharedScannerSetup({ current, onSave, onCancel }: {
  current: SharedScannerConfig | null;
  onSave(cfg: SharedScannerConfig): void;
  onCancel(): void;
}) {
  const [label, setLabel] = useState(current?.label ?? "");
  const [ids, setIds] = useState((current?.scannerIds ?? [...DEFAULT_SCANNER_IDS]).join(", "));
  const parsed = ids.split(",").map((s) => s.trim()).filter(Boolean);
  const problem = validateScannerIds(parsed);
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
      <div className="w-full max-w-lg rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-8 space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Shared scanners</h1>
        <p className="text-sm text-slate-500">
          This device receives up to three cordless scanners. Each person scans their badge on a scanner, then scans orders;
          every framed line is saved for them without taps. Supabase only; owner, manager or kiosk account. Scanner capture is
          paused on this setup screen.
        </p>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Receiver name (shown to managers)</span>
          <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)}
            className="mt-1 w-full rounded-md ring-1 ring-slate-300 dark:ring-slate-700 px-3 h-9 bg-transparent" placeholder="Framing wall" />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-300">Scanner ids (prefix &lt;ID&gt; and suffix &lt;/ID&gt; on each scanner)</span>
          <input value={ids} onChange={(e) => setIds(e.target.value)}
            className="mt-1 w-full rounded-md ring-1 ring-slate-300 dark:ring-slate-700 px-3 h-9 bg-transparent font-mono" />
        </label>
        {problem ? <div className="text-sm text-red-600">{problem}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 h-9 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-sm">Cancel</button>
          <button type="button" disabled={!!problem}
            onClick={() => onSave({ enabled: true, receiverId: current?.receiverId ?? newReceiverId(), label: label.trim(), scannerIds: parsed })}
            className="px-4 h-9 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-sm font-medium disabled:opacity-40">
            Turn on shared scanners
          </button>
        </div>
      </div>
    </div>
  );
}
