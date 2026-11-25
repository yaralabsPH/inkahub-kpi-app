import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useOverlayBehavior } from "./UiPresentation";

/**
 * Read-only side panel (wf.css .peek): 460px on the right on desktop,
 * full-screen below 768px. It owns no data and no save action.
 */
export function SideSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useOverlayBehavior(open, panelRef, onClose);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-hub-scrim md:bg-transparent" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="absolute inset-0 flex flex-col overflow-hidden border-hub-line bg-hub-panel text-hub-text shadow-hub-peek md:inset-y-0 md:left-auto md:right-0 md:w-[460px] md:border-l"
      >
        <div className="flex items-center gap-2 border-b border-hub-line px-5 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[15px] font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="inline-grid h-8 w-8 place-items-center rounded-hub text-hub-muted hover:bg-hub-fill hover:text-hub-text"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
