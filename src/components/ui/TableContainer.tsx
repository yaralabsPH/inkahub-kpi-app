import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Bordered, horizontally scrollable wrapper for a native table (wf.css
 * .grid). Give it an aria-label when the table is wider than the screen so
 * keyboard users can focus and scroll it. Table semantics stay with callers.
 */
export function TableContainer({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const label = rest["aria-label"] ?? rest["aria-labelledby"];
  return (
    <div
      role={label ? "region" : undefined}
      tabIndex={label ? 0 : undefined}
      className={cn("hub-table overflow-auto rounded-hub border border-hub-line bg-hub-panel", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
