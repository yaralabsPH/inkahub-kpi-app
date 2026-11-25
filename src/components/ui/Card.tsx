import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { useIsRedesignedShell } from "./UiPresentation";

export function Card({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const redesigned = useIsRedesignedShell();
  return (
    <div
      className={cn(
        redesigned
          ? "rounded-hub-card border border-hub-line bg-hub-panel"
          : "rounded-xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900/60 shadow-sm",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const redesigned = useIsRedesignedShell();
  return (
    <div
      className={cn(
        redesigned
          ? "flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 border-b border-hub-line"
          : "flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 border-b border-slate-100 dark:border-slate-800",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  const redesigned = useIsRedesignedShell();
  return (
    <h2
      className={cn(
        redesigned
          ? "text-[13.5px] font-semibold text-hub-text"
          : "text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100",
        className,
      )}
    >
      {children}
    </h2>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("p-4", className)} {...rest}>
      {children}
    </div>
  );
}
