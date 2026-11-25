import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

/** Clamp a page index into range for `total` rows at `size` per page. */
export function clampPage(page: number, total: number, size: number): number {
  const last = Math.max(0, Math.ceil(total / size) - 1);
  return Math.min(Math.max(0, page), last);
}

/**
 * In-page pagination footer: "Rows per page" select, "1–10 of 791",
 * and ‹ › buttons. The caller slices its rows with `page * size`.
 */
export function Pager({
  total, page, size, onPage, onSize, label = "rows", className,
}: {
  total: number;
  page: number;
  size: PageSize;
  onPage: (page: number) => void;
  onSize: (size: PageSize) => void;
  /** Noun for the range text, e.g. "orders". */
  label?: string;
  className?: string;
}) {
  const p = clampPage(page, total, size);
  const lastPage = Math.max(0, Math.ceil(total / size) - 1);
  const from = total === 0 ? 0 : p * size + 1;
  const to = Math.min(total, (p + 1) * size);
  const btn =
    "grid h-7 w-7 place-items-center rounded-hub text-hub-muted hover:bg-hub-fill hover:text-hub-text disabled:pointer-events-none disabled:opacity-35";
  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-x-4 gap-y-2 pt-2.5 text-[12.5px] text-hub-muted", className)}>
      <label className="flex items-center gap-2">
        Rows per page
        <select
          value={size}
          onChange={(e) => onSize(Number(e.target.value) as PageSize)}
          className="h-7 cursor-pointer rounded-hub border border-hub-line-2 bg-hub-panel px-1.5 text-[12.5px] text-hub-text hover:bg-hub-hover"
        >
          {PAGE_SIZE_OPTIONS.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </label>
      <span className="tabular-nums" aria-live="polite">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {label}
      </span>
      <div className="flex items-center gap-0.5">
        <button type="button" className={btn} onClick={() => onPage(p - 1)} disabled={p === 0} aria-label="Previous page">
          <ChevronLeft size={16} strokeWidth={1.8} />
        </button>
        <button type="button" className={btn} onClick={() => onPage(p + 1)} disabled={p >= lastPage} aria-label="Next page">
          <ChevronRight size={16} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
