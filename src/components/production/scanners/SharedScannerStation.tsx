import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/repository/supabase/client";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAppStore } from "@/lib/state/appStore";
import { LOCATION_LABELS, type LocationKey } from "@/lib/domain";
import { DEFAULT_SCANNER_IDS, validateScannerIds } from "@/lib/scanners/protocol";
import { newReceiverId, type SharedScannerConfig } from "@/lib/scanners/config";
import { firstWaitingChoice } from "@/lib/scanners/outbox";
import type { ScanMode } from "@/lib/scanners/dispatch";
import type { PeopleState } from "./FramerPicker";
import { SharedScannerWall } from "./SharedScannerWall";
import { useSharedScannerStation } from "./useSharedScannerStation";
import { IDENTITY_IDLE_WORDS } from "@/lib/scanners/session";

const OPERATOR_ROLES = new Set(["owner", "manager", "kiosk"]);

/**
 * F6: the opt-in Shared scanners mode of /production. Supabase only (the
 * caller already checked). Identities reset whenever the account, site,
 * receiver or scanner list changes, because the inner station is keyed on
 * all four.
 */
export function SharedScannerStation({ config, onExit, onChangeConfig }: {
  config: SharedScannerConfig;
  onExit(): void;
  /** F7: persist a changed config (mode switch). */
  onChangeConfig?(cfg: SharedScannerConfig): void;
}) {
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
  const mode: ScanMode = config.mode ?? "framing";
  // Mode is part of the key: switching it starts from empty identities
  // (queued jobs stay, each with the mode it was scanned in).
  const key = [callerId, location, config.receiverId, config.scannerIds.join(","), mode].join("|");
  return (
    <Inner
      key={key}
      config={config}
      mode={mode}
      callerId={callerId}
      location={location}
      roleAllowed={OPERATOR_ROLES.has(auth?.profile?.role ?? "")}
      onExit={onExit}
      onSwitchMode={onChangeConfig ? () => onChangeConfig({ ...config, mode: mode === "dispatch" ? "framing" : "dispatch" }) : undefined}
    />
  );
}

function Inner({ config, mode, callerId, location, roleAllowed, onExit, onSwitchMode }: {
  config: SharedScannerConfig; mode: ScanMode; callerId: string; location: string; roleAllowed: boolean; onExit(): void; onSwitchMode?(): void;
}) {
  const client = getSupabase();
  const { data: dataset } = useDataset();
  const products = useMemo(() => (dataset ? dataset.products.map((p) => ({ id: p.id, code: p.code })) : null), [dataset]);
  const st = useSharedScannerStation({
    client, location, callerId, receiverId: config.receiverId, label: config.label, scannerIds: config.scannerIds, products, mode,
  });
  // People for the framer chooser: loaded when a choice is waiting, once per waiting job.
  const waitingId = firstWaitingChoice(st.state.view?.jobs ?? [])?.requestId ?? null;
  const [people, setPeople] = useState<PeopleState>({ status: "loading" });
  const { loadPeople } = st;
  useEffect(() => {
    if (!waitingId) return;
    let cancelled = false;
    setPeople({ status: "loading" });
    void loadPeople().then((r) => {
      if (cancelled) return;
      setPeople(r.outcome === "ok" ? { status: "ok", people: r.people } : { status: "error", message: r.message });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingId]);
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
      mode={mode}
      onSwitchMode={onSwitchMode}
      onChooseFramers={st.chooseFramers}
      people={people}
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
  const [mode, setMode] = useState<ScanMode>(current?.mode ?? "framing");
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
        <fieldset className="text-sm">
          <legend className="text-slate-600 dark:text-slate-300">What do the scanners record?</legend>
          <label className="mr-4"><input type="radio" name="mode" checked={mode === "framing"} onChange={() => setMode("framing")} /> Framing (badge, then orders; {IDENTITY_IDLE_WORDS})</label>
          <label><input type="radio" name="mode" checked={mode === "dispatch"} onChange={() => setMode("dispatch")} /> Dispatch (badge once per shift, then order slips)</label>
        </fieldset>
        {mode === "framing" ? (
          <p className="text-sm text-slate-600 dark:text-slate-300" data-testid="signout-guidance">
            To sign out one scanner, scan your own badge 3 more times on it, about a second apart. You stay clocked in.
          </p>
        ) : null}
        {problem ? <div className="text-sm text-red-600">{problem}</div> : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-3 h-9 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-sm">Cancel</button>
          <button type="button" disabled={!!problem}
            onClick={() => onSave({ enabled: true, receiverId: current?.receiverId ?? newReceiverId(), label: label.trim(), scannerIds: parsed, mode })}

            className="px-4 h-9 rounded-md bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-sm font-medium disabled:opacity-40">
            Turn on shared scanners
          </button>
        </div>
      </div>
    </div>
  );
}
