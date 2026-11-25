import { useState } from "react";
import { firstWaitingChoice, jobMode, type ScannerJob } from "@/lib/scanners/outbox";
import type { FramerChoice, ScanMode } from "@/lib/scanners/dispatch";
import type { WallTotalsView } from "@/lib/scanners/wallTotals";
import { FramerPicker, type PeopleState } from "./FramerPicker";
import type { SlotProgress, WallResult, WallState } from "@/lib/scanners/station";
import type { DeviceStatus } from "./useSharedScannerStation";
import { ScannerWallPanel, type PanelGoodbye, type PanelTotals } from "./ScannerWallPanel";
import "./scanner-wall.css";

/**
 * F6 wall screen, redesigned (scanner-wall-redesign, approved 2026-11-25).
 * Pure: everything comes in as props so it renders in tests without a
 * browser. Large, glanceable, no pop-ups; workers only watch it.
 */

export type { WallTotalsView };

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
  /** F7. Absent = framing (F6). */
  mode?: ScanMode;
  /** F7: switch this receiver between framing and dispatch (tap twice). */
  onSwitchMode?(): void;
  onChooseFramers?(requestId: string, choices: FramerChoice[]): void;
  /** F7: people for the framer chooser (loaded only while a choice is waiting). */
  people?: PeopleState;
  /** Today's per-person totals (Framing). Absent = not shown. */
  totals?: WallTotalsView;
  /** Site time zone for the clock and times. Absent = the device's. */
  timeZone?: string;
  /** Monotonic clock (performance.now()) for the sign-out countdown. Defaults to `now`. */
  elapsedNow?: number;
}

const RESULT_WORD: Record<WallResult["kind"], string> = {
  saved: "SAVED",
  queued: "QUEUED",
  already: "ALREADY RECORDED",
  rejected: "NOT SAVED",
  signed_in: "SIGNED IN",
  signed_out: "SIGNED OUT",
  info: "NOTE",
};

function clock(now: number, timeZone?: string): string {
  return new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
}

/** Oldest unfinished scan on one scanner for its current person and mode. */
function slotProgress(state: WallState, scannerId: string, personId: string | null, mode: ScanMode): SlotProgress | null {
  if (!personId) return null;
  const mine = Object.values(state.progress ?? {})
    .filter((p) => p.scannerId === scannerId && p.personId === personId && p.mode === mode)
    .sort((a, b) => a.startedAt - b.startedAt);
  return mine.length ? { ...mine[0], waiting: mine.length } : null;
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

  const mode: ScanMode = p.mode ?? "framing";
  const framing = mode === "framing";
  const elapsedNow = p.elapsedNow ?? p.now;
  const blocked = state.view?.jobs.filter((j) => j.status === "blocked") ?? [];
  const choice = firstWaitingChoice(state.view?.jobs ?? []);
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

  // ---- today's numbers (Framing only) --------------------------------------
  const view = framing ? p.totals : undefined;
  const pending = new Set(view?.pendingPersonIds ?? []);
  const activeIds = p.scannerIds.map((id) => state.slots[id]?.identity?.personId).filter((x): x is string => !!x);
  const anyPending = activeIds.some((id) => pending.has(id));
  const usable = view && view.totals && (view.status === "current" || view.status === "stale") ? view.totals : null;
  const showCompetition = usable && !anyPending && !usable.incomplete;
  const panelTotals = (personId: string | null): PanelTotals => {
    if (!personId || !view) return null;
    if (pending.has(personId) || view.status === "loading") return "pending";
    const t = usable?.byPerson[personId];
    if (!t) return null;
    return showCompetition ? t : { ...t, rank: null, share: null, leading: false, jointLead: false };
  };

  return (
    <div className="scanner-wall dark" data-testid="shared-scanner-wall">
      <header className="w-head">
        <div>
          <div className="w-brand">
            <b>INKA</b>
            <span className="w-label">
              Shared scanners · {p.siteLabel} · <span data-testid="wall-mode">{mode === "dispatch" ? "Dispatch" : "Framing"}</span>
            </span>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{p.receiverLabel || "Receiver"}</div>
        </div>
        <div className="w-clock" aria-label="Site time">{clock(p.now, p.timeZone)}</div>
        <div className="w-chips">
          <span className={`w-chip ${device.online ? "is-ok" : "is-bad"}`}><span className="w-dot" />{device.online ? "Online" : "Offline"}</span>
          <span className="w-chip">Queue {waiting}{uncertain ? ` (${uncertain} awaiting answer)` : ""}</span>
          <span className="w-chip">
            Screen {device.wakeLock === "on" ? "kept awake" : device.wakeLock === "unsupported" ? "lock unsupported" : device.wakeLock === "failed" ? "lock failed" : "may sleep"}
          </span>
          <span className="w-chip">Sound {device.audio === "on" ? "on" : device.audio === "unsupported" ? "unsupported" : "off"}</span>
          <button type="button" onClick={p.onSignOutAll} className="w-chip">
            {mode === "dispatch" ? "Switch worker" : "Sign out all"}
          </button>
          {p.onSwitchMode ? (
            <button type="button" onClick={() => arm("mode", p.onSwitchMode!)} data-testid="switch-mode" className={`w-chip${armed === "mode" ? " is-armed" : ""}`}>
              {armed === "mode"
                ? `Tap again: switch to ${mode === "dispatch" ? "framing" : "dispatch"} (everyone signs out; queued scans keep their own mode)`
                : mode === "dispatch" ? "Framing mode" : "Dispatch mode"}
            </button>
          ) : null}
          <button type="button" onClick={() => arm("exit", p.onExit)} className={`w-chip${armed === "exit" ? " is-armed" : ""}`}>
            {armed === "exit"
              ? (waiting + blocked.length > 0 ? `Tap again: ${waiting + blocked.length} scan(s) stay stored here` : "Tap again for classic")
              : "Classic station"}
          </button>
        </div>
      </header>

      {!device.started ? (
        <button type="button" onClick={p.onStart} className="w-start" data-testid="start-station">
          Start station (enables sound and keeps the screen on)
        </button>
      ) : null}

      {warnings.length > 0 ? (
        <div className="w-warnings" role="alert">
          {warnings.map((w) => <div key={w} className="w-warning">{w}</div>)}
        </div>
      ) : null}

      {framing && view ? (
        <div className="w-team" data-testid="wall-team" data-status={view.status}>
          <span className="w-label">Today on this wall</span>
          <div className="w-team-figs">
            {usable && !anyPending ? (
              <>
                <span>Orders <b>{usable.team.orders}</b></span>
                <span>Pieces <b>{usable.team.pieces ?? "—"}</b></span>
              </>
            ) : (
              <span>{view.status === "unavailable" ? `Today's totals unavailable${view.message ? `: ${view.message}` : ""}` : "Updating today's totals…"}</span>
            )}
            {view.status === "stale" && view.loadedAtUtc ? <span>Last updated {clock(Date.parse(view.loadedAtUtc), p.timeZone)}</span> : null}
            {usable?.incomplete ? <span>Some records need checking; no ranking shown</span> : null}
          </div>
        </div>
      ) : null}

      <section className={`w-panels n${Math.min(Math.max(p.scannerIds.length, 1), 3)}`}>
        {p.scannerIds.map((id) => {
          const slot = state.slots[id];
          const personId = slot?.identity?.personId ?? null;
          const saved = state.slotSaved?.[id];
          const gb = state.goodbye?.[id];
          const known = gb ? view?.lastKnown?.[gb.personId] : undefined;
          const goodbye: PanelGoodbye | null = gb
            ? { displayName: gb.displayName, at: gb.at, orders: known?.orders ?? null, pieces: known?.pieces ?? null }
            : null;
          return (
            <ScannerWallPanel
              key={id}
              id={id}
              slot={slot}
              mode={mode}
              now={p.now}
              elapsedNow={elapsedNow}
              totals={framing ? panelTotals(personId) : null}
              progress={slotProgress(state, id, personId, mode)}
              saved={saved && personId && saved.personId === personId && saved.mode === mode ? saved : null}
              goodbye={goodbye}
              note={state.slotNotes[id] ?? null}
              timeZone={p.timeZone}
            />
          );
        })}
      </section>

      {state.recovery ? (
        <section className="w-recovery" role="alert" data-testid="scan-recovery">
          <div className="w-label" style={{ color: "#1f1500" }}>NOTHING SAVED FROM THAT SCAN</div>
          <h2>{state.recovery.title}</h2>
          <p>{state.recovery.detail}</p>
          {state.recovery.setupHint ? <p style={{ fontWeight: 700 }}>{state.recovery.setupHint}</p> : null}
        </section>
      ) : null}

      <section aria-live="polite">
        {last ? (
          <div className="w-result" data-testid="last-result" data-kind={last.kind}>
            <div className="w-result-word">{RESULT_WORD[last.kind]}{last.scannerId ? ` · ${last.scannerId}` : ""}</div>
            <div className="w-result-title">{last.title}</div>
            {last.person || last.order || last.pieces !== undefined ? (
              <div className="w-result-line">
                {[last.person, last.order ? `#${last.order}` : null, last.pieces !== undefined ? `${last.pieces} piece${last.pieces === 1 ? "" : "s"}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : null}
            {last.framers && last.framers.length > 0 ? (
              <ul data-testid="framed-by" style={{ margin: 0, paddingLeft: 0, listStyle: "none", fontSize: 22 }}>
                {last.framers.map((f) => (
                  <li key={f.sku}>
                    <span style={{ fontWeight: 700 }}>Framed by: {f.displayName}</span>{" "}
                    {f.source === "scan" ? "✓" : <span className="w-manual">Manual</span>}
                    <span style={{ fontSize: 15, opacity: 0.8, marginLeft: 12 }}>{f.sku}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {last.detail ? <div className="w-result-detail">{last.detail}</div> : null}
          </div>
        ) : (
          <div className="w-result is-idle">
            {mode === "dispatch" ? "Scan your badge once for the shift, then order slips" : "Scan badge, then order"}
          </div>
        )}
      </section>

      {choice && p.onChooseFramers ? (
        <FramerPicker
          job={choice}
          people={p.people ?? { status: "loading" }}
          onSave={(choices) => p.onChooseFramers!(choice.requestId, choices)}
          onRecheck={() => p.onRetry(choice.requestId)}
        />
      ) : null}

      {blocked.length > 0 ? (
        <section className="w-blocked" data-testid="blocked-jobs">
          <div className="w-label" style={{ color: "rgb(240 104 95)", marginBottom: 8 }}>Needs you ({blocked.length})</div>
          {blocked.map((j: ScannerJob) => (
            <div key={j.requestId} className="w-blocked-row">
              <div>
                <div style={{ fontWeight: 700 }}>#{j.orderNumber} · {j.displayName} · {j.scannerId}{jobMode(j) !== mode ? ` · ${jobMode(j)}` : ""}</div>
                <div className="w-small">{j.blocked?.message}</div>
                {j.uncertain ? (
                  <div style={{ fontSize: 15, fontWeight: 700, color: "rgb(245 184 65)" }}>
                    An earlier send may already have saved this. Do NOT record it on the classic station; tap Retry once fixed.
                  </div>
                ) : null}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button type="button" onClick={() => p.onRetry(j.requestId)} className="w-btn">Retry</button>
                {j.uncertain ? null : (
                  <button type="button" onClick={() => arm(j.requestId, () => p.onDismiss(j.requestId))} className="w-btn is-bad">
                    {armed === j.requestId ? "Tap again: I recorded it on classic" : "Recorded on classic"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <footer className="w-footer">
        Scanners send &lt;S1&gt;…&lt;/S1&gt; + Enter. Green appears only after the server saved the work. Amber = stored on this device, not yet saved.
      </footer>
    </div>
  );
}
