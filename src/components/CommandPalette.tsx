import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Package, CalendarDays, Truck, Building2 } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { cn } from "@/lib/utils/cn";
import { shortCode } from "@/lib/domain";

/**
 * Universal "/" or "Ctrl+K" search palette. Indexes products, demand
 * events, shipments, and suppliers; navigates to the relevant page on
 * select. Keyboard-driven: arrows + enter, escape to close.
 */

interface Hit {
  id: string;
  label: string;
  sub: string;
  href: string;
  type: "sku" | "event" | "shipment" | "supplier";
}

export function CommandPalette() {
  const { data } = useDataset();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global hotkeys: "/" or Cmd/Ctrl+K opens; Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
        target?.isContentEditable;
      if ((e.key === "/" && !inField) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Reset cursor + focus when opening.
  useEffect(() => {
    if (!open) return;
    setCursor(0);
    setQuery("");
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: Hit[] = [];
    for (const p of data.products) {
      const hay = `${p.code} ${shortCode(p)} ${p.size} ${p.colour} ${p.supplier} ${p.notes ?? ""}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({
          id: `sku-${p.id}`,
          label: p.code,
          sub: `${p.size} · ${p.colour} · ${p.supplier}`,
          href: `/skus/${p.id}`,
          type: "sku",
        });
      }
    }
    for (const e of data.events) {
      if (e.name.toLowerCase().includes(q)) {
        out.push({
          id: `event-${e.id}`,
          label: e.name,
          sub: `${e.start_date} → ${e.end_date} · ×${e.multiplier}`,
          href: "/events",
          type: "event",
        });
      }
    }
    for (const s of data.shipments) {
      const hay = `${s.po_number} ${s.supplier} ${s.notes}`.toLowerCase();
      if (hay.includes(q)) {
        out.push({
          id: `ship-${s.id}`,
          label: s.po_number,
          sub: `${s.supplier} · ${s.status} · arrives ${s.expected_arrival_date}`,
          href: "/shipments",
          type: "shipment",
        });
      }
    }
    const suppliers = Array.from(new Set(data.products.map((p) => p.supplier)));
    for (const sup of suppliers) {
      if (sup.toLowerCase().includes(q)) {
        const count = data.products.filter((p) => p.supplier === sup).length;
        out.push({
          id: `supplier-${sup}`,
          label: sup,
          sub: `${count} SKU${count === 1 ? "" : "s"}`,
          href: "/skus",
          type: "supplier",
        });
      }
    }
    return out.slice(0, 30);
  }, [data, query]);

  // Clamp cursor when results shrink.
  useEffect(() => {
    if (cursor >= hits.length) setCursor(0);
  }, [hits.length, cursor]);

  const choose = (h: Hit) => {
    navigate(h.href);
    setOpen(false);
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const h = hits[cursor]; if (h) choose(h); }
  };

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Search"
      onClick={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 dark:bg-black/60 backdrop-blur-sm pt-24 px-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-xl ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-slate-200 dark:border-slate-800">
          <Search size={16} className="text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={onInputKeyDown}
            placeholder="Search SKUs, events, shipments, suppliers…"
            className="flex-1 bg-transparent text-sm focus:outline-none"
          />
          <kbd className="hidden sm:inline rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {!query ? (
            <div className="p-6 text-center text-sm text-slate-500">
              Type to search — arrow keys to navigate, enter to open.
            </div>
          ) : hits.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-500">
              No matches for &quot;{query}&quot;.
            </div>
          ) : (
            <ul className="py-1">
              {hits.map((h, i) => (
                <li
                  key={h.id}
                  onClick={() => choose(h)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn(
                    "px-3 py-2 flex items-center gap-3 cursor-pointer",
                    i === cursor ? "bg-slate-100 dark:bg-slate-800" : "",
                  )}
                >
                  <TypeIcon type={h.type} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{h.label}</div>
                    <div className="text-[11px] text-slate-500 truncate">{h.sub}</div>
                  </div>
                  <span className="text-[10px] uppercase text-slate-400 tracking-wide">{h.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 flex items-center justify-between">
          <span>Tip: press <kbd className="rounded border border-slate-300 dark:border-slate-700 px-1">/</kbd> anywhere to open this.</span>
          <span>↑↓ navigate · enter open</span>
        </div>
      </div>
    </div>
  );
}

function TypeIcon({ type }: { type: Hit["type"] }) {
  const cls = "text-slate-400";
  if (type === "sku") return <Package size={14} className={cls} />;
  if (type === "event") return <CalendarDays size={14} className={cls} />;
  if (type === "shipment") return <Truck size={14} className={cls} />;
  return <Building2 size={14} className={cls} />;
}
