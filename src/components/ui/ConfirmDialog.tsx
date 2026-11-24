import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/**
 * Promise-based confirm step for an EXISTING action. `ask()` resolves true on
 * confirm and false on cancel/Escape/backdrop; the caller then runs (or does
 * not run) its original handler exactly once. Render `dialog` once.
 */
export function useConfirm(): { ask: (o: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    setOpts(null);
    r?.(ok);
  }, []);

  const ask = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false); // a newer question cancels an unanswered one
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  const cancel = useCallback(() => settle(false), [settle]);

  const dialog = (
    <Modal open={opts !== null} onClose={cancel} title={opts?.title ?? ""} width="max-w-md">
      {opts ? (
        <div className="space-y-4 text-[13.5px]">
          <div className="text-hub-text">{opts.body}</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <Button variant={opts.danger ? "danger" : "primary"} onClick={() => settle(true)}>
              {opts.confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );

  return { ask, dialog };
}
