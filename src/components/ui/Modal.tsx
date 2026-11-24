import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useIsRedesignedShell, useOverlayBehavior } from "./UiPresentation";

/** Tiny accessible modal — focus-trap-light, ESC closes, click backdrop closes. */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  // Inside the redesigned shell the modal gets the new look and full focus
  // handling. Everywhere else (the /production station) it is unchanged.
  const redesigned = useIsRedesignedShell();
  return redesigned ? <ShellModal {...props} /> : <LegacyModal {...props} />;
}

function LegacyModal({
  open,
  onClose,
  title,
  children,
  width = "max-w-2xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-sm"
        tabIndex={-1}
      />
      <div
        className={cn(
          "relative w-full rounded-xl bg-white dark:bg-slate-900 ring-1 ring-slate-200 dark:ring-slate-800 shadow-xl overflow-hidden",
          width,
        )}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-5 max-h-[70vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function ShellModal({
  open,
  onClose,
  title,
  children,
  width = "max-w-2xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlayBehavior(open, panelRef, onClose);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center md:items-center md:p-4">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-hub-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "relative flex w-full flex-col overflow-hidden bg-hub-panel text-hub-text shadow-hub-pop md:rounded-[10px] md:border md:border-hub-line",
          "max-md:h-full max-md:max-w-none",
          width,
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-hub-line px-5 py-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-hub-text">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-grid h-8 w-8 place-items-center rounded-hub text-hub-muted hover:bg-hub-fill hover:text-hub-text"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 md:max-h-[70vh]">{children}</div>
      </div>
    </div>
  );
}
