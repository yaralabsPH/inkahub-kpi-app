import { type ReactNode } from "react";

/**
 * Page title block (wf.css h1.t + .sub). Actions sit to the right on wide
 * screens and wrap underneath on narrow ones.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.01em] text-hub-text md:text-[32px]">
          {title}
        </h1>
        {description ? <div className="mt-1 text-sm text-hub-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
