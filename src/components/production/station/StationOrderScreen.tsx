import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Layers, LogOut, Menu, Settings as SettingsIcon, Undo2 } from "lucide-react";
import { detectOrientation, skuTypeBadge } from "@/lib/domain/skuRouting";
import {
  buildStationProgress,
  diffCheckedKeys,
  getStationLineView,
  nextPickCount,
  orderDoneKeys,
  scrollBehaviorFor,
  scrollTargetFor,
  sortByGroup,
  type StationGroup,
  type StationLineInput,
  type StationLineView,
} from "./stationScreenModel";
import "./station.css";

/**
 * Station screen redesign: the signed-in station screen (waiting for an
 * order + working on an order). Presentation only - every write goes
 * through the handlers the Production page passes in.
 */

export interface StationScreenLine extends StationLineInput {
  /** Label of the department that owns a line this station doesn't action. */
  otherDeptLabel?: string | null;
}

export interface StationScreenOrder {
  number: string;
  displayName: string;
  totalLines: number;
  lines: StationScreenLine[];
}

export interface StationVerifiedRecord {
  staff_id: string;
  time: string;
}

export interface StationPackageRow {
  key: string;
  label: string;
  qty: number;
}

export interface StationOrderScreenProps {
  departmentLabel: string;
  locationCode: string;
  locationLabel: string;
  staff: { user_id: string; display_name: string };
  todayCount: number | null;
  todayItems: number | null;
  /** F1 counter load state; "stale"/"error" figures are marked not current. Omitted = current. */
  todayState?: "unavailable" | "loading" | "current" | "stale" | "error";
  /** F1 CS/rework counts, always separate from normal work. */
  todayRework?: { orders: number; items: number | null } | null;
  /** F1 status/coverage line (ProductionCountStatus), shown in the idle sidebar. */
  countStatus?: ReactNode;
  /** Re-read the counter after a failed refresh. */
  onRetryCount?: () => void;
  order: StationScreenOrder | null;
  verified: ReadonlyMap<string, StationVerifiedRecord>;
  staffNames: ReadonlyMap<string, string>;
  scanBuffer: string;
  error: string | null;
  /** Shown above the list, e.g. the order-notes panel. */
  notes?: ReactNode;
  activeCase: { caseId: string; issueType: string; urgency: string; customerName: string | null } | null;
  /** Box panel: null when this station doesn't scan boxes. */
  packages: { rows: StationPackageRow[]; required: boolean; auto: boolean } | null;
  /** F4 auto mode: shown in place of the box panel (pass packages = null with it). */
  packagingSlot?: ReactNode;
  onVerify: (key: string) => void;
  onUnverify: (key: string) => void;
  onCompleteOrder: () => void;
  onScrapOrder: () => void;
  onClearOrder: () => void;
  onManualOrderSubmit: (orderNumber: string) => void;
  onRemovePackage: (key: string) => void;
  onClearPackages: () => void;
  onClockOut: () => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  backHref: string;
}

type ToastKind = "done" | "partial" | "undo";
interface ToastState { kind: ToastKind; title: string; sub: string; id: number }

const TOAST_BG: Record<ToastKind, string> = { done: "#0A7F4F", partial: "#D68000", undo: "#5A6270" };
const PAPER: Record<string, [number, number]> = { A0: [26, 36], A1: [22, 31], A2: [18, 25], A3: [14, 20], A4: [10, 15] };
const GROUP_HEADINGS: Record<StationGroup, string> = { frame: "TO FRAME", flat: "PACK FLAT", other: "FOR REFERENCE" };

export function StationOrderScreen(props: StationOrderScreenProps) {
  const { order } = props;
  return (
    <div className="st-root">
      <TopBar {...props} />
      {/* Keyed by order: a new order starts with fresh piece counts,
          scroll position and no open scrap confirmation. */}
      {order ? <WorkingView key={order.number} {...props} order={order} /> : <IdleView {...props} />}
    </div>
  );
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => (typeof document === "undefined" ? true : document.hasFocus()));
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

function notCurrent(p: StationOrderScreenProps): boolean {
  return p.todayState === "stale" || p.todayState === "error";
}

/** F1: a failed refresh never leaves old figures looking current. */
function CountFlag(p: StationOrderScreenProps) {
  if (!notCurrent(p)) return null;
  return (
    <div role="status" style={{ color: "var(--warn, #b45309)" }}>
      Not current{p.todayState === "stale" ? " (refresh failed)" : ""}
      {p.onRetryCount ? (
        <>
          {" "}
          <button type="button" onClick={p.onRetryCount} style={{ textDecoration: "underline" }}>Retry</button>
        </>
      ) : null}
    </div>
  );
}

function ReworkLine(p: StationOrderScreenProps) {
  const r = p.todayRework;
  if (!r || (r.orders === 0 && (r.items ?? 0) === 0)) return null;
  return <div>CS/rework <b>{r.items ?? "–"}</b> items · <b>{r.orders}</b> orders</div>;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function TopBar(props: StationOrderScreenProps) {
  const focused = useWindowFocus();
  // Simple disclosure (button + list of ordinary controls): opens with focus
  // on the first item, Escape or an outside click closes it and returns
  // focus to the toggle.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    firstItemRef.current?.focus();
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="st-topbar">
      <div className="st-brand">INKA ARTHOUSE</div>
      <span className="st-vr" />
      <div className="st-station">Station <b>{props.departmentLabel}</b></div>
      <span className="st-loc" title={props.locationLabel}>{props.locationCode.toUpperCase()}</span>
      <div className="st-grow" />
      <button
        type="button"
        className={"st-scanner" + (focused ? "" : " off")}
        onClick={() => window.focus()}
        title="Scans only register while this window is focused. Press Esc to clear the scan buffer."
      >
        <i aria-hidden="true" />
        {focused ? "Scanner live" : "Click here to scan"}
      </button>
      <span className="st-vr" />
      <div className="st-today" data-count-state={props.todayState ?? "current"} style={notCurrent(props) ? { opacity: 0.7 } : undefined}>
        <div>Orders today <b>{props.todayCount ?? "–"}</b></div>
        <div>Items <b>{props.todayItems ?? "–"}</b></div>
        <ReworkLine {...props} />
        <CountFlag {...props} />
      </div>
      <span className="st-vr" />
      <div className="st-user">
        <span className="st-avatar" aria-hidden="true">{initials(props.staff.display_name)}</span>
        {props.staff.display_name}
      </div>
      <div className="st-menu-wrap" ref={menuRef}>
        <button
          ref={toggleRef}
          type="button"
          className="st-icon-btn"
          aria-label="Station menu"
          aria-expanded={menuOpen}
          aria-controls="st-station-menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="st-menu" id="st-station-menu">
            <button ref={firstItemRef} type="button" className="danger" onClick={() => { setMenuOpen(false); props.onSignOut(); }}>
              <LogOut size={16} aria-hidden="true" /> Sign out
            </button>
            <a href={props.backHref}>Back to app</a>
            <button type="button" onClick={() => { setMenuOpen(false); props.onOpenSettings(); }}>
              <SettingsIcon size={16} aria-hidden="true" /> Station settings
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function TickIcon({ size, color, width = 3.2 }: { size: number; color: string; width?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Thumb({ line, mini }: { line: StationLineView; mini?: boolean }) {
  if (mini) {
    const style = line.frameColor
      ? { width: 28, height: 36, border: `3px solid ${line.frameColor}`, padding: 2, boxShadow: "0 0 0 1px rgba(16,24,40,.12)" }
      : { width: 28, height: 36, border: "1px solid var(--border-strong)", padding: 2 };
    return (
      <span aria-hidden="true" style={{ display: "inline-block", flex: "0 0 auto", borderRadius: 2, background: "var(--paper)", ...style }} />
    );
  }
  return (
    <div
      className={"st-thumb " + (line.frameColor ? "framed" : "flat")}
      style={line.frameColor ? { borderColor: line.frameColor } : undefined}
      aria-hidden="true"
    >
      {/* F3 adds real artwork thumbnails; until then a labelled placeholder. */}
      <div className="art">ARTWORK</div>
    </div>
  );
}

function PackagesPanel({ packages, onRemovePackage, onClearPackages }: Pick<StationOrderScreenProps, "packages" | "onRemovePackage" | "onClearPackages">) {
  if (!packages) return null;
  if (packages.auto) {
    if (packages.rows.length === 0) return null;
    return (
      <div className="st-panel">
        <div className="st-panel-head"><span>AUTO-ASSIGNED PACKAGING</span></div>
        {packages.rows.map((r) => (
          <div key={r.key} className="st-panel-row"><span><b>×{r.qty}</b>{r.label}</span></div>
        ))}
      </div>
    );
  }
  return (
    <div className={"st-panel" + (packages.required && packages.rows.length === 0 ? " warn" : "")}>
      <div className="st-panel-head">
        <span>BOXES FOR THIS SHIPMENT</span>
        {packages.rows.length > 0 ? (
          <button type="button" className="st-link-btn" style={{ minHeight: 32 }} onClick={onClearPackages}>Clear all</button>
        ) : null}
      </div>
      {packages.rows.length === 0 ? (
        <span>Scan a box barcode to add it. Each scan adds 1 box.</span>
      ) : (
        packages.rows.map((r) => (
          <div key={r.key} className="st-panel-row">
            <span><b>×{r.qty}</b>{r.label}</span>
            <button type="button" className="st-btn-ghost" style={{ minHeight: 36 }} aria-label={`Remove one ${r.label}`} onClick={() => onRemovePackage(r.key)}>−1</button>
          </div>
        ))
      )}
    </div>
  );
}

function CaseBanner({ activeCase }: Pick<StationOrderScreenProps, "activeCase">) {
  if (!activeCase) return null;
  return (
    <div className="st-panel case">
      <div className="st-panel-head" style={{ color: "inherit" }}><span>REPLACEMENT · CASE #{activeCase.caseId}</span></div>
      <span>
        {activeCase.issueType.replace(/_/g, " ")} · <b style={{ fontFamily: "var(--sans)" }}>{activeCase.urgency}</b>
        {activeCase.customerName ? ` · ${activeCase.customerName}` : ""}
      </span>
      <span style={{ fontSize: 12 }}>Every check is logged against this case.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Working on an order
// ---------------------------------------------------------------------------

function WorkingView(props: StationOrderScreenProps & { order: StationScreenOrder }) {
  const { order, verified } = props;
  const views = useMemo(() => sortByGroup(order.lines.map(getStationLineView)), [order.lines]);
  const otherDept = useMemo(
    () => new Map(order.lines.map((l) => [l.key, l.otherDeptLabel ?? null] as const)),
    [order.lines],
  );
  const checkedKeys = useMemo(() => new Set(views.filter((v) => verified.has(v.key)).map((v) => v.key)), [views, verified]);
  const progress = buildStationProgress(views, checkedKeys);
  const required = views.filter((v) => v.needsCheck);

  // Screen-only piece counts for qty > 1 lines (the app verifies per line).
  const [picked, setPicked] = useState<Map<string, number>>(new Map());
  const [confirmScrap, setConfirmScrap] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeq = useRef(0);
  const showToast = (kind: ToastKind, title: string, sub: string) => {
    toastSeq.current += 1;
    setToast({ kind, title, sub, id: toastSeq.current });
  };
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  // Toast on real verify/unverify results: only after the saved state
  // changes (diffCheckedKeys), never on the tap itself.
  const prevChecked = useRef<Set<string> | null>(null);
  useEffect(() => {
    const changes = diffCheckedKeys(prevChecked.current, checkedKeys, views.map((v) => v.key));
    prevChecked.current = checkedKeys;
    for (const c of changes) {
      const v = views.find((x) => x.key === c.key);
      if (!v) continue;
      if (c.kind === "done") {
        showToast(
          "done",
          v.quantity > 1 ? `All ${v.quantity} pieces checked` : "Checked",
          [v.title, v.size, v.frameLabel].filter(Boolean).join(" · "),
        );
      } else {
        showToast("undo", "Unchecked", v.title);
        setPicked((m) => { const n = new Map(m); n.delete(v.key); return n; });
      }
    }
  }, [checkedKeys, views]);

  // Keep the current card in view after every check (no smooth scrolling
  // when the OS asks for reduced motion).
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    const target = scrollTargetFor(lastCurrent.current, progress.currentKey);
    lastCurrent.current = progress.currentKey;
    if (!target) return;
    const el = cardRefs.current.get(target);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: scrollBehaviorFor(prefersReducedMotion()), block: "center" });
    }
  }, [progress.currentKey]);

  const onCheck = (v: StationLineView) => {
    const { picked: n, verify } = nextPickCount(picked.get(v.key) ?? 0, v.quantity);
    if (verify) {
      props.onVerify(v.key);
    } else {
      setPicked((m) => new Map(m).set(v.key, n));
      showToast("partial", `Piece ${n} of ${v.quantity} checked`, `Check the next ${v.title}`);
    }
  };

  const doneTimes = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of views) {
      const rec = verified.get(v.key);
      if (rec && v.needsCheck) m.set(v.key, rec.time);
    }
    return m;
  }, [views, verified]);
  const doneList = orderDoneKeys(views.map((v) => v.key), doneTimes)
    .map((k) => views.find((v) => v.key === k)!)
    .filter(Boolean);

  // Same rule as the classic action bar: A0 Framed / Unframed need packaging set.
  const packagesBlocked = !!props.packages && props.packages.required && props.packages.rows.length === 0;
  const canComplete = progress.allDone && !packagesBlocked;
  const pct = progress.required > 0 ? Math.round((progress.checked / progress.required) * 100) : 0;
  const lockedLabel = !progress.allDone
    ? progress.required === 0
      ? "Nothing to check here"
      : `${progress.remaining} ${progress.remaining === 1 ? "item" : "items"} left to check`
    : props.packages?.auto
      ? "No packaging assigned"
      : "Scan a box to finish";

  return (
    <main className="st-layout">
      <aside className="st-sidebar live" aria-label="Order progress">
        {/* Everything above the actions scrolls when replacement details,
            boxes or a long done list don't fit; the actions never move. */}
        <div className="st-side-body st-scroll">
        <div className="st-side-head">
          <div className="st-pill live"><span className="st-live-dot" aria-hidden="true" />WORKING ON</div>
          <button type="button" className="st-link-btn" onClick={props.onClearOrder}>Clear</button>
        </div>
        <div>
          <div className="st-order-no">{order.displayName}</div>
          {order.totalLines !== order.lines.length || views.some((v) => v.group === "other") ? (
            <div className="st-breakdown" style={{ marginTop: 6 }}>
              {required.length} of {order.totalLines} lines for this station
            </div>
          ) : null}
        </div>
        <div>
          <div className="st-progress-top">
            <div><span className="st-big-count">{progress.checked}</span><span className="st-of">of {progress.required} checked</span></div>
            <span className="st-pct">{pct}%</span>
          </div>
          {required.length > 0 ? (
            <div className="st-segs" style={{ gridTemplateColumns: `repeat(${required.length}, minmax(0, 1fr))` }} aria-hidden="true">
              {required.map((v) => (
                <div key={v.key} className={"st-seg" + (checkedKeys.has(v.key) ? " done" : v.key === progress.currentKey ? " current" : "")} />
              ))}
            </div>
          ) : null}
          <div className="st-breakdown">
            {progress.toFrame} to frame · {progress.packFlat} pack flat · <b>{progress.pieces} {progress.pieces === 1 ? "piece" : "pieces"}</b>
          </div>
        </div>

        <CaseBanner activeCase={props.activeCase} />

        <div className="st-done-wrap">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="st-section-label">DONE</span>
            <span className="st-count-pill green">{progress.checked}</span>
          </div>
          <div className="st-done-list st-scroll">
            {doneList.length ? doneList.map((v) => (
              <div key={v.key} className="st-mini">
                <Thumb line={v} mini />
                <div className="st-mini-text">
                  <span className="st-mini-title">{v.title || v.sku}</span>
                  <span className="st-mini-meta">{[v.size, v.frameLabel, `×${v.quantity}`].filter(Boolean).join(" · ")}</span>
                </div>
                <span className="st-tick"><TickIcon size={13} color="#fff" width={3.4} /></span>
              </div>
            )) : <div className="st-done-empty">Checked items will appear here</div>}
          </div>
        </div>

        {props.packagingSlot ?? <PackagesPanel packages={props.packages} onRemovePackage={props.onRemovePackage} onClearPackages={props.onClearPackages} />}
        </div>

        <div className="st-actions">
          {props.error ? <div className="st-error" role="alert">{props.error}</div> : null}
          {canComplete ? (
            <div className="st-ready-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7 7 7-7" /></svg>
              All items checked. Finish the order below.
            </div>
          ) : null}
          <button
            type="button"
            className={"st-btn-complete " + (canComplete ? "ready" : "locked")}
            disabled={!canComplete}
            onClick={props.onCompleteOrder}
          >
            {canComplete ? (<><TickIcon size={22} color="#fff" width={3} />Complete order</>) : lockedLabel}
          </button>
          {confirmScrap ? (
            <div className="st-confirm" role="group" aria-label="Confirm scrap">
              <span>Scrap this order? This can’t be undone.</span>
              <div className="st-confirm-row">
                <button type="button" className="st-btn-ghost" onClick={() => setConfirmScrap(false)}>Keep working</button>
                <button type="button" className="st-btn-danger" onClick={() => { setConfirmScrap(false); props.onScrapOrder(); }}>Yes, scrap</button>
              </div>
            </div>
          ) : (
            <button type="button" className="st-btn-scrap" onClick={() => setConfirmScrap(true)}>Scrap order</button>
          )}
        </div>
      </aside>

      <div className="st-list st-scroll">
        {props.notes ? <div>{props.notes}</div> : null}
        {(["frame", "flat", "other"] as StationGroup[]).map((g) => {
          const rows = views.filter((v) => v.group === g);
          if (!rows.length) return null;
          const countable = rows.filter((v) => v.needsCheck);
          const done = countable.filter((v) => checkedKeys.has(v.key)).length;
          return (
            <section key={g} className="st-group" aria-label={GROUP_HEADINGS[g]}>
              <div className="st-group-head">
                <h2>{GROUP_HEADINGS[g]}</h2>
                {g === "other" ? (
                  <span className="st-group-note">Not checked at this station</span>
                ) : countable.length === 0 ? null : (
                  <span className={"st-count-pill" + (countable.length > 0 && done === countable.length ? " full" : "")}>
                    {done} / {countable.length}
                  </span>
                )}
                <span className="rule" />
              </div>
              {rows.map((v) => (
                <LineCard
                  key={v.key}
                  line={v}
                  isCurrent={v.key === progress.currentKey}
                  isDone={checkedKeys.has(v.key)}
                  picked={checkedKeys.has(v.key) ? v.quantity : picked.get(v.key) ?? 0}
                  verifiedBy={(() => {
                    const rec = verified.get(v.key);
                    if (!rec) return null;
                    const time = new Date(rec.time).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
                    return `${props.staffNames.get(rec.staff_id) ?? "Staff"} · ${time}`;
                  })()}
                  otherDeptLabel={otherDept.get(v.key) ?? null}
                  orientation={detectOrientation(v.variantTitle)}
                  onCheck={() => onCheck(v)}
                  onUndo={() => props.onUnverify(v.key)}
                  cardRef={(el) => {
                    if (el) cardRefs.current.set(v.key, el);
                    else cardRefs.current.delete(v.key);
                  }}
                />
              ))}
            </section>
          );
        })}
      </div>

      {toast ? (
        <div key={toast.id} className="st-toast" role="status" aria-live="polite">
          <span className="ti" style={{ background: TOAST_BG[toast.kind] }}>
            {toast.kind === "undo" ? <Undo2 size={20} color="#fff" aria-hidden="true" /> : <TickIcon size={20} color="#fff" />}
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
            <span className="tt">{toast.title}</span>
            <span className="ts">{toast.sub}</span>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function LineCard({
  line, isCurrent, isDone, picked, verifiedBy, otherDeptLabel, orientation, onCheck, onUndo, cardRef,
}: {
  line: StationLineView;
  isCurrent: boolean;
  isDone: boolean;
  picked: number;
  verifiedBy: string | null;
  otherDeptLabel: string | null;
  orientation: "portrait" | "landscape" | null;
  onCheck: () => void;
  onUndo: () => void;
  cardRef: (el: HTMLElement | null) => void;
}) {
  const multi = line.quantity > 1;
  const [pw, ph] = PAPER[line.size ?? ""] ?? [16, 22];
  const [iconW, iconH] = orientation === "landscape" ? [ph, pw] : [pw, ph];
  const muted = !line.needsCheck && !isDone;
  const cls = "st-card" + (isDone ? " is-done" : "") + (isCurrent ? " is-current" : "") + (muted ? " is-muted" : "");
  const qtyLabel = multi
    ? isDone ? `PICKED ${line.quantity}` : picked > 0 ? `PICKED ${picked} OF ${line.quantity}` : `PICK ${line.quantity}`
    : "QTY";
  const typeBadge = skuTypeBadge(line.sku);
  const btnLabel = multi ? `Check piece ${picked + 1} of ${line.quantity}` : isCurrent ? "Done – check off" : "Check off";
  const skuLine = line.fallbackDescription ? `${line.sku} · ${line.fallbackDescription}` : line.sku;

  // Order matters: a line nobody checks (gift card) says so even though it
  // sits in the reference group, so it isn't mistaken for another
  // station's work.
  let action: ReactNode;
  if (!line.verifiable && !isDone) {
    action = <span className="st-status-text">NO CHECK NEEDED</span>;
  } else if (isDone) {
    action = (
      <>
        <div className="st-checked"><span className="c"><TickIcon size={20} color="#0A7F4F" /></span>Checked</div>
        {line.belongsToThisDept ? (
          <button type="button" className="st-btn-undo" onClick={onUndo} aria-label={`Undo check of ${line.title}`}>Undo</button>
        ) : (
          <span className="st-hint">{verifiedBy}</span>
        )}
      </>
    );
  } else if (line.group === "other") {
    action = <span className="st-status-text">{otherDeptLabel ? `${otherDeptLabel.toUpperCase()} STATION` : "OTHER STATION"}</span>;
  } else {
    action = (
      <>
        <button type="button" className="st-btn-check" onClick={onCheck}>{btnLabel}</button>
        <span className="st-hint">{multi ? "Check each piece" : " "}</span>
      </>
    );
  }

  return (
    <article className={cls} ref={cardRef} data-key={line.key} aria-current={isCurrent ? "step" : undefined}>
      <Thumb line={line} />
      <div className="st-body">
        <div>
          <div className="st-title-row">
            {isCurrent ? <span className="st-tag current">CURRENT</span> : null}
            <h3 className="st-title" title={line.title}>{line.title || line.sku}</h3>
            {typeBadge !== "PRINT" ? <span className="st-tag type">{typeBadge}</span> : null}
            {otherDeptLabel && line.group === "other" ? <span className="st-tag dept">{otherDeptLabel.toUpperCase()}</span> : null}
          </div>
          <span className="st-sku" title={skuLine}>{skuLine}{isDone && verifiedBy ? ` · ${verifiedBy}` : ""}</span>
        </div>
        <div className="st-specs">
          <div className="st-spec">
            <span className="st-spec-ico st-ico-size" aria-hidden="true">
              <span className="st-paper" style={{ width: iconW, height: iconH }} />
            </span>
            <div className="st-spec-txt">
              {/* Orientation replaces the SIZE label when Shopify states it; the icon rotates too. */}
              <span className="st-spec-label">{orientation ? orientation.toUpperCase() : "SIZE"}</span>
              <span className="st-spec-val">{line.size ?? "—"}</span>
            </div>
          </div>
          <div className={"st-spec" + (line.frameColor ? "" : " no-frame")}>
            <span className="st-spec-ico st-ico-frame" aria-hidden="true">
              <span className={"st-frame-ico " + (line.frameColor ? "framed" : "none")} style={line.frameColor ? { borderColor: line.frameColor } : undefined} />
            </span>
            <div className="st-spec-txt">
              <span className="st-spec-label">FRAME</span>
              <span className="st-spec-val">{line.frameLabel}</span>
            </div>
          </div>
          <div className={"st-spec" + (multi ? " qty-alert" : "")}>
            <span className="st-spec-ico st-ico-qty" aria-hidden="true"><Layers size={20} aria-hidden="true" /></span>
            <div className="st-spec-txt">
              <span className="st-spec-label">{qtyLabel}</span>
              <span className="st-spec-val">
                × {line.quantity}
                {multi ? (
                  <span className="st-pips" aria-hidden="true">
                    {Array.from({ length: Math.min(line.quantity, 12) }, (_, k) => (
                      <span key={k} className={"st-pip" + (k < picked ? " on" : "")} />
                    ))}
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          {/* Set prints: the "SET (n)" tag in the title row carries the
              piece count, so the row stays at three chips and never clips. */}
        </div>
      </div>
      <div className="st-action">{action}</div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Waiting for an order
// ---------------------------------------------------------------------------

function IdleView(props: StationOrderScreenProps) {
  const [value, setValue] = useState("");
  return (
    <main className="st-layout">
      <aside className="st-sidebar idle" aria-label="Today">
        <div className="st-pill idle"><span className="st-idle-dot" aria-hidden="true" />IDLE</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="st-section-label" style={{ color: "var(--muted)", fontWeight: 600 }}>TODAY (SINCE 4AM)</span>
          <div>
            <span className="st-big-count" style={{ color: "var(--ink)" }}>{props.todayCount ?? "–"}</span>
            <span className="st-of">{props.todayCount === 1 ? "order" : "orders"} · {props.todayItems ?? "–"} items</span>
          </div>
          {props.countStatus ?? null}
        </div>
        <div className="st-done-wrap">
          <div className="st-done-empty">Scan a packing slip to start an order, or swipe another lanyard to switch worker.</div>
        </div>
        {props.packagingSlot ?? <PackagesPanel packages={props.packages} onRemovePackage={props.onRemovePackage} onClearPackages={props.onClearPackages} />}
        <div className="st-actions">
          <button type="button" className="st-btn-clockout" onClick={props.onClockOut} title="Writes a clock-out event and idles the station">
            <LogOut size={18} aria-hidden="true" /> Clock out
          </button>
        </div>
      </aside>
      <section className="st-scan-zone">
        <span className="st-scan-ico" aria-hidden="true">
          <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ color: "var(--blue)" }}>
            <path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3" /><path d="M7 8v8M10 8v8M13 8v8M16 8v8" />
          </svg>
          <span className="st-scan-line" />
        </span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
          <span className="st-eyebrow">READY FOR NEXT ORDER</span>
          <h1>Scan the packing slip</h1>
          <p>Items for the {props.departmentLabel} station load automatically.</p>
        </div>
        <form
          className="st-manual"
          onSubmit={(e) => {
            e.preventDefault();
            const v = value.trim();
            if (!v) return;
            props.onManualOrderSubmit(v);
            setValue("");
          }}
        >
          <label htmlFor="st-manual-order">No barcode?</label>
          <input
            id="st-manual-order"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="Order number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="st-btn-primary" disabled={!value.trim()}>Open order</button>
        </form>
        {props.scanBuffer ? <div className="st-buffer">buffer: {props.scanBuffer}</div> : null}
        {props.error ? <div className="st-error" role="alert" style={{ maxWidth: 560, textAlign: "left" }}>{props.error}</div> : null}
      </section>
    </main>
  );
}
