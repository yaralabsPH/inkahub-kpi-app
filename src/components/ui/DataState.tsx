import { type ReactNode } from "react";
import { AlertOctagon, Inbox } from "lucide-react";

/**
 * Loading / empty / error block for a page's main data. Presentation only:
 * it never fetches or retries. `action` is supplied by the caller and must be
 * an existing read refresh or an existing permitted navigation.
 * The loading skeleton shows bars only, never invented values.
 */
export function DataState({
  kind,
  title,
  message,
  action,
}: {
  kind: "loading" | "empty" | "error";
  title: string;
  message?: ReactNode;
  action?: ReactNode;
}) {
  if (kind === "loading") {
    return (
      <div role="status" aria-live="polite" className="rounded-hub-card border border-hub-line bg-hub-panel p-3">
        <span className="sr-only">{title}</span>
        <div aria-hidden="true" className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="grid grid-cols-5 gap-3">
              {[0, 1, 2, 3, 4].map((j) => (
                <div key={j} className="h-3.5 animate-pulse rounded bg-hub-fill" />
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div role="alert" className="flex flex-wrap items-start gap-3 rounded-hub border border-transparent bg-hub-bad-bg px-4 py-3 text-[13.5px]">
        <AlertOctagon size={16} className="mt-0.5 shrink-0 text-hub-bad" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-hub-text">{title}</div>
          {message ? <div className="text-hub-muted">{message}</div> : null}
        </div>
        {action ? <div className="self-center">{action}</div> : null}
      </div>
    );
  }
  return (
    <div className="rounded-hub-card border border-dashed border-hub-line-2 px-6 py-7 text-center text-hub-muted">
      <Inbox size={28} strokeWidth={1.5} className="mx-auto text-hub-faint" aria-hidden="true" />
      <div className="mt-2 font-semibold text-hub-text">{title}</div>
      {message ? <div className="mt-1 text-xs">{message}</div> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}
