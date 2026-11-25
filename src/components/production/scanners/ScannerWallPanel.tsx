import type { ScannerSlot } from "@/lib/scanners/session";
import { IDENTITY_IDLE_MS, msUntilExpiry, SIGN_OUT_WINDOW_MS } from "@/lib/scanners/session";
import type { ScanMode } from "@/lib/scanners/dispatch";
import type { PersonWallTotals } from "@/lib/scanners/wallTotals";
import type { SlotProgress, SlotSaved } from "@/lib/scanners/station";

/**
 * scanner-wall-redesign: one scanner's panel on the wall. Pure: everything
 * comes in as props. Nobody touches it; it only shows what is happening.
 */

/** A goodbye after a badge sign-out, with the person's last known numbers. */
export interface PanelGoodbye {
  displayName: string;
  orders: number | null;
  pieces: number | null;
  /** Site time of the read the numbers came from; null = no numbers known. */
  asOf: string | null;
  at: number;
}

/** Today's numbers for this panel's person: values, "pending" (being read) or null (unavailable). */
export type PanelTotals = PersonWallTotals | "pending" | null;

export interface ScannerWallPanelProps {
  id: string;
  slot: ScannerSlot | undefined;
  mode: ScanMode;
  /** Wall clock (ms). */
  now: number;
  /** Monotonic clock (ms) for the sign-out countdown. */
  elapsedNow: number;
  totals: PanelTotals;
  /** Oldest unfinished scan on this scanner, with how many are waiting. */
  progress: SlotProgress | null;
  /** Last order saved here for this person (never another person's). */
  saved: SlotSaved | null;
  goodbye: PanelGoodbye | null;
  note: string | null;
  timeZone?: string;
  /**
   * While the garbled-scan recovery message is up the panels shrink to one
   * row (the approved Problem screen): who is still signed in, and their orders.
   */
  compact?: boolean;
}

/** The goodbye card shows for at most this long. */
export const GOODBYE_MS = 5_000;

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const DASH = "—";

const PHASE_TEXT: Record<SlotProgress["phase"], { step: number; text: string }> = {
  receiving: { step: 1, text: "Receiving scan…" },
  received: { step: 1, text: "Scan received" },
  checking: { step: 2, text: "Checking the order…" },
  saving: { step: 3, text: "Saving…" },
  waiting: { step: 1, text: "Waiting to save (will retry)" },
};

function Progress({ p, person, mode }: { p: SlotProgress; person: string; mode: ScanMode }) {
  const { step, text } = PHASE_TEXT[p.phase];
  return (
    <div className="w-box" data-testid="panel-progress" data-phase={p.phase}>
      <div style={{ fontSize: 22, fontWeight: 700 }}>Order #{p.orderNumber}</div>
      <div className="w-pulse" style={{ fontSize: 18, fontWeight: 700 }}>
        {p.phase === "saving" ? `Saving to ${person}…` : text}
      </div>
      <div className="w-bar is-busy" aria-hidden="true"><span style={{ width: `${Math.round((step / 3) * 100)}%` }} /></div>
      <div className="w-small">
        Step {step} of 3 · {mode === "dispatch" ? "keep going, no need to wait" : "keep framing, no need to wait"}{p.waiting > 1 ? ` · ${p.waiting - 1} more waiting` : ""}
      </div>
    </div>
  );
}

export function ScannerWallPanel(p: ScannerWallPanelProps) {
  const { id, slot, mode } = p;
  const identity = slot?.identity ?? null;
  const framing = mode === "framing";

  if (p.compact) {
    const t = p.totals && p.totals !== "pending" ? p.totals : null;
    return (
      <section className={`w-panel is-compact${identity ? "" : " is-free"}`} data-testid={`scanner-${id}`} aria-label={`Scanner ${id}${identity ? `: ${identity.displayName}` : ""}`}>
        <div>
          <div className="w-label">Scanner {id}</div>
          <div className="w-name-compact">{identity ? identity.displayName : slot?.pending ? "Checking badge…" : "Scan your badge to start"}</div>
          {identity ? <div className="w-small">{slot?.signOut ? `Sign out ${slot.signOut.count}/3` : "Still signed in"}</div> : null}
        </div>
        {identity && framing ? (
          <div style={{ textAlign: "right" }}>
            <div className="w-num w-compact-value" data-testid={`orders-${id}`}>{t ? t.orders : DASH}</div>
            <div className="w-small">ORDERS</div>
          </div>
        ) : null}
      </section>
    );
  }

  // ---- nobody on this scanner -------------------------------------------
  if (!identity) {
    const checking = !!slot?.pending;
    const bye = p.goodbye && p.now - p.goodbye.at <= GOODBYE_MS ? p.goodbye : null;
    return (
      <section className="w-panel is-free" data-testid={`scanner-${id}`} aria-label={`Scanner ${id}`}>
        <div className="w-panel-top">
          <span className="w-label">Scanner {id}</span>
          {bye ? <span className="w-pill is-lead">Signed out</span> : <span className="w-small">Free</span>}
        </div>
        <div className="w-free">
          {checking ? (
            <div className="w-free-title w-pulse">Checking badge…</div>
          ) : bye ? (
            <>
              <div className="w-free-title">Bye, {bye.displayName}</div>
              {bye.orders !== null && bye.asOf ? (
                <div style={{ fontSize: 20 }}>
                  <span className="w-num">{bye.orders}</span> order{bye.orders === 1 ? "" : "s"} · <span className="w-num">{bye.pieces ?? DASH}</span> pieces today
                  <div className="w-small">as of {bye.asOf}</div>
                </div>
              ) : null}
              <div className="w-small">Still clocked in. Clock out on the station screen when you leave.</div>
            </>
          ) : (
            <>
              <div className="w-free-title">Scan your badge to start</div>
              <div className="w-small">
                {framing ? "Then scan each packing slip when the order is framed." : "Scan your badge once for the shift, then order slips."}
              </div>
            </>
          )}
          {p.note ? <div className="w-note" data-testid={`note-${id}`}>{p.note}</div> : null}
        </div>
      </section>
    );
  }

  // ---- someone is on this scanner ----------------------------------------
  const t = p.totals;
  const values = t && t !== "pending" ? t : null;
  const leading = framing && !!values?.leading;
  const signOut = framing ? slot?.signOut ?? null : null;
  const repeatChecking = !!slot?.pending?.repeat;
  const busy = p.progress !== null;
  const left = msUntilExpiry(identity, p.now);
  const panelClass = ["w-panel", leading ? "is-leading" : "", busy ? "is-busy" : "", signOut ? "is-signing-out" : ""].filter(Boolean).join(" ");

  let pill: JSX.Element | null = null;
  if (signOut) pill = <span className="w-pill is-warn">Signing out</span>;
  else if (busy) pill = <span className="w-pill is-busy w-pulse">Working on it</span>;
  else if (framing && values?.leading) pill = <span className="w-pill is-lead">{values.jointLead ? "Joint lead" : "Leading today"}</span>;
  else if (framing && values?.rank) pill = <span className="w-small">{ordinal(values.rank)} today</span>;

  const signOutLeft = signOut ? Math.max(0, SIGN_OUT_WINDOW_MS - (p.elapsedNow - signOut.firstRepeatAt)) : 0;

  return (
    <section className={panelClass} data-testid={`scanner-${id}`} aria-label={`Scanner ${id}: ${identity.displayName}`}>
      <div className="w-panel-top">
        <span className="w-label">Scanner {id}</span>
        {pill}
      </div>
      <div className="w-name">{identity.displayName}</div>
      {repeatChecking ? <div className="w-small w-pulse">Checking badge…</div> : null}

      {framing && !busy && !signOut ? (
        <div className="w-stats">
          <div className="w-stat">
            <div className="w-stat-label">ORDERS</div>
            <div className="w-stat-value" data-testid={`orders-${id}`}>{values ? values.orders : DASH}</div>
          </div>
          <div className="w-stat">
            <div className="w-stat-label">PIECES</div>
            <div className="w-stat-value" data-testid={`pieces-${id}`}>{values ? (values.pieces ?? DASH) : DASH}</div>
          </div>
        </div>
      ) : null}
      {framing && t === "pending" ? <div className="w-small">Updating today's totals…</div> : null}
      {framing && values && values.share !== null && !busy && !signOut ? (
        <div>
          <div className="w-small" style={{ marginBottom: 6 }}>Share of active people's order credits</div>
          <div className="w-bar" aria-hidden="true"><span style={{ width: `${Math.round(values.share * 100)}%` }} /></div>
        </div>
      ) : null}

      {signOut ? (
        <div className="w-box is-warn" data-testid={`signout-${id}`}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{id} · {identity.displayName} · Sign out {signOut.count}/3</div>
            <div className="w-dots" aria-hidden="true">
              {[1, 2, 3].map((n) => <span key={n} className={n <= signOut.count ? "is-on" : ""} />)}
            </div>
          </div>
          <div style={{ fontSize: 16 }}>Remove badge; wait one second before scanning again.</div>
          <div className="w-bar is-warn" aria-hidden="true"><span style={{ width: `${Math.round((signOutLeft / SIGN_OUT_WINDOW_MS) * 100)}%` }} /></div>
          <div className="w-small">{Math.ceil(signOutLeft / 1000)} seconds left, or it starts over</div>
        </div>
      ) : null}

      {p.progress ? <Progress p={p.progress} person={identity.displayName} mode={mode} /> : null}

      <div className="w-foot">
        {framing && (busy || signOut) ? (
          <div data-testid={`today-${id}`}>
            <span className="w-muted">Today:</span>{" "}
            <b className="w-num" data-testid={`orders-${id}`}>{values ? values.orders : DASH}</b> orders ·{" "}
            <b className="w-num" data-testid={`pieces-${id}`}>{values ? (values.pieces ?? DASH) : DASH}</b> pieces
          </div>
        ) : null}
        {framing ? (
          <div>
            <span className="w-muted">Last saved here:</span>{" "}
            {p.saved ? `#${p.saved.orderNumber} · ${p.saved.pieces} piece${p.saved.pieces === 1 ? "" : "s"}` : "No recent saved order on this scanner"}
          </div>
        ) : null}
        {identity.expiresAt !== undefined ? (
          <div className="w-small">
            Dispatching until {new Date(identity.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(p.timeZone ? { timeZone: p.timeZone } : {}) })}
          </div>
        ) : (
          <div>
            <div className="w-small" style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span>Active</span>
              <span>Signs out in {mmss(left ?? 0)} without a scan</span>
            </div>
            <div className="w-bar is-thin" aria-hidden="true"><span style={{ width: `${Math.round(((left ?? 0) / IDENTITY_IDLE_MS) * 100)}%` }} /></div>
          </div>
        )}
        {p.note ? <div className="w-note" data-testid={`note-${id}`}>{p.note}</div> : null}
      </div>
    </section>
  );
}
