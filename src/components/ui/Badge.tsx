import { type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-hub-fill text-hub-muted",
  success: "bg-hub-accent-bg text-hub-accent-text",
  warning: "bg-hub-warn-bg text-hub-warn",
  danger: "bg-hub-bad-bg text-hub-bad",
  info: "bg-hub-info-bg text-hub-info",
};

/** Small tag (wf.css .tag). Presentation only: callers pass display text. */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-xs", TONE[tone])}>
      {children}
    </span>
  );
}
