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
let savedMainOverflow = "";

/** Elements we made inert, with how many open overlays need them inert. */
const inertCounts = new Map<Element, number>();

/**
 * Make everything outside the overlay inert: the siblings of the overlay's
 * container and of each of its ancestors up to <body>. The overlay's own
 * scrim (a sibling of the panel inside the container) stays usable. Returns
 * the elements this call made inert, for release.
 */
/** Another modal overlay (opening above this one) isolates itself; never inert it from here. */
const isModalOverlay = (el: Element) =>
  el.matches('[role="dialog"][aria-modal="true"]') || el.querySelector('[role="dialog"][aria-modal="true"]') !== null;

function isolate(panel: HTMLElement): { els: Element[]; stop: () => void } {
  const mine: Element[] = [];
  const path = new Set<Element>();
  const parents: Element[] = [];
  const make = (sib: Element) => {
    if (path.has(sib) || mine.includes(sib)) return;
    const n = inertCounts.get(sib);
    if (n !== undefined) {
      inertCounts.set(sib, n + 1);
      mine.push(sib);
    } else if (!sib.hasAttribute("inert")) {
      sib.setAttribute("inert", "");
      inertCounts.set(sib, 1);
      mine.push(sib);
    }
  };
  let node: Element | null = panel.parentElement;
  while (node && node !== document.body && node.parentElement) {
    path.add(node);
    parents.push(node.parentElement);
    node = node.parentElement;
  }
  for (const parent of parents) {
    for (const sib of Array.from(parent.children)) make(sib);
  }
  // Keep isolation current for the whole open lifetime: anything mounted
  // later beside the overlay's path (e.g. an error banner) becomes inert too.
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof Element && !isModalOverlay(n)) make(n);
      });
    }
  });
  for (const parent of parents) mo.observe(parent, { childList: true });
  return { els: mine, stop: () => mo.disconnect() };
}

function release(els: Element[]) {
  for (const el of els) {
    const n = inertCounts.get(el);
    if (n === undefined) continue;
    if (n <= 1) {
      inertCounts.delete(el);
      el.removeAttribute("inert");
    } else {
      inertCounts.set(el, n - 1);
    }
  }
}

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

    // The shell scrolls in <main>, not <body>: lock both.
    const main = document.getElementById("main-content");
    if (scrollLocks === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      if (main) {
        savedMainOverflow = main.style.overflow;
        main.style.overflow = "hidden";
      }
    }
    scrollLocks += 1;

    const panel = panelRef.current;
    const isolation = panel ? isolate(panel) : null;
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

    // Focus moved outside by other means (script, assistive tech): bring it back.
    const onFocusIn = (e: FocusEvent) => {
      if (overlayStack[overlayStack.length - 1] !== id || !panelRef.current) return;
      const t = e.target as Node | null;
      if (t && !panelRef.current.contains(t)) {
        const first = focusables(panelRef.current)[0] ?? panelRef.current;
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", onFocusIn, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      isolation?.stop();
      if (isolation) release(isolation.els);
      const i = overlayStack.indexOf(id);
      if (i >= 0) overlayStack.splice(i, 1);
      scrollLocks -= 1;
      if (scrollLocks === 0) {
        document.body.style.overflow = savedOverflow;
        const m = document.getElementById("main-content");
        if (m) m.style.overflow = savedMainOverflow;
      }
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, panelRef, initialRef]);
}
