import type { PickedPackage } from "@/lib/domain/packaging/evaluate";
import type { CatalogueItem } from "@/lib/domain/packaging/ruleSet";
import { OVERRIDE_REASONS, type PickStatus } from "@/lib/domain/packaging/session";

/**
 * F4 box-auto-pick: the packaging panel shown at packing stations in auto
 * mode, in place of the old "scan a box" panel. Presentational only; state
 * lives in useOrderPackaging.
 *
 * Two looks, one behaviour: "station" uses the redesigned station screen's
 * classes (must render inside .st-root), "classic" uses the old screen's
 * Tailwind classes. F7's dispatch screen can reuse it as is.
 */

/** A pick that is already saved for this shipment (the order was completed here before). */
export interface SavedPickView {
  packages: PickedPackage[];
  state: "auto" | "overridden" | "unresolved" | "legacy_scan";
  stockState: "posted" | "short" | "unposted";
  /** Non-null while the worker is changing the saved pick. */
  editing: { draft: PickedPackage[]; busy: boolean; message: string | null } | null;
  onStartChange: () => void;
  onCancelChange: () => void;
  /** Save the draft with this reason. */
  onConfirm: (reason: string) => void;
}

export interface PackagingPanelProps {
  variant: "station" | "classic";
  /** What the rules predicted and what the worker has chosen so far. */
  status: PickStatus;
  chosen: PickedPackage[];
  predicted: PickedPackage[];
  /** Why nothing could be predicted (unresolved picks). */
  reason: string | null;
  alternatives: CatalogueItem[];
  pendingCount: number;
  onTap: (item: CatalogueItem) => void;
  onAdjust: (key: string, delta: number) => void;
  onReset: () => void;
  saved?: SavedPickView | null;
}

const LOOK = {
  station: {
    panel: "st-panel",
    panelWarn: "st-panel warn",
    head: "st-panel-head",
    row: "st-panel-row",
    chip: "st-pk-chip",
    button: "st-btn-ghost",
    link: "st-link-btn",
    alts: "st-pk-alts",
    note: "st-pk-note",
    qty: "",
  },
  classic: {
    panel: "rounded-2xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3 text-sm",
    panelWarn: "rounded-2xl ring-1 ring-amber-300 dark:ring-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 space-y-3 text-sm",
    head: "text-xs uppercase tracking-widest text-slate-500 flex items-center justify-between",
    row: "flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-slate-50 dark:bg-slate-800/40 ring-1 ring-slate-200 dark:ring-slate-700",
    chip: "text-[10px] font-bold tracking-widest rounded-full px-2 py-0.5 ring-1 ring-current",
    button:
      "min-h-[44px] px-3 rounded-lg ring-1 ring-slate-300 dark:ring-slate-600 bg-white dark:bg-slate-800 text-sm font-semibold text-slate-900 dark:text-slate-100 disabled:opacity-50",
    link: "min-h-[44px] px-2 text-xs text-slate-500 underline",
    alts: "flex flex-wrap gap-2",
    note: "text-xs text-slate-500 dark:text-slate-400",
    qty: "text-lg font-bold tabular-nums mr-2",
  },
} as const;

const STATUS_LABEL: Record<PickStatus, string> = { auto: "AUTO", changed: "CHANGED", flagged: "FLAGGED" };

const SAVED_TEXT: Record<SavedPickView["state"], string> = {
  auto: "Picked automatically.",
  overridden: "Chosen by a worker.",
  unresolved: "Flagged: no packaging was recorded.",
  legacy_scan: "Recorded from a box scan.",
};

function Rows(props: {
  look: (typeof LOOK)[keyof typeof LOOK];
  packages: PickedPackage[];
  editable: boolean;
  disabled?: boolean;
  onAdjust: (key: string, delta: number) => void;
}) {
  const { look, packages, editable, disabled, onAdjust } = props;
  return (
    <>
      {packages.map((p) => (
        <div key={p.key} className={look.row}>
          <span>
            <b className={look.qty}>×{p.qty}</b>
            {p.label}
          </span>
          {editable ? (
            <span style={{ display: "inline-flex", gap: 6 }}>
              <button type="button" className={look.button} disabled={disabled} aria-label={`One fewer ${p.label}`} onClick={() => onAdjust(p.key, -1)}>−</button>
              <button type="button" className={look.button} disabled={disabled} aria-label={`One more ${p.label}`} onClick={() => onAdjust(p.key, 1)}>+</button>
            </span>
          ) : null}
        </div>
      ))}
    </>
  );
}

function Alternatives(props: {
  look: (typeof LOOK)[keyof typeof LOOK];
  items: CatalogueItem[];
  disabled?: boolean;
  onTap: (item: CatalogueItem) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div className={props.look.alts} role="group" aria-label="Use a different packaging item">
      {props.items.map((item) => (
        <button key={item.key} type="button" className={props.look.button} disabled={props.disabled} aria-label={`Use ${item.label}`} onClick={() => props.onTap(item)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Pending({ look, count }: { look: (typeof LOOK)[keyof typeof LOOK]; count: number }) {
  if (count <= 0) return null;
  return (
    <div className={look.note} role="status">
      Packaging not saved yet for {count} {count === 1 ? "order" : "orders"}. It will retry automatically.
    </div>
  );
}

/** Shown on its own when no order is loaded but saves are still waiting. */
export function PackagingPendingNotice({ variant, count }: { variant: "station" | "classic"; count: number }) {
  if (count <= 0) return null;
  const look = LOOK[variant];
  return (
    <div className={look.panelWarn} data-packaging="pending">
      <Pending look={look} count={count} />
    </div>
  );
}

export function PackagingPanel(props: PackagingPanelProps) {
  const look = LOOK[props.variant];
  const { saved } = props;

  if (saved) {
    const editing = saved.editing;
    return (
      <div className={look.panel} data-packaging="saved">
        <div className={look.head}>
          <span>PACKAGING</span>
          <span className={look.chip} data-status="saved">{editing ? "CHANGING" : "SAVED"}</span>
        </div>
        {editing ? (
          <>
            {editing.draft.length === 0 ? <div className={look.note}>No packaging. Tap what was used.</div> : null}
            <Rows look={look} packages={editing.draft} editable disabled={editing.busy} onAdjust={props.onAdjust} />
            <Alternatives look={look} items={props.alternatives} disabled={editing.busy} onTap={props.onTap} />
            <div className={look.note}>Why is it changing? Tap a reason to save.</div>
            <div className={look.alts} role="group" aria-label="Reason for the change">
              {OVERRIDE_REASONS.map((r) => (
                <button key={r} type="button" className={look.button} disabled={editing.busy} onClick={() => saved.onConfirm(r)}>
                  {r}
                </button>
              ))}
            </div>
            {editing.message ? <div className={look.note} role="alert">{editing.message}</div> : null}
            <button type="button" className={look.link} disabled={editing.busy} onClick={saved.onCancelChange}>Cancel</button>
          </>
        ) : (
          <>
            {saved.packages.length === 0 ? <div className={look.note}>No packaging recorded.</div> : null}
            <Rows look={look} packages={saved.packages} editable={false} onAdjust={props.onAdjust} />
            <div className={look.note}>
              {SAVED_TEXT[saved.state]} Already recorded for this order; completing again will not deduct again.
            </div>
            {saved.stockState !== "posted" ? (
              <div className={look.note} role="status">Stock for this packaging is short. It shows on the managers&apos; list.</div>
            ) : null}
            <button type="button" className={look.button} onClick={saved.onStartChange}>Change box</button>
          </>
        )}
        <Pending look={look} count={props.pendingCount} />
      </div>
    );
  }

  const flagged = props.status === "flagged";
  return (
    <div className={flagged ? look.panelWarn : look.panel} data-packaging={props.status}>
      <div className={look.head}>
        <span>PACKAGING</span>
        <span className={look.chip} data-status={props.status}>{STATUS_LABEL[props.status]}</span>
      </div>
      {props.chosen.length === 0 ? (
        <div className={look.note}>
          {flagged
            ? `${props.reason ?? "No box rule covers this order."} You can still complete: the order is flagged for a manager. Or tap the packaging you used.`
            : "Nothing to pack at this station for this order."}
        </div>
      ) : null}
      <Rows look={look} packages={props.chosen} editable onAdjust={props.onAdjust} />
      <Alternatives look={look} items={props.alternatives} onTap={props.onTap} />
      {props.status === "changed" ? (
        <button type="button" className={look.link} onClick={props.onReset}>
          {props.predicted.length > 0
            ? `Back to suggested (${props.predicted.map((p) => `×${p.qty} ${p.label}`).join(", ")})`
            : "Clear my choice"}
        </button>
      ) : null}
      <Pending look={look} count={props.pendingCount} />
    </div>
  );
}
