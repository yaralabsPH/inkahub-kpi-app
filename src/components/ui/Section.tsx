import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";

function readOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw === "0") return false;
    if (raw === "1") return true;
  } catch { /* storage unavailable */ }
  return fallback;
}

/**
 * Toggle heading section. The toggle hangs in the left margin (from md up),
 * the title also toggles, and the open/closed state is remembered in
 * localStorage under `storageKey` when one is given. No card chrome: the
 * content sits on the page background. `data-report-section` lets the
 * Reports "On this page" bar list it.
 */
export function Section({
  title, navLabel, meta, subtitle, actions, storageKey, defaultOpen = true, className, children,
}: {
  title: ReactNode;
  /** Label for the Reports section bar; defaults to `title` when it is text. */
  navLabel?: string;
  meta?: ReactNode;
  subtitle?: ReactNode;
  /** Right-side controls (segmented controls, Refresh, snapshot label). */
  actions?: ReactNode;
  storageKey?: string;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen));
  const bodyId = useId();
  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (storageKey) {
        try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      }
      return next;
    });
  };
  const label = navLabel ?? (typeof title === "string" ? title : undefined);
  return (
    <section data-report-section={label} className={cn("mt-[30px]", className)}>
      <div className="flex select-none flex-wrap items-center gap-1.5 md:-ml-[26px]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={open ? "Collapse section" : "Expand section"}
          className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded text-hub-muted hover:bg-hub-fill"
        >
          <ChevronDown
            size={14}
            strokeWidth={1.8}
            className={cn("transition-transform duration-150", open ? "" : "-rotate-90")}
          />
        </button>
        <h2 onClick={toggle} className="cursor-pointer text-lg font-semibold tracking-[-0.01em] text-hub-text">
          {title}
        </h2>
        {meta ? <span className="ml-2 text-[12.5px] text-hub-faint">{meta}</span> : null}
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div> : null}
      </div>
      {open && subtitle ? <div className="mt-0.5 text-[13px] text-hub-muted">{subtitle}</div> : null}
      <div id={bodyId} hidden={!open} className="mt-3">
        {open ? children : null}
      </div>
    </section>
  );
}
