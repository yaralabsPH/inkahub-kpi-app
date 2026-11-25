import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * Minimal bottom-centre toast. The app had no toast system; this is local
 * state, no dependency. Usage: const { toast, toastNode } = useToast();
 * render {toastNode} once, call toast("Saved").
 */
export function useToast(): { toast: (msg: string) => void; toastNode: ReactNode } {
  const [msg, setMsg] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const toast = useCallback((m: string) => {
    setMsg(m);
    setShow(true);
    clearTimeout(timer.current);
    // Long messages (e.g. print instructions) stay up longer.
    timer.current = setTimeout(() => setShow(false), m.length > 60 ? 5000 : 1800);
  }, []);

  const toastNode = (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed bottom-[22px] left-1/2 z-50 max-w-[min(520px,90vw)] -translate-x-1/2 rounded-lg bg-hub-panel px-3.5 py-2 text-[13px] text-hub-text shadow-hub-pop transition-all duration-200",
        show ? "translate-y-0 opacity-100" : "translate-y-5 opacity-0",
      )}
    >
      {msg}
    </div>
  );
  return { toast, toastNode };
}
