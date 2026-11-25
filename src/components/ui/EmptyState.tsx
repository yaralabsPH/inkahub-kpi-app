import type { LucideIcon } from "lucide-react";

/** Dashed, left-aligned empty state for a section: icon tile, bold line, hint. */
export function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3 rounded-hub-card border border-dashed border-hub-line-2 px-[18px] py-[22px] text-[13.5px] text-hub-faint">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-hub-card bg-hub-fill">
        <Icon size={16} strokeWidth={1.6} aria-hidden />
      </div>
      <div>
        <b className="block font-medium text-hub-muted">{title}</b>
        {hint}
      </div>
    </div>
  );
}
