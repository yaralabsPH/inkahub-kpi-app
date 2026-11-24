import { cn } from "@/lib/utils/cn";
import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { useIsRedesignedShell } from "./UiPresentation";

const baseInput =
  "h-9 rounded-md border border-slate-300 bg-white px-3 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-slate-500 dark:focus:ring-slate-700 disabled:bg-slate-50 dark:disabled:bg-slate-800";

// Redesigned shell field (wf.css .field / .input).
const hubInput =
  "h-8 rounded-hub border border-hub-line-2 bg-hub-panel px-2.5 text-[13px] text-hub-text placeholder:text-hub-faint focus:border-hub-accent focus:outline-none focus:ring-2 focus:ring-hub-accent/30 disabled:bg-hub-sub disabled:text-hub-faint";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  const redesigned = useIsRedesignedShell();
  return <input ref={ref} className={cn(redesigned ? hubInput : baseInput, "w-full", className)} {...rest} />;
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  const redesigned = useIsRedesignedShell();
  return (
    <select ref={ref} className={cn(redesigned ? hubInput : baseInput, "w-full", className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  const redesigned = useIsRedesignedShell();
  return (
    <label className="block">
      <span
        className={
          redesigned
            ? "text-[12.5px] font-medium text-hub-text"
            : "text-xs font-medium text-slate-700 dark:text-slate-300"
        }
      >
        {label}
      </span>
      <div className="mt-1">{children}</div>
      {error ? (
        <span
          className={redesigned ? "mt-1 block text-xs text-hub-bad" : "mt-1 block text-xs text-red-600 dark:text-red-400"}
          role={redesigned ? "alert" : undefined}
        >
          {error}
        </span>
      ) : hint ? (
        <span
          className={redesigned ? "mt-1 block text-xs text-hub-muted" : "mt-1 block text-xs text-slate-500 dark:text-slate-400"}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}
