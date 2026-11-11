import { useCallback, useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { useDataset } from "@/lib/hooks/useDataset";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { useAppStore } from "@/lib/state/appStore";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import {
  STANDARD_PAYMENT_TERMS,
  type SupplierSettings,
  formatTermsLabel,
} from "@/lib/domain";

/**
 * Find the preset whose (days, eom) matches the given saved values. Used
 * to drive the dropdown back to the right option after a reload.
 */
function findPreset(days: number | null, eom: boolean | null | undefined) {
  if (days == null) return null;
  const eomBool = Boolean(eom);
  return STANDARD_PAYMENT_TERMS.find((p) => p.value === days && Boolean(p.eom) === eomBool) ?? null;
}

export function SupplierPaymentTermsCard() {
  const { data } = useDataset();
  const auth = useAuthOptional();
  const isOwner = auth?.profile?.role === "owner";
  const isSupabase = getBackendMode() === "supabase";
  const location = useAppStore((s) => s.location);

  const suppliers = useMemo(() => {
    if (!data?.products) return [] as string[];
    return Array.from(new Set(data.products.map((p) => p.supplier).filter(Boolean))).sort();
  }, [data?.products]);

  const [settings, setSettings] = useState<Map<string, SupplierSettings>>(new Map());
  const [drafts, setDrafts] = useState<Map<string, Partial<SupplierSettings>>>(new Map());
  /**
   * Suppliers currently in "Custom" mode in the dropdown. Independent of
   * whether a custom days value has been entered yet - lets us show the
   * Custom days input before any value exists, so picking "Custom" doesn''t
   * auto-save anything.
   */
  const [customMode, setCustomMode] = useState<Set<string>>(new Set());

  // Fetch existing supplier_settings rows for this location.
  useEffect(() => {
    if (!isOwner || !isSupabase) {
      setSettings(new Map());
      return;
    }
    const supabase = getSupabase();
    let cancelled = false;
    (async () => {
      const { data: rows, error } = await supabase
        .from("supplier_settings")
        .select("*")
        .eq("location", location);
      if (cancelled) return;
      if (error) { console.error("supplier_settings fetch", error); return; }
      const m = new Map<string, SupplierSettings>();
      for (const r of (rows ?? []) as SupplierSettings[]) m.set(r.supplier_name, r);
      setSettings(m);
    })();
    return () => { cancelled = true; };
  }, [isOwner, isSupabase, location]);

  // === optimistic save ===
  // Update local state IMMEDIATELY so the dropdown reflects the user''s pick.
  // If the upsert errors (e.g. SQL migration not applied yet â†’ unknown column),
  // revert and surface the error inline so the user can act on it.
  const [saveError, setSaveError] = useState<string | null>(null);
  const save = useCallback(async (supplier: string, patch: Partial<SupplierSettings>) => {
    if (!isOwner || !isSupabase) return;
    const supabase = getSupabase();
    const previous = settings.get(supplier);
    const next: SupplierSettings = {
      location,
      supplier_name: supplier,
      payment_terms_days: previous?.payment_terms_days ?? null,
      payment_terms_eom: previous?.payment_terms_eom ?? false,
      default_currency: previous?.default_currency ?? "AUD",
      notes: previous?.notes ?? null,
      ...patch,
    };
    // Optimistic: apply right away.
    setSettings((m) => new Map(m).set(supplier, next));
    setSaveError(null);
    const { error } = await supabase.from("supplier_settings").upsert(next);
    if (error) {
      console.error("supplier_settings upsert", error);
      // Revert.
      setSettings((m) => {
        const n = new Map(m);
        if (previous) n.set(supplier, previous);
        else n.delete(supplier);
        return n;
      });
      const hint = /payment_terms_eom/i.test(error.message)
        ? " Did you run migration 0019_payment_terms_eom.sql in Supabase?"
        : "";
      setSaveError(`Couldn''t save terms for ${supplier}: ${error.message}.${hint}`);
      return;
    }
    setDrafts((d) => {
      const n = new Map(d);
      n.delete(supplier);
      return n;
    });
  }, [isOwner, isSupabase, location, settings]);

  if (!isOwner) return null;

  const setDraft = (supplier: string, patch: Partial<SupplierSettings>) => {
    setDrafts((d) => {
      const n = new Map(d);
      n.set(supplier, { ...(d.get(supplier) ?? {}), ...patch });
      return n;
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users size={16} className="text-slate-600 dark:text-slate-400" />
          <CardTitle>Supplier payment terms</CardTitle>
        </div>
        <span className="text-xs text-slate-500">
          Default payment terms per supplier. Used to auto-compute invoice due dates on shipments. Per-shipment override available in the shipment modal.
        </span>
      </CardHeader>
      <CardBody>
        {saveError ? (
          <div className="mb-3 text-xs text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded px-3 py-2 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-800">
            {saveError}
          </div>
        ) : null}
        {suppliers.length === 0 ? (
          <div className="text-sm text-slate-500 italic">
            No suppliers yet - add a SKU with a supplier set to populate this list.
          </div>
        ) : (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-xs uppercase tracking-wide text-slate-600 dark:text-slate-400">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Supplier</th>
                  <th className="text-left font-medium px-2 py-2">Terms</th>
                  <th className="text-left font-medium px-2 py-2">Custom days</th>
                  <th className="text-left font-medium px-2 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {suppliers.map((supplier) => {
                  const row = settings.get(supplier);
                  const draft = drafts.get(supplier);
                  const termsDays = (draft?.payment_terms_days !== undefined ? draft.payment_terms_days : row?.payment_terms_days) ?? null;
                  const eom = Boolean((draft?.payment_terms_eom !== undefined ? draft.payment_terms_eom : row?.payment_terms_eom) ?? false);
                  const preset = findPreset(termsDays, eom);
                  const inCustomMode = customMode.has(supplier);
                  const isCustomActive = inCustomMode || (termsDays != null && !preset);
                  const dropdownValue = preset?.key ?? (isCustomActive ? "custom" : "");
                  const notes = draft?.notes !== undefined ? (draft.notes ?? "") : (row?.notes ?? "");
                  return (
                    <tr key={supplier}>
                      <td className="px-3 py-1.5 font-medium">{supplier}</td>
                      <td className="px-2 py-1.5">
                        <Select
                          className="h-8 w-44 text-xs"
                          value={dropdownValue}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === "") {
                              setCustomMode((m) => { const n = new Set(m); n.delete(supplier); return n; });
                              void save(supplier, { payment_terms_days: null, payment_terms_eom: false });
                            } else if (v === "custom") {
                              setCustomMode((m) => new Set(m).add(supplier));
                              // Don''t save anything yet; wait for the user to type in Custom days.
                            } else {
                              setCustomMode((m) => { const n = new Set(m); n.delete(supplier); return n; });
                              const p = STANDARD_PAYMENT_TERMS.find((x) => x.key === v);
                              if (p) void save(supplier, { payment_terms_days: p.value, payment_terms_eom: p.eom });
                            }
                          }}
                        >
                          <option value="">not set</option>
                          {STANDARD_PAYMENT_TERMS.map((t) => (
                            <option key={t.key} value={t.key}>{t.label}</option>
                          ))}
                          <option value="custom">Custom</option>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        {isCustomActive ? (
                          <Input
                            className="h-8 w-20 text-xs text-right tabular-nums"
                            type="number"
                            min={0}
                            step={1}
                            placeholder="days"
                            value={String(termsDays ?? "")}
                            onChange={(e) => setDraft(supplier, { payment_terms_days: e.target.value === "" ? null : Number(e.target.value) })}
                            onBlur={(e) => {
                              const days = e.target.value === "" ? null : Number(e.target.value);
                              // Save only when the user actually entered a value.
                              if (days != null) {
                                void save(supplier, { payment_terms_days: days, payment_terms_eom: false });
                              }
                            }}
                          />
                        ) : (
                          <span className="text-xs text-slate-400">--</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          className="h-8 text-xs"
                          value={notes}
                          onChange={(e) => setDraft(supplier, { notes: e.target.value || null })}
                          onBlur={(e) => void save(supplier, { notes: e.target.value || null })}
                          placeholder="optional"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-slate-500 mt-2">
          Due date = order placed date + terms days (or end of order month + days, for EOM presets). Per-shipment override in the shipment modal beats this default.
        </p>
      </CardBody>
    </Card>
  );
}

// Suppress unused-import warnings (Field referenced for type completeness).
void Field;
void formatTermsLabel;