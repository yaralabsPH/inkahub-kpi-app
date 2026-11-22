import { useState } from "react";
import type { ScannerJob } from "@/lib/scanners/outbox";
import { msUntilExpiry } from "@/lib/scanners/session";
import type { WallResult, WallState } from "@/lib/scanners/station";
import { cn } from "@/lib/utils/cn";
import type { DeviceStatus } from "./useSharedScannerStation";

/**
 * F6: the wall screen. Pure: everything comes in as props so it renders in
 * tests without a browser. Large, glanceable, no pop-ups.
 */

export interface SharedScannerWallProps {
  siteLabel: string;
  receiverLabel: string;
  scannerIds: string[];
  state: WallState;
  device: DeviceStatus;
  roleAllowed: boolean;
  signedIn: boolean;
  now: number;
  onStart(): void;
  onRetry(requestId: string): void;
  onDismiss(requestId: string): void;
  onSignOutAll(): void;
  onExit(): void;
}

const RESULT_STYLE: Record<WallResult["kind"], string> = {
  saved: "bg-emerald-600 text-white",
  queued: "bg-amber-400 text-amber-950",
  already: "bg-orange-500 text-white",
  rejected: "bg-red-600 text-white",
  signed_in: "bg-sky-600 text-white",
  info: "bg-slate-700 text-white",
};

const RESULT_WORD: Record<WallResult["kind"], string> = {
  saved: "SAVED",
  queued: "QUEUED",
  already: "ALREADY RECORDED",
  rejected: "NOT SAVED",
  signed_in: "SIGNED IN",
  info: "NOTE",
};

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SharedScannerWall(p: SharedScannerWallProps) {
  const { state, device } = p;
  const warnings: string[] = [];
  if (!p.signedIn) warnings.push("Signed out of Inka Hub. Sign in again; queued scans are kept on this device.");
  else if (!p.roleAllowed) warnings.push("This account cannot run shared scanners (owner, manager or kiosk only). Scans will be refused.");
  if (state.authProblem) warnings.push("The server says the session has expired. Sign in again; queued scans are kept.");
  if (!device.online) warnings.push("Offline. Orders for a signed-in person are queued; badges cannot sign in until the network is back.");
  if (state.storageError) warnings.push(`Device storage problem: ${state.storageError}. New scans may not be saved — use the classic station.`);
  if (!device.focused || !device.visible) warnings.push("This page is not focused: scanners cannot type into it. Tap the screen.");
  if (device.capturePaused) warnings.push("Scanner capture is paused while a text box is selected.");
  if (state.deliveryWaiting) warnings.push(`Waiting to save: ${state.deliveryWaiting}`);
  if (state.view && state.view.corrupt.length > 0) {
    warnings.push(`${state.view.corrupt.length} stored scan(s) cannot be read. Do not clear browser data; ask a manager.`);
  }

  const blocked = state.view?.jobs.filter((j) => j.status === "blocked") ?? [];
  const waiting = state.view?.waiting ?? 0;
  const uncertain = state.view?.uncertain ?? 0;
  const last = state.last;
  // Operator actions confirm inline (tap twice), never with a browser dialog:
  // a scanner's Enter would answer a dialog.
  const [armed, setArmed] = useState<string | null>(null);
  const arm = (what: string, act: () => void) => {
    if (armed === what) {
      setArmed(null);
      act();
    } else {
      setArmed(what);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-white select-none" data-testid="shared-scanner-wall">
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800">
        <div>
          <div className="text-xs uppercase tracking-widest text-slate-400">Shared scanners · {p.siteLabel}</div>
          <div className="text-lg font-semibold">{p.receiverLabel || "Receiver"}</div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("px-2 py-1 rounded", device.online ? "bg-emerald-900 text-emerald-200" : "bg-red-900 text-red-100")}>
            {device.online ? "Online" : "Offline"}
          </span>
          <span className="px-2 py-1 rounded bg-slate-800">Queue {waiting}{uncertain ? ` (${uncertain} awaiting answer)` : ""}</span>
          <span className="px-2 py-1 rounded bg-slate-800">
            Screen {device.wakeLock === "on" ? "kept awake" : device.wakeLock === "unsupported" ? "lock unsupported" : device.wakeLock === "failed" ? "lock failed" : "may sleep"}
          </span>
          <span className="px-2 py-1 rounded bg-slate-800">Sound {device.audio === "on" ? "on" : device.audio === "unsupported" ? "unsupported" : "off"}</span>
          <button type="button" onClick={p.onSignOutAll} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700">Sign out all</button>
          <button type="button" onClick={() => arm("exit", p.onExit)} className={cn("px-2 py-1 rounded", armed === "exit" ? "bg-amber-500 text-amber-950" : "bg-slate-800 hover:bg-slate-700")}>
            {armed === "exit"
              ? (waiting + blocked.length > 0 ? `Tap again: ${waiting + blocked.length} scan(s) stay stored here` : "Tap again for classic")
              : "Classic station"}
          </button>
        </div>
      </header>

      {!device.started ? (
        <button
          type="button"
          onClick={p.onStart}
          className="mx-6 mt-4 rounded-xl bg-sky-600 hover:bg-sky-500 py-6 text-2xl font-semibold"
          data-testid="start-station"
        >
          Start station (enables sound and keeps the screen on)
        </button>
      ) : null}

      {warnings.length > 0 ? (
        <div className="mx-6 mt-4 space-y-2" role="alert">
          {warnings.map((w) => (
            <div key={w} className="rounded-lg bg-red-900/80 ring-1 ring-red-500 px-4 py-2 text-base font-medium">{w}</div>
          ))}
        </div>
      ) : null}

      <section className="grid grid-cols-3 gap-4 px-6 mt-4">
        {p.scannerIds.map((id) => {
          const slot = state.slots[id];
          const left = msUntilExpiry(slot?.identity ?? null, p.now);
          return (
            <div key={id} className="rounded-xl bg-slate-900 ring-1 ring-slate-700 p-4" data-testid={`scanner-${id}`}>
              <div className="text-sm font-mono text-slate-400">{id}</div>
              {slot?.pending ? (
                <div className="text-2xl font-semibold text-sky-300 mt-1">Signing in…</div>
              ) : slot?.identity ? (
                <>
                  <div className="text-3xl font-bold mt-1">{slot.identity.displayName}</div>
                  <div className="text-sm text-slate-400 mt-1">Signs out in {mmss(left ?? 0)} without a scan</div>
                </>
              ) : (
                <div className="text-2xl text-slate-500 mt-1">Scan badge</div>
              )}
            </div>
          );
        })}
      </section>

      <section className="flex-1 px-6 py-4">
        {last ? (
          <div className={cn("rounded-2xl px-8 py-8 h-full flex flex-col justify-center", RESULT_STYLE[last.kind])} data-testid="last-result" data-kind={last.kind}>
            <div className="text-xl font-bold tracking-widest">{RESULT_WORD[last.kind]}{last.scannerId ? ` · ${last.scannerId}` : ""}</div>
            <div className="text-5xl font-extrabold mt-2">{last.title}</div>
            {last.person || last.order || last.pieces !== undefined ? (
              <div className="text-3xl mt-4 font-semibold">
                {[last.person, last.order ? `#${last.order}` : null, last.pieces !== undefined ? `${last.pieces} piece${last.pieces === 1 ? "" : "s"}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : null}
            {last.detail ? <div className="text-xl mt-3 opacity-90">{last.detail}</div> : null}
          </div>
        ) : (
          <div className="rounded-2xl bg-slate-900 ring-1 ring-slate-800 h-full flex items-center justify-center text-3xl text-slate-500">
            Scan badge, then order
          </div>
        )}
      </section>

      {blocked.length > 0 ? (
        <section className="px-6 pb-4" data-testid="blocked-jobs">
          <div className="text-sm uppercase tracking-widest text-red-300 mb-2">Needs you ({blocked.length})</div>
          <div className="space-y-2">
            {blocked.map((j: ScannerJob) => (
              <div key={j.requestId} className="rounded-lg bg-slate-900 ring-1 ring-red-700 px-4 py-2 flex items-center justify-between gap-4">
                <div>
                  <div className="font-semibold">#{j.orderNumber} · {j.displayName} · {j.scannerId}</div>
                  <div className="text-sm text-slate-300">{j.blocked?.message}</div>
                  {j.uncertain ? (
                    <div className="text-sm font-semibold text-amber-300">
                      An earlier send may already have saved this. Do NOT record it on the classic station; tap Retry once fixed.
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => p.onRetry(j.requestId)} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600">Retry</button>
                  {j.uncertain ? null : (
                    <button type="button" onClick={() => arm(j.requestId, () => p.onDismiss(j.requestId))} className="px-3 py-1 rounded bg-red-800 hover:bg-red-700">
                      {armed === j.requestId ? "Tap again: I recorded it on classic" : "Recorded on classic"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="px-6 py-2 text-xs text-slate-500 border-t border-slate-800">
        Scanners send &lt;S1&gt;…&lt;/S1&gt; + Enter. Green appears only after the server saved the work. Amber = stored on this device, not yet saved.
      </footer>
    </div>
  );
}
