import { cn } from "@/lib/utils/cn";
import { useIsRedesignedShell } from "./UiPresentation";

type Status = "OK" | "Reorder" | "Critical" | "OOS";

const STYLE: Record<Status, string> = {
  OK: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:ring-emerald-800",
  Reorder: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800",
  Critical: "bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:ring-orange-800",
  OOS: "bg-red-50 text-red-700 ring-red-200 dark:bg-red-900/30 dark:text-red-300 dark:ring-red-800",
};

// Redesigned shell tags (wf.css .tag.g / .tag.y / .tag.r). Critical keeps a
// distinct look from Reorder so the two states stay distinguishable.
const HUB_STYLE: Record<Status, string> = {
  OK: "bg-hub-accent-bg text-hub-accent-text",
  Reorder: "bg-hub-warn-bg text-hub-warn",
  Critical: "bg-hub-warn-bg text-hub-bad ring-1 ring-inset ring-hub-bad/40",
  OOS: "bg-hub-bad-bg text-hub-bad",
};

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  const redesigned = useIsRedesignedShell();
  return (
    <span
      className={cn(
        redesigned
          ? "inline-flex items-center rounded px-1.5 py-px text-[11px] font-semibold uppercase tracking-wide"
          : "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1",
        redesigned ? HUB_STYLE[status] : STYLE[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
