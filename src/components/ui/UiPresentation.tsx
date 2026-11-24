import { createContext, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * Presentation scope for the redesigned shell. Only Layout's shell wraps its
 * children in this provider, so shared primitives can opt into the new look
 * and dialog behaviour there while keeping their legacy appearance and
 * behaviour everywhere else (notably the standalone /production station).
 * Never used for data or permissions.
 */
const RedesignContext = createContext(false);

export function UiPresentationProvider({ children }: { children: ReactNode }) {
  return <RedesignContext.Provider value={true}>{children}</RedesignContext.Provider>;
}

export function useIsRedesignedShell(): boolean {
  return useContext(RedesignContext);
}

// ---------------------------------------------------------------------------
// Overlay behaviour for opt-in shell dialogs, drawers and sheets.
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Open overlays, newest last. Only the topmost one reacts to Escape/Tab. */
const overlayStack: symbol[] = [];
let scrollLocks = 0;
let savedOverflow = "";

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.offsetParent !== null,
  );
}

/**
 * While `open`: moves focus into `panelRef` (first focusable, else the panel),
 * keeps Tab inside it, closes on Escape when it is the topmost overlay, locks
 * page scroll, and returns focus to the previously focused element on close.
 */
export function useOverlayBehavior(
  open: boolean,
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
  options: { initialFocus?: RefObject<HTMLElement> } = {},
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialRef = options.initialFocus;

  useEffect(() => {
    if (!open) return;
    const id = Symbol("overlay");
    overlayStack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLocks += 1;

    const panel = panelRef.current;
    const focusFirst = () => {
      const target = initialRef?.current ?? (panel ? focusables(panel)[0] ?? panel : null);
      target?.focus({ preventScroll: true });
    };
    // After paint, so conditionally rendered content exists.
    const raf = requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (overlayStack[overlayStack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = focusables(panelRef.current);
      if (items.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      const i = overlayStack.indexOf(id);
      if (i >= 0) overlayStack.splice(i, 1);
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, panelRef, initialRef]);
}
