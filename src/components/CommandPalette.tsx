import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Package, CalendarDays, Truck, Building2 } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { cn } from "@/lib/utils/cn";
import { shortCode } from "@/lib/domain";
import { useOverlayBehavior } from "@/components/ui/UiPresentation";

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
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useCallback(() => setOpen(false), []);
  // Focus stays inside while open; focus returns to where it was on close.
  useOverlayBehavior(open, panelRef, close, { initialFocus: inputRef });

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
  const optionId = (i: number) => `${listId}-opt-${i}`;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[12vh] max-md:pt-3">
      <div aria-hidden="true" onClick={() => setOpen(false)} className="absolute inset-0 bg-hub-scrim" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="relative w-full max-w-[620px] overflow-hidden rounded-xl bg-hub-panel text-hub-text shadow-hub-pop"
      >
        <div className="flex h-12 items-center gap-2.5 border-b border-hub-line px-4">
          <Search size={16} className="shrink-0 text-hub-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={onInputKeyDown}
            placeholder="Search SKUs, events, shipments, suppliers…"
            role="combobox"
            aria-label="Search SKUs, events, shipments and suppliers"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hits.length > 0 && hits[cursor] ? optionId(cursor) : undefined}
            className="flex-1 bg-transparent text-[15px] text-hub-text placeholder:text-hub-faint focus:outline-none"
          />
          <kbd className="hidden rounded border border-hub-line-2 px-1.5 py-0.5 font-mono text-[10.5px] text-hub-muted sm:inline">esc</kbd>
        </div>
        <div className="max-h-96 overflow-y-auto max-md:max-h-[60vh]">
          {!query ? (
            <div className="p-6 text-center text-[13px] text-hub-muted">
              Type to search — arrow keys to navigate, enter to open.
            </div>
          ) : hits.length === 0 ? (
            <div className="p-6 text-center text-[13px] text-hub-muted" role="status">
              No matches for &quot;{query}&quot;.
            </div>
          ) : (
            <ul id={listId} role="listbox" aria-label="Results" className="py-1">
              {hits.map((h, i) => (
                <li
                  key={h.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === cursor}
                  onClick={() => choose(h)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-4 py-2",
                    i === cursor ? "bg-hub-fill" : "",
                  )}
                >
                  <TypeIcon type={h.type} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{h.label}</div>
                    <div className="truncate text-[11.5px] text-hub-muted">{h.sub}</div>
                  </div>
                  <span className="font-mono text-[10.5px] uppercase tracking-wide text-hub-faint">{h.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-hub-line px-4 py-2 text-[11.5px] text-hub-muted">
          <span>Tip: press <kbd className="rounded border border-hub-line-2 px-1 font-mono">/</kbd> anywhere to open this.</span>
          <span>↑↓ navigate · enter open · esc close</span>
        </div>
      </div>
    </div>
  );
}

function TypeIcon({ type }: { type: Hit["type"] }) {
  const cls = "shrink-0 text-hub-muted";
  if (type === "sku") return <Package size={14} className={cls} />;
  if (type === "event") return <CalendarDays size={14} className={cls} />;
  if (type === "shipment") return <Truck size={14} className={cls} />;
  return <Building2 size={14} className={cls} />;
}
