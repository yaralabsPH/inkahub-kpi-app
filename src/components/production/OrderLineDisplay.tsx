import type { ReactNode } from "react";
import {
  getOrderLinePresentation,
  type OrderLineColourTone,
} from "./orderLinePresentation";

/**
 * F2 order-display: the visual body of one Production order line.
 * Presentation only - the parent <li> keeps click handling, state
 * styling and the Verify / Undo controls (passed in as `actions`).
 */
export interface OrderLineDisplayProps {
  title: string;
  sku: string;
  quantity: number;
  variantTitle: string | null;
  orientation: "portrait" | "landscape" | null;
  /** Line belongs to this station - full-strength title colour. */
  isMine: boolean;
  /** Type / department / set badges shown next to the title. */
  badges?: ReactNode;
  /** Verify button, Undo link or status text. */
  actions?: ReactNode;
}

// Large frame-colour block. Every tone carries a ring so white stays
// visible on light cards and black stays visible on dark cards.
const TONE_CLASS: Record<OrderLineColourTone, string> = {
  black: "bg-slate-950 text-white ring-2 ring-slate-950 dark:ring-slate-400",
  white: "bg-white text-slate-900 ring-2 ring-slate-400 dark:ring-slate-200",
  natural: "bg-amber-800 text-amber-50 ring-2 ring-amber-900 dark:ring-amber-500",
  unframed:
    "bg-slate-100 text-slate-700 ring-2 ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600",
  canvas:
    "bg-stone-300 text-stone-900 ring-2 ring-stone-400 dark:bg-stone-700 dark:text-stone-100 dark:ring-stone-500",
  unknown:
    "bg-slate-100 text-slate-600 ring-2 ring-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-600",
};

// Only real frame colours are announced as a frame colour; neutral
// blocks are announced as a style so they never imply a frame.
function colourBlockLabel(tone: OrderLineColourTone, colourLabel: string): string {
  switch (tone) {
    case "black":
    case "white":
    case "natural":
      return "Frame colour: " + colourLabel;
    case "unframed":
    case "canvas":
      return "Style: " + colourLabel;
    case "unknown":
      return "Style: Unknown";
  }
}

export function OrderLineDisplay({
  title,
  sku,
  quantity,
  variantTitle,
  orientation,
  isMine,
  badges,
  actions,
}: OrderLineDisplayProps) {
  const pres = getOrderLinePresentation(sku, variantTitle);
  return (
    <>
      <div className={
        "text-xl font-bold tabular-nums w-12 shrink-0 text-right " +
        (quantity > 1 ? "text-red-600 dark:text-red-400" : "text-slate-700 dark:text-slate-300")
      }>
        {"x" + quantity}
      </div>

      {/* Reserved for F3 artwork thumbnails. No image is loaded yet. */}
      <div
        role="img"
        aria-label="Artwork image coming soon"
        className="shrink-0 w-16 h-16 rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800/60 flex items-center justify-center text-center text-[9px] uppercase tracking-wide text-slate-400 dark:text-slate-500 select-none"
      >
        Artwork
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <div className={
            "text-lg sm:text-xl font-bold leading-snug break-words min-w-0 " +
            (isMine ? "text-slate-900 dark:text-slate-100" : "text-slate-500 dark:text-slate-400")
          }>
            {title || sku}
          </div>
          {badges}
        </div>
        <div className="mt-1 flex items-center gap-2 flex-wrap text-sm text-slate-700 dark:text-slate-200">
          {pres.sizeLabel ? (
            <span className="text-base font-bold">{pres.sizeLabel}</span>
          ) : null}
          {pres.styleLabel ? (
            <span className="font-semibold uppercase tracking-wide">{pres.styleLabel}</span>
          ) : null}
          {orientation ? (
            <span
              className={
                "inline-flex items-center gap-1.5 rounded-md text-[11px] font-bold uppercase tracking-wide px-2 py-0.5 ring-1 " +
                (orientation === "portrait"
                  ? "bg-blue-100 text-blue-900 ring-blue-400 dark:bg-blue-900/40 dark:text-blue-100 dark:ring-blue-600"
                  : "bg-orange-100 text-orange-900 ring-orange-400 dark:bg-orange-900/40 dark:text-orange-100 dark:ring-orange-600")
              }
              aria-label={orientation === "portrait" ? "Portrait orientation" : "Landscape orientation"}
            >
              <span
                className={
                  orientation === "portrait"
                    ? "inline-block w-1.5 h-2.5 bg-blue-800 dark:bg-blue-200 rounded-[1px]"
                    : "inline-block w-2.5 h-1.5 bg-orange-800 dark:bg-orange-200 rounded-[1px]"
                }
                aria-hidden="true"
              />
              {orientation === "portrait" ? "Portrait" : "Landscape"}
            </span>
          ) : null}
        </div>
        {pres.fallbackDescription ? (
          <div className="text-sm text-slate-600 dark:text-slate-300 mt-0.5 break-words">
            {pres.fallbackDescription}
          </div>
        ) : null}
        <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 break-all mt-0.5">
          {sku}
        </div>
      </div>

      <div
        aria-label={colourBlockLabel(pres.colourTone, pres.colourLabel)}
        className={
          "shrink-0 w-24 sm:w-28 min-h-[4rem] rounded-xl px-2 flex items-center justify-center text-center text-sm font-black uppercase tracking-wide leading-tight " +
          TONE_CLASS[pres.colourTone]
        }
      >
        {pres.colourLabel}
      </div>

      {actions}
    </>
  );
}
