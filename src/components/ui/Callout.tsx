import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Grey callout with an info icon. Use <b> for the lead-in and <code> for
 * inline codes / filenames; both are styled here.
 */
export function Callout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-hub bg-hub-fill px-3.5 py-3 text-[13px] leading-[1.55] text-hub-muted",
        "[&_b]:font-semibold [&_b]:text-hub-text",
        "[&_code]:rounded [&_code]:bg-hub-fill-2 [&_code]:px-[5px] [&_code]:font-mono [&_code]:text-xs [&_code]:text-hub-text",
        className,
      )}
    >
      <Info size={16} strokeWidth={1.6} className="mt-0.5 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
