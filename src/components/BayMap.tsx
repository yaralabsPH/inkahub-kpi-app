import { useMemo, useState } from "react";
import type { Product, StorageLayout } from "@/lib/domain";
import { cn } from "@/lib/utils/cn";

const TYPE_STYLE: Record<string, string> = {
  floor: "bg-hub-fill text-hub-muted",
  rack: "bg-hub-info-bg text-hub-info",
  cold: "bg-hub-accent-bg text-hub-accent-text",
};

/**
 * Read-only bay layout (wireframe warehouse.html): bays placed by their saved
 * row/column, with type and max pallets, and the pallet assignments already
 * saved against each bay. Selecting a bay only reveals its assignments. No
 * writes, no allocation, no inferred occupancy.
 */
export function BayMap({ storage, products }: { storage: StorageLayout; products: readonly Product[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const byBay = useMemo(() => {
    const m = new Map<string, StorageLayout["palletAssignments"]>();
    for (const a of storage.palletAssignments) {
      const list = m.get(a.bay_id) ?? [];
      list.push(a);
      m.set(a.bay_id, list);
    }
    return m;
  }, [storage.palletAssignments]);
  const codeOf = (id: string) => products.find((p) => p.id === id)?.code ?? id;

  const bays = storage.bays;
  if (bays.length === 0) return null;
  const rows = Math.max(...bays.map((b) => b.row)) + 1;
  const cols = Math.max(...bays.map((b) => b.column)) + 1;
  const sel = bays.find((b) => b.id === selected) ?? null;
  const selAssignments = sel ? byBay.get(sel.id) ?? [] : [];

  return (
    <section aria-labelledby="bay-map-title" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bay-map-title" className="text-lg font-semibold text-hub-text">Bay layout</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs text-hub-muted" aria-label="Bay types">
          {(["floor", "rack", "cold"] as const).map((t) => (
            <span key={t} className={cn("rounded px-1.5 py-px capitalize", TYPE_STYLE[t])}>{t}</span>
          ))}
          <span>· numbers are saved pallet assignments / max pallets</span>
        </div>
      </div>
      <p className="text-xs text-hub-muted">
        Read-only. The headline fullness above is calculated from stock on hand; saved bay assignments can differ from it.
      </p>
      <div className="overflow-x-auto rounded-hub border border-hub-line bg-hub-panel p-3">
        <div
          className="grid gap-1.5"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(64px, 1fr))`, gridTemplateRows: `repeat(${rows}, auto)` }}
        >
          {bays.map((b) => {
            const n = byBay.get(b.id)?.length ?? 0;
            const isSel = b.id === selected;
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelected(isSel ? null : b.id)}
                aria-pressed={isSel}
                aria-label={`Bay ${b.label}, ${b.type}, ${n} of ${b.max_pallets} pallets assigned`}
                style={{ gridRow: b.row + 1, gridColumn: b.column + 1 }}
                className={cn(
                  "flex min-h-[52px] flex-col items-start justify-between rounded-[5px] border px-1.5 py-1 text-left text-[11.5px]",
                  isSel ? "border-hub-accent ring-1 ring-hub-accent" : "border-hub-line hover:border-hub-line-2",
                  TYPE_STYLE[b.type] ?? TYPE_STYLE.floor,
                )}
              >
                <span className="truncate font-medium text-hub-text">{b.label}</span>
                <span className="tabular-nums">{n}/{b.max_pallets}</span>
              </button>
            );
          })}
        </div>
      </div>
      {sel ? (
        <div className="rounded-hub border border-hub-line bg-hub-panel p-3 text-[13px]" aria-live="polite">
          <div className="font-medium text-hub-text">
            Bay {sel.label} <span className="font-normal text-hub-muted">· {sel.type} · max {sel.max_pallets} pallets</span>
          </div>
          {selAssignments.length === 0 ? (
            <p className="mt-1 text-hub-muted">No pallets saved against this bay.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {selAssignments.map((a) => (
                <li key={a.id} className="font-mono text-[12.5px]">
                  slot {a.slot_index + 1}: {codeOf(a.product_id)} × {a.quantity}
                </li>
              ))}
            </ul>
          )}
          {sel.notes ? <p className="mt-1 text-xs text-hub-muted">{sel.notes}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
