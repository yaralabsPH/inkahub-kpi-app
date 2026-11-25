import { cn } from "@/lib/utils/cn";

/** Small segmented control (Totals / Per day, 7 days / 12 weeks…). */
export function Segmented<T extends string>({
  value, options, onChange, label, className,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  /** Accessible group name. */
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex rounded-[7px] bg-hub-fill p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "whitespace-nowrap rounded-[5px] px-[9px] py-0.5 text-[12.5px] font-medium",
            o.value === value
              ? "bg-hub-panel text-hub-text shadow-[0_0_0_1px_rgb(var(--hub-line-2))]"
              : "text-hub-muted hover:text-hub-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
