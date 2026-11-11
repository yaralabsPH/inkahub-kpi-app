import { useMemo, useState } from "react";
import { ClipboardList, Save, Undo2 } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { useLedger } from "@/lib/hooks/useLedger";
import { useMutations } from "@/lib/hooks/useMutations";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { fmtDayMonth, fmtNum } from "@/lib/utils/format";
import { shortCode } from "@/lib/domain";
import type { LedgerReason } from "@/lib/domain";

/**
 * Ad-hoc inventory movements page. Logs anything that isn't a sale or a
 * shipment delivery — samples, breakage, photo-shoot use, transfers,
 * stocktake reconciliation. Each submit creates one ledger row and
 * atomically adjusts the SKU's on-hand via the shared adjustOnHand
 * pipeline, so the audit trail and on-hand stay in sync.
 *
 * The exposed "category" select is a thin UX shim that maps to a
 * LedgerReason + a free-text note. The underlying ledger reason vocabulary
 * stays small (sale / shipment / usage / manual / stocktake / transfer /
 * initial / import / bom) so reports can group cleanly.
 *
 * Each ledger row in the recent-activity table has a Reverse button. Click
 * it to create an opposite-sign correcting entry that undoes the on-hand
 * impact. The original entry stays visible — audit-honest, no destructive
 * delete. Rows that are themselves reversals (source_id starts with
 * "reversal:") are flagged "↩ reversed" and can't be reversed again.
 */

interface Preset {
  key: string;
  label: string;
  reason: LedgerReason;
  defaultDirection: "out" | "in";
  hint: string;
}

const PRESETS: readonly Preset[] = [
  { key: "sample",   label: "Sample given away",          reason: "usage",    defaultDirection: "out", hint: "Marketing or customer sample." },
  { key: "damaged",  label: "Damaged / written off",      reason: "usage",    defaultDirection: "out", hint: "Stock destroyed, defective, or unsellable." },
  { key: "internal", label: "Internal use",               reason: "usage",    defaultDirection: "out", hint: "Photoshoot, showroom display, staff use." },
  { key: "transfer-out", label: "Transfer out (to another location)", reason: "transfer", defaultDirection: "out", hint: "Sent to another location. Set up the receiving leg separately by switching to that location." },
  { key: "transfer-in",  label: "Transfer in (from another location)", reason: "transfer", defaultDirection: "in",  hint: "Received from another location." },
  { key: "stocktake-adjust", label: "Stocktake adjustment", reason: "stocktake", defaultDirection: "out", hint: "Reconcile against a physical count. Use negative qty if the count was less than the system; positive if more." },
  { key: "found-stock",  label: "Found stock",            reason: "stocktake", defaultDirection: "in",  hint: "Stock found that the system didn't know about." },
  { key: "other",    label: "Other (free text)",          reason: "manual",   defaultDirection: "out", hint: "Anything that doesn't fit the categories above. Put the explanation in the note field." },
];

export function Movements() {
  const { data } = useDataset();
  const { data: recent } = useLedger(undefined, 25);
  const m = useMutations();

  const [presetKey, setPresetKey] = useState<string>(PRESETS[0].key);
  const [productId, setProductId] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reversingId, setReversingId] = useState<string | null>(null);

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0];

  const products = useMemo(() => {
    if (!data) return [];
    return data.products.slice().sort((a, b) => a.code.localeCompare(b.code));
  }, [data]);

  const selectedProduct = products.find((p) => p.id === productId);
  const numericQty = Math.abs(Number(qty));
  const valid = !!selectedProduct && Number.isFinite(numericQty) && numericQty > 0;

  // -------- Set of ledger row IDs that have ALREADY been reversed --------
  // A row whose `source_id` is `reversal:<original_id>` is a reversal entry,
  // and we use that to mark the original as "(reversed)" + disable its button.
  const reversedOriginalIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of recent ?? []) {
      if (r.source_id?.startsWith("reversal:")) {
        const originalId = r.source_id.slice("reversal:".length);
        set.add(originalId);
      }
    }
    return set;
  }, [recent]);

  const submit = async () => {
    if (!valid || !selectedProduct) return;
    setBusy(true); setMsg(null);
    try {
      // adjustOnHand semantics: positive `delta` arg DECREMENTS on-hand.
      // Preset's defaultDirection tells us which sign to feed in.
      const directionSign = preset.defaultDirection === "out" ? 1 : -1;
      const apiDelta = directionSign * numericQty;
      await m.adjustOnHand.mutateAsync({
        productId: selectedProduct.id,
        delta: apiDelta,
        context: {
          reason: preset.reason,
          source_id: `movement:${preset.key}:${Date.now()}`,
          note: note.trim() || preset.label,
        },
      });
      setMsg(
        `Logged ${preset.defaultDirection === "out" ? "−" : "+"}${numericQty} ${selectedProduct.code} as "${preset.label}".`,
      );
      setQty("");
      setNote("");
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Reverse a ledger row. The math is symmetric:
   *   - adjustOnHand's p_delta SUBTRACTS from on_hand
   *   - so passing the ORIGINAL row.delta value produces an opposite-sign
   *     on_hand change (i.e., undoes the original)
   *   - the new ledger entry's delta = -original.delta (computed inside RPC)
   *
   * Reversal entries are tagged with source_id="reversal:<original_id>" so
   * the original row can be flagged "(reversed)" in the UI and disabled
   * from re-reversing.
   *
   * Uses reason='manual' deliberately. This means BOM cascades do NOT
   * recurse — if a sale created BOM-cascade children, reversing the parent
   * sale row WON'T undo those child rows automatically. Reverse them
   * individually (or by SKU detail view, where each cascade child is
   * visible).
   */
  const handleReverse = async (row: NonNullable<typeof recent>[number]) => {
    if (reversedOriginalIds.has(row.id)) return; // already reversed
    if (row.source_id?.startsWith("reversal:")) return; // can't reverse a reversal
    const product = data?.products.find((p) => p.id === row.product_id);
    const productLabel = product?.code ?? row.product_id;
    const directionWord = row.delta > 0 ? "remove" : "add back";
    const absQty = Math.abs(row.delta);
    const confirmed = window.confirm(
      `Reverse this ledger entry?\n\n` +
      `SKU: ${productLabel}\n` +
      `Original change: ${row.delta > 0 ? "+" : ""}${fmtNum(row.delta)} (${row.reason}${row.note ? " — " + row.note : ""})\n\n` +
      `This will ${directionWord} ${fmtNum(absQty)} ${productLabel} from current on-hand and add a "Reversal" entry to the ledger. ` +
      `The original entry stays visible.`,
    );
    if (!confirmed) return;
    setReversingId(row.id);
    setMsg(null);
    try {
      await m.adjustOnHand.mutateAsync({
        productId: row.product_id,
        delta: row.delta, // see math note above — original delta value undoes the change
        context: {
          reason: "manual",
          source_id: `reversal:${row.id}`,
          parent_event_id: row.id,
          note: `Reversal of ledger ${row.id}${row.note ? ": " + row.note : ""}`,
        },
      });
      setMsg(`Reversed entry for ${productLabel} (${row.delta > 0 ? "−" : "+"}${fmtNum(absQty)}).`);
    } catch (e) {
      setMsg(`Reverse failed: ${(e as Error).message}`);
    } finally {
      setReversingId(null);
    }
  };

  if (!data) return <div className="text-sm text-slate-500">Loading…</div>;

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight inline-flex items-center gap-2">
          <ClipboardList size={18} /> Movements
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Log ad-hoc inventory movements that aren't sales or shipment arrivals — samples, damaged stock, internal use, transfers, stocktake reconciliation. Every submit appends a row to the ledger and atomically adjusts on-hand.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Log a movement</CardTitle>
          <span className="text-xs text-slate-500">
            Pick a category, SKU, and quantity. The note field is optional but useful for stocktakes ("April count") or transfers ("→ UK").
          </span>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Category">
              <Select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="SKU" hint={preset.hint}>
              <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
                <option value="">— pick a SKU —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {shortCode(p)} · on hand: {p.current_on_hand}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <Field
              label={`Quantity (${preset.defaultDirection === "out" ? "deducts" : "adds"} from on-hand)`}
              hint={preset.defaultDirection === "out"
                ? "Always enter a positive number — direction is set by the category."
                : "Always enter a positive number — direction is set by the category."}
            >
              <Input type="number" min={0} step={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="0" />
            </Field>
            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={preset.label} />
            </Field>
            <div className="flex flex-wrap items-end gap-2">
              <Button disabled={!valid || busy} onClick={submit}>
                <Save size={14} /> {busy ? "Saving…" : "Log movement"}
              </Button>
              {selectedProduct ? (
                <span className="text-[11px] text-slate-500 self-center">
                  After: <strong className="tabular-nums">
                    {fmtNum(Math.max(
                      (selectedProduct.current_on_hand ?? 0) - (preset.defaultDirection === "out" ? numericQty : -numericQty),
                      0,
                    ))}
                  </strong>
                </span>
              ) : null}
            </div>
          </div>
          {msg ? <div className="text-sm text-emerald-700 dark:text-emerald-400">{msg}</div> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <span className="text-xs text-slate-500">
            Last 25 ledger rows across every SKU in this location. Click <Undo2 size={11} className="inline -mt-1" /> to reverse a mistake — it creates an opposite-sign correcting entry without deleting the original.
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {!recent || recent.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">No ledger activity yet.</div>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide sticky top-0 z-10">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-2 py-2">SKU</th>
                    <th className="text-left font-medium px-2 py-2">Reason</th>
                    <th className="text-right font-medium px-2 py-2">Delta</th>
                    <th className="text-left font-medium px-3 py-2">Note / source</th>
                    <th className="text-right font-medium px-2 py-2 w-20">Reverse</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {recent.map((row) => {
                    const dt = new Date(row.ts);
                    const product = data.products.find((p) => p.id === row.product_id);
                    const isReversal = row.source_id?.startsWith("reversal:") ?? false;
                    const alreadyReversed = reversedOriginalIds.has(row.id);
                    const reverseDisabled =
                      isReversal || alreadyReversed || reversingId === row.id || !product;
                    return (
                      <tr key={row.id} className={alreadyReversed ? "opacity-60" : undefined}>
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <div className="text-slate-900 dark:text-slate-100 tabular-nums">{fmtDayMonth(dt.toISOString().slice(0, 10))}</div>
                          <div className="text-[10px] text-slate-500 tabular-nums">{dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-xs">
                          {product ? product.code : <span className="text-slate-400 italic">(deleted)</span>}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className="text-[10px] uppercase tracking-wide text-slate-500">{row.reason}</span>
                          {isReversal && (
                            <span className="ml-1 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">↩ reversal</span>
                          )}
                          {alreadyReversed && !isReversal && (
                            <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">↩ reversed</span>
                          )}
                        </td>
                        <td className={`px-2 py-1.5 text-right tabular-nums font-semibold ${row.delta < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                          {row.delta >= 0 ? "+" : ""}{fmtNum(row.delta)}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                          {row.note ? <div className="text-slate-700 dark:text-slate-300">{row.note}</div> : null}
                          {row.source_id ? <div className="font-mono text-[10px] truncate max-w-[42ch]" title={row.source_id}>{row.source_id}</div> : null}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          <button
                            type="button"
                            onClick={() => void handleReverse(row)}
                            disabled={reverseDisabled}
                            title={
                              isReversal
                                ? "This row is already a reversal"
                                : alreadyReversed
                                  ? "This entry has already been reversed"
                                  : !product
                                    ? "Original product was deleted; can't reverse"
                                    : "Reverse this entry — adds an opposite-sign correcting row"
                            }
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 disabled:opacity-30 disabled:pointer-events-none transition"
                          >
                            <Undo2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
