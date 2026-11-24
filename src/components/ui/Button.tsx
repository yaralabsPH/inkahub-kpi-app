import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { useIsRedesignedShell } from "./UiPresentation";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white",
  secondary:
    "bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700 dark:hover:bg-slate-800",
  ghost:
    "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
  danger:
    "bg-red-600 text-white hover:bg-red-700",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-2.5 text-xs gap-1",
  md: "h-9 px-3 text-sm gap-1.5",
  lg: "h-10 px-4 text-base gap-2",
};

// Redesigned shell look (wf.css .btn / .btn.pri / .btn.ghost).
const HUB_VARIANT: Record<Variant, string> = {
  primary:
    "bg-hub-accent text-[#0d2b1d] font-semibold border border-[#157a53] hover:brightness-95",
  secondary:
    "bg-hub-panel text-hub-text border border-hub-line-2 hover:bg-hub-hover",
  ghost:
    "border border-transparent bg-transparent text-hub-muted hover:bg-hub-fill hover:text-hub-text",
  danger:
    "bg-hub-panel text-hub-bad border border-hub-bad hover:bg-hub-bad-bg",
};

const HUB_SIZE: Record<Size, string> = {
  sm: "h-7 px-2 text-xs gap-1",
  md: "h-8 px-2.5 text-[13px] gap-1.5",
  lg: "h-9 px-3.5 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const redesigned = useIsRedesignedShell();
  return (
    <button
      type={type}
      className={cn(
        redesigned
          ? "inline-flex items-center justify-center whitespace-nowrap rounded-hub font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none"
          : "inline-flex items-center justify-center rounded-md font-medium transition disabled:opacity-50 disabled:pointer-events-none",
        redesigned ? HUB_VARIANT[variant] : VARIANT[variant],
        redesigned ? HUB_SIZE[size] : SIZE[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
