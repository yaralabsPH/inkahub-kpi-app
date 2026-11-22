import { useEffect, useState } from "react";
import type { PickerPerson } from "@/lib/scanners/client";
import { applyChoices, choicesFor, missingSkus, type FramerChoice, type PreparedDispatch } from "@/lib/scanners/dispatch";
import type { ScannerJob } from "@/lib/scanners/outbox";

/**
 * F7: the compact "who framed it?" chooser for ONE waiting dispatch job.
 * One person fills every line without a framing scan; a line can be set to
 * someone else. Saving records a MANUAL attribution only: no framing scan,
 * time or credit is created. The choice is bound to this job's request.
 *
 * A select pauses scanner capture while it is focused (F6 rule), so the
 * wall says so; the job and every other queued scan stay stored meanwhile.
 */

export type PeopleState = { status: "loading" } | { status: "ok"; people: PickerPerson[] } | { status: "error"; message: string };

export function FramerPicker({ job, people, onSave, onRecheck }: {
  job: ScannerJob & { prepared: PreparedDispatch };
  people: PeopleState;
  onSave(choices: FramerChoice[]): void;
  onRecheck(): void;
}) {
  const p = job.prepared;
  const missing = missingSkus(p);
  const [all, setAll] = useState<string>("");
  const [over, setOver] = useState<Record<string, string>>({});
  // A different job is a fresh choice.
  useEffect(() => {
    setAll("");
    setOver({});
  }, [job.requestId]);

  const list = people.status === "ok" ? people.people : [];
  const byId = new Map(list.map((x) => [x.personId, x]));
  const pick = (id: string) => {
    const x = byId.get(id);
    return x ? { personId: x.personId, displayName: x.displayName } : null;
  };
  const overrides: Record<string, { personId: string; displayName: string } | undefined> = {};
  for (const [sku, id] of Object.entries(over)) overrides[sku] = pick(id) ?? undefined;
  const choices = choicesFor(p, pick(all), overrides);
  const ready = applyChoices(p, choices).ok;

  return (
    <section className="mx-6 mt-4 rounded-xl bg-amber-950/60 ring-2 ring-amber-400 p-4" data-testid="framer-picker">
      <div className="text-2xl font-bold text-amber-200">#{job.orderNumber}: framing scan missing</div>
      <div className="text-sm text-amber-100/80 mt-1">
        Dispatched by {job.displayName}. Choose who framed it. This is saved as a manual record: it adds no framing scan, time or credit.
      </div>
      <ul className="mt-3 space-y-1">
        {p.framed.map((l) => {
          const ev = p.evidence.find((e) => e.sku === l.sku);
          const measured = ev?.status === "measured";
          return (
            <li key={l.sku} className="flex items-center gap-3 text-base">
              <span className="font-mono">{l.sku} × {l.quantity}</span>
              {measured ? (
                <span className="text-emerald-300 font-semibold">Framed by: {ev?.displayName} ✓</span>
              ) : (
                <>
                  <span className="text-amber-300 font-semibold">
                    {ev?.status === "conflict" ? "Several framing records — needs a choice" : "Framing scan missing"}
                  </span>
                  {missing.length > 1 ? (
                    <select
                      aria-label={`Framer for ${l.sku}`}
                      value={over[l.sku] ?? ""}
                      onChange={(e) => setOver((o) => ({ ...o, [l.sku]: e.target.value }))}
                      className="ml-auto rounded bg-slate-900 ring-1 ring-slate-600 px-2 h-8 text-sm"
                    >
                      <option value="">Same as below</option>
                      {list.map((x) => <option key={x.personId} value={x.personId}>{x.displayName}</option>)}
                    </select>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {people.status === "loading" ? <span className="text-sm">Loading people…</span> : null}
        {people.status === "error" ? <span className="text-sm text-red-300">Couldn't load people: {people.message}</span> : null}
        {people.status === "ok" ? (
          <label className="flex items-center gap-2 text-base">
            <span>{missing.length > 1 ? "All missing lines framed by" : "Framed by"}</span>
            <select
              aria-label="Framed by"
              value={all}
              onChange={(e) => setAll(e.target.value)}
              className="rounded bg-slate-900 ring-1 ring-slate-600 px-2 h-9"
            >
              <option value="">Choose a person…</option>
              {list.map((x) => <option key={x.personId} value={x.personId}>{x.displayName}</option>)}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          disabled={!ready}
          onClick={() => onSave(choices)}
          className="px-4 h-9 rounded bg-amber-400 text-amber-950 font-semibold disabled:opacity-40"
        >
          Save as manual and dispatch
        </button>
        <button type="button" onClick={onRecheck} className="px-3 h-9 rounded bg-slate-700 hover:bg-slate-600">
          Check framing scans again
        </button>
      </div>
      <div className="text-xs text-amber-100/70 mt-2">Scanner capture pauses while a list is open; tap the screen afterwards.</div>
    </section>
  );
}
