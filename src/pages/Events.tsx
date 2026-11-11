import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Input";
import {
  type DemandChangeEvent,
  DemandChangeEventSchema,
} from "@/lib/domain";
import { addDays, diffDays, parseIsoDate, todayIso } from "@/lib/utils/dates";
import { fmtShortDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function Events() {
  const { data } = useDataset();
  const m = useMutations();
  const [editing, setEditing] = useState<DemandChangeEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [year, setYear] = useState(() => Number(todayIso().slice(0, 4)));

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  // Each event becomes a band that spans calendar cells.
  const eventsThisYear = data.events.filter((e) => {
    const ys = Number(e.start_date.slice(0, 4));
    const ye = Number(e.end_date.slice(0, 4));
    return ys <= year && ye >= year;
  });

  // Sort the All-events list with the soonest event closest to today at the
  // top. Events that are happening *right now* (today inside the range) get
  // distance 0; otherwise we use the absolute day-distance to whichever
  // edge of the range is nearest.
  const today = todayIso();
  const sortedEvents = [...data.events].sort(
    (a, b) => distanceFromToday(a, today) - distanceFromToday(b, today),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Demand events</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Schedule promos, closures, and seasons. Multipliers compound when events overlap on the same SKU.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setYear(year - 1)}>
            ←
          </Button>
          <span className="font-semibold tabular-nums text-sm w-12 text-center">{year}</span>
          <Button variant="ghost" size="sm" onClick={() => setYear(year + 1)}>
            →
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New event
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Year view</CardTitle>
          <span className="text-xs text-slate-500">
            Green bands = boost (×&gt;1) · Red bands = dip (×&lt;1)
          </span>
        </CardHeader>
        <CardBody>
          <YearStrip year={year} events={eventsThisYear} onClick={setEditing} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All events</CardTitle>
          <span className="text-xs text-slate-500">{data.events.length} total</span>
        </CardHeader>
        <CardBody className="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {sortedEvents.length === 0 ? (
              <li className="p-5 text-sm text-slate-500">No events yet.</li>
            ) : null}
            {sortedEvents.map((e) => (
              <li
                key={e.id}
                className="px-5 py-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-900/40 cursor-pointer"
                onClick={() => setEditing(e)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{e.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    {fmtShortDate(e.start_date)} → {fmtShortDate(e.end_date)} ·{" "}
                    {e.product_id === "*"
                      ? `all SKUs${e.apply_to_size ? ` (size ${e.apply_to_size})` : ""}${e.apply_to_colour ? ` (${e.apply_to_colour})` : ""}`
                      : data.products.find((p) => p.id === e.product_id)?.code ?? e.product_id}
                  </div>
                </div>
                <span className={e.multiplier >= 1 ? "pill-reorder tabular-nums" : "pill-critical tabular-nums"}>
                  ×{e.multiplier}
                </span>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <EventFormModal
        open={creating || !!editing}
        event={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={async (e) => {
          await m.upsertEvent.mutateAsync(e);
          setCreating(false);
          setEditing(null);
        }}
        onDelete={
          editing
            ? async () => {
                if (!window.confirm(`Delete "${editing.name}"?`)) return;
                await m.deleteEvent.mutateAsync(editing.id);
                setEditing(null);
              }
            : undefined
        }
      />
    </div>
  );
}

function YearStrip({
  year,
  events,
  onClick,
}: {
  year: number;
  events: DemandChangeEvent[];
  onClick: (e: DemandChangeEvent) => void;
}) {
  // Compute days-in-year for column scaling.
  const yearStart = `${year}-01-01`;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const totalDays = isLeap ? 366 : 365;

  // Each event's [startCol, endCol] within this year, percentage based.
  const bands = events.map((e) => {
    const a = e.start_date < yearStart ? yearStart : e.start_date;
    const b = e.end_date > `${year}-12-31` ? `${year}-12-31` : e.end_date;
    const left = (dayOfYear(a) - 1) / totalDays;
    const right = dayOfYear(b) / totalDays;
    return { e, leftPct: left * 100, widthPct: Math.max((right - left) * 100, 0.5) };
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-12 gap-1">
        {MONTHS.map((m, i) => (
          <div key={m} className="text-[11px] uppercase tracking-wide text-slate-500 text-center">
            {m}
            <div className="text-[10px] text-slate-400 tabular-nums">
              {monthDays(year, i)}
            </div>
          </div>
        ))}
      </div>
      <div className="relative h-24 rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
        {/* Month grid background */}
        <div className="absolute inset-0 grid grid-cols-12 pointer-events-none">
          {MONTHS.map((m, i) => (
            <div
              key={m}
              className={cn(
                "h-full border-r border-slate-100 dark:border-slate-800",
                i === 11 && "border-r-0",
              )}
            />
          ))}
        </div>
        {/* Today marker */}
        {Number(todayIso().slice(0, 4)) === year ? (
          <div
            className="absolute top-0 bottom-0 w-px bg-slate-500 dark:bg-slate-400 z-10"
            style={{ left: `${(dayOfYear(todayIso()) / totalDays) * 100}%` }}
            title="Today"
          />
        ) : null}
        {/* Event bands */}
        <div className="absolute inset-2 space-y-1">
          {bands.length === 0 ? (
            <div className="text-[11px] text-slate-400 italic">No events scheduled this year</div>
          ) : (
            bands.map(({ e, leftPct, widthPct }, i) => (
              <button
                key={e.id}
                onClick={() => onClick(e)}
                className={cn(
                  "absolute h-5 rounded text-[10px] px-1.5 truncate text-left ring-1",
                  e.multiplier >= 1
                    ? "bg-emerald-100 text-emerald-800 ring-emerald-300 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-800"
                    : "bg-red-100 text-red-800 ring-red-300 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-200 dark:ring-red-800",
                )}
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  top: `${(i % 4) * 22}px`,
                }}
                title={`${e.name} · ×${e.multiplier} · ${fmtShortDate(e.start_date)} → ${fmtShortDate(e.end_date)}`}
              >
                {e.name} ×{e.multiplier}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function EventFormModal({
  open,
  event,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  event: DemandChangeEvent | null;
  onClose: () => void;
  onSave: (e: DemandChangeEvent) => Promise<void>;
  onDelete?: () => void;
}) {
  const { data } = useDataset();
  const today = todayIso();
  const [form, setForm] = useState<Partial<DemandChangeEvent>>({});
  const [scope, setScope] = useState<"all" | "size" | "colour" | "sku">("all");
  const [error, setError] = useState<string | null>(null);

  const sizes = useMemo(() => uniq((data?.products ?? []).map((p) => p.size)), [data]);
  const colours = useMemo(() => uniq((data?.products ?? []).map((p) => p.colour)), [data]);

  useEffect(() => {
    if (event) {
      setForm(event);
      if (event.product_id === "*" && event.apply_to_size) setScope("size");
      else if (event.product_id === "*" && event.apply_to_colour) setScope("colour");
      else if (event.product_id === "*") setScope("all");
      else setScope("sku");
    } else {
      setForm({
        id: `evt-${Math.random().toString(36).slice(2, 8)}`,
        product_id: "*",
        name: "",
        start_date: today,
        end_date: addDays(today, 7),
        multiplier: 1.5,
        notes: "",
        apply_to_size: null,
        apply_to_colour: null,
      });
      setScope("all");
    }
  }, [event, open, today]);

  if (!data) return null;
  const set = (k: keyof DemandChangeEvent, v: unknown) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open={open} onClose={onClose} title={event ? `Edit ${event.name}` : "New event"}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            // Apply scope to the form before validating.
            const candidate: DemandChangeEvent = {
              id: form.id ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
              name: form.name ?? "",
              start_date: form.start_date ?? today,
              end_date: form.end_date ?? today,
              multiplier: form.multiplier ?? 1,
              notes: form.notes ?? "",
              product_id: scope === "sku" ? (form.product_id ?? "") : "*",
              apply_to_size: scope === "size" ? (form.apply_to_size ?? null) : null,
              apply_to_colour: scope === "colour" ? (form.apply_to_colour ?? null) : null,
            };
            const parsed = DemandChangeEventSchema.parse(candidate);
            await onSave(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
        className="grid grid-cols-2 gap-4"
      >
        <Field label="Name" hint="e.g. Black Friday, Closure week">
          <Input required value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Multiplier" hint="0 = no demand · 1 = baseline · 2 = double · 7.6 etc.">
          <Input
            // Keyed by form id so the field remounts when switching to a
            // different event — otherwise the uncontrolled defaultValue
            // would stick to the first event's value.
            key={`mult-${form.id ?? "new"}`}
            type="number"
            min={0}
            step={0.1}
            required
            defaultValue={form.multiplier ?? 1}
            // Commit on blur AND on every change so submit-without-blur
            // still picks up the latest value.
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0) set("multiplier", n);
            }}
          />
        </Field>
        <Field label="Start date">
          <Input
            type="date"
            required
            value={form.start_date ?? ""}
            onChange={(e) => set("start_date", e.target.value)}
          />
        </Field>
        <Field label="End date">
          <Input
            type="date"
            required
            value={form.end_date ?? ""}
            onChange={(e) => set("end_date", e.target.value)}
          />
        </Field>
        <Field label="Apply to">
          <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            <option value="all">All SKUs</option>
            <option value="size">All SKUs of size…</option>
            <option value="colour">All SKUs of colour…</option>
            <option value="sku">Single SKU…</option>
          </Select>
        </Field>
        {scope === "size" ? (
          <Field label="Size">
            <Select value={form.apply_to_size ?? ""} onChange={(e) => set("apply_to_size", e.target.value || null)}>
              <option value="">Select…</option>
              {sizes.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        {scope === "colour" ? (
          <Field label="Colour">
            <Select value={form.apply_to_colour ?? ""} onChange={(e) => set("apply_to_colour", e.target.value || null)}>
              <option value="">Select…</option>
              {colours.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        {scope === "sku" ? (
          <Field label="SKU">
            <Select value={form.product_id ?? ""} onChange={(e) => set("product_id", e.target.value)}>
              <option value="">Select…</option>
              {data.products.map((p) => (
                <option key={p.id} value={p.id}>{p.code}</option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="col-span-2">
          <Field label="Notes">
            <Input value={form.notes ?? ""} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>

        {error ? (
          <div className="col-span-2 text-sm text-red-600 dark:text-red-400">{error}</div>
        ) : null}
        <div className="col-span-2 flex justify-between gap-2 pt-1">
          <div>
            {onDelete ? (
              <Button type="button" variant="danger" size="sm" onClick={onDelete}>
                <Trash2 size={14} /> Delete
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
            <Button type="submit">Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Day-distance from `today` to the closest edge of an event's date range.
 * Returns 0 when `today` is inside the range. Used by the All-events list
 * to put currently-active and soon-to-start events at the top.
 */
function distanceFromToday(e: DemandChangeEvent, today: string): number {
  if (today >= e.start_date && today <= e.end_date) return 0;
  if (today < e.start_date) return Math.abs(diffDays(today, e.start_date));
  return Math.abs(diffDays(today, e.end_date));
}

// ---------- date / collection helpers used by YearStrip + EventFormModal ----------

/** 1-based day-of-year for a YYYY-MM-DD date. Jan 1 = 1, Dec 31 = 365 or 366. */
function dayOfYear(iso: string): number {
  const d = parseIsoDate(iso);
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

/** Days in a month — `monthIdx` is 0-based (Jan = 0). */
function monthDays(year: number, monthIdx: number): number {
  // The 0th day of the next month gives us the day count of the current one.
  return new Date(year, monthIdx + 1, 0).getDate();
}

/** De-duplicate an array of strings, preserving order. */
function uniq<T extends string>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
