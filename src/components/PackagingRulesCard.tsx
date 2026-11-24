import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import {
  PackagingRulesView,
  type DraftEditorState,
  type ProductOption,
} from "@/components/packaging/PackagingRulesView";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { LOCATION_LABELS, type LocationKey } from "@/lib/domain";
import {
  addCatalogueItem,
  canManagePackagingRules,
  checkDraft,
  draftFrom,
  removeCatalogueItem,
  updateCatalogueItem,
} from "@/lib/domain/packaging/editing";
import { isEditableBody } from "@/lib/domain/packaging/ruleEditing";
import { emptyRuleSetBody, parseRuleSetBody, type RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { useDataset } from "@/lib/hooks/useDataset";
import { getBackendMode, getSupabase } from "@/lib/repository/supabase/client";
import {
  activateRuleSet,
  listRuleSets,
  loadPackagingConfig,
  saveRuleSet,
  setPackagingMode,
  type PackagingMode,
  type RuleSetRow,
} from "@/lib/repository/supabase/orderPackaging";
import { useAppStore } from "@/lib/state/appStore";

/**
 * F4 box-auto-pick: Settings card where an owner or manager switches the
 * site between box scanning and automatic packaging, and manages the
 * versioned packaging rules.
 *
 * Supabase only (production runs on Supabase; there is nothing to manage
 * in Dexie mode). Hidden for staff, kiosk and cs; the database enforces
 * the same rule on every write.
 */
export function PackagingRulesCard() {
  // Optional: local (Dexie) mode has no AuthProvider, and the card renders
  // nothing there anyway (the backend check below).
  const profile = useAuthOptional()?.profile ?? null;
  if (getBackendMode() !== "supabase") return null;
  if (!canManagePackagingRules(profile?.role)) return null;
  return <PackagingRulesCardInner />;
}

type Message = { kind: "ok" | "error"; text: string } | null;

interface Draft {
  id: string | null;
  basedOnVersion: number | null;
  body: RuleSetBody;
  note: string;
  dirty: boolean;
}

function PackagingRulesCardInner() {
  const supabase = getSupabase();
  const location = useAppStore((s) => s.location);
  const { data: dataset } = useDataset();
  const [mode, setMode] = useState<PackagingMode>("scan");
  const [ruleSets, setRuleSets] = useState<RuleSetRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const siteLabel = LOCATION_LABELS[location as LocationKey] ?? location;

  const products = useMemo<ProductOption[]>(() => {
    const all = dataset?.products ?? [];
    // Packaging-type stock first, then everything else, each by code.
    return [...all]
      .sort((a, b) => Number(b.product_type === "packaging") - Number(a.product_type === "packaging") || a.code.localeCompare(b.code))
      .map((p) => ({ id: p.id, code: p.code }));
  }, [dataset]);
  const productIds = useMemo(() => new Set(products.map((p) => p.id)), [products]);

  const reload = useCallback(async () => {
    const [config, sets] = await Promise.all([loadPackagingConfig(supabase, location), listRuleSets(supabase, location)]);
    // "auto requested but fell back" still means the site's setting is auto.
    setMode(config.mode === "auto" || config.warning ? "auto" : "scan");
    if (sets.outcome === "ok") setRuleSets(sets.value);
    else setMessage({ kind: "error", text: sets.message });
    setLoaded(true);
  }, [supabase, location]);

  useEffect(() => {
    setDraft(null);
    setMessage(null);
    setLoaded(false);
    void reload();
  }, [reload]);

  const edit = (change: (body: RuleSetBody) => RuleSetBody) =>
    setDraft((d) => (d ? { ...d, body: change(d.body), dirty: true } : d));

  const run = async (work: () => Promise<Message>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
    } finally {
      setBusy(false);
    }
  };

  const onSetMode = (next: PackagingMode) => {
    const question =
      next === "auto"
        ? `Switch ${siteLabel} to automatic packaging? Stations stop asking for a box scan from their next order.`
        : `Switch ${siteLabel} back to box scanning? Stations ask for a box scan again from their next order.`;
    if (!window.confirm(question)) return;
    void run(async () => {
      const res = await setPackagingMode(supabase, { location, mode: next });
      if (res.outcome !== "ok") return { kind: "error", text: res.message };
      setMode(res.value);
      return { kind: "ok", text: next === "auto" ? `${siteLabel} now picks packaging automatically.` : `${siteLabel} is back on box scanning.` };
    });
  };

  const onNewDraft = (from: RuleSetRow | null) => {
    if (draft?.dirty && !window.confirm("Discard the unsaved changes in the open draft?")) return;
    if (!from) {
      setDraft({ id: null, basedOnVersion: null, body: emptyRuleSetBody(), note: "", dirty: true });
      return;
    }
    const parsed = parseRuleSetBody(from.body);
    if (!parsed.ok) {
      setMessage({ kind: "error", text: `Version ${from.version} could not be read: ${parsed.problems[0] ?? "unknown problem"}` });
      return;
    }
    setDraft({ id: null, basedOnVersion: from.version, body: draftFrom(parsed.body), note: `Based on v${from.version}`, dirty: true });
  };

  const onOpenDraft = (row: RuleSetRow) => {
    if (draft?.dirty && !window.confirm("Discard the unsaved changes in the open draft?")) return;
    const parsed = parseRuleSetBody(row.body);
    // A stored draft that fails validation is still opened so it can be fixed,
    // as long as it has the basic shape the editor needs to draw it.
    if (!parsed.ok && !isEditableBody(row.body)) {
      setMessage({ kind: "error", text: `Draft v${row.version} was not saved by this screen and cannot be opened here. Start a new draft instead.` });
      return;
    }
    const body = parsed.ok ? draftFrom(parsed.body) : draftFrom(row.body as RuleSetBody);
    setDraft({ id: row.id, basedOnVersion: null, body, note: row.note, dirty: false });
  };

  const onSaveDraft = () => {
    if (!draft) return;
    const parsed = parseRuleSetBody(draft.body);
    if (!parsed.ok) {
      setMessage({ kind: "error", text: parsed.problems[0] ?? "The draft is not valid." });
      return;
    }
    void run(async () => {
      const res = await saveRuleSet(supabase, { location, id: draft.id, body: parsed.body, note: draft.note });
      if (res.outcome !== "ok") return { kind: "error", text: res.message };
      setDraft({ ...draft, id: res.value.id, body: parsed.body, dirty: false });
      await reload();
      return { kind: "ok", text: `Draft saved as version ${res.value.version}.` };
    });
  };

  const onActivate = () => {
    if (!draft?.id || draft.dirty) return;
    if (!window.confirm(`Activate this version for ${siteLabel}? It replaces the current rules for new orders. Existing records are not changed.`)) return;
    const id = draft.id;
    void run(async () => {
      const res = await activateRuleSet(supabase, { location, id });
      if (res.outcome !== "ok") return { kind: "error", text: res.message };
      setDraft(null);
      await reload();
      return { kind: "ok", text: `Version ${res.value.version} is now active for ${siteLabel}.` };
    });
  };

  const draftState: DraftEditorState | null = draft ? { ...draft, check: checkDraft(draft.body, productIds) } : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Packaging (boxes and tubes)</CardTitle>
      </CardHeader>
      <CardBody>
        {!loaded ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <PackagingRulesView
            siteLabel={siteLabel}
            mode={mode}
            ruleSets={ruleSets}
            products={products}
            draft={draftState}
            busy={busy}
            message={message}
            onSetMode={onSetMode}
            onNewDraft={onNewDraft}
            onOpenDraft={onOpenDraft}
            onCloseDraft={() => {
              if (draft?.dirty && !window.confirm("Discard the unsaved changes?")) return;
              setDraft(null);
            }}
            onChangeNote={(note) => setDraft((d) => (d ? { ...d, note, dirty: true } : d))}
            onAddItem={(product) => edit((b) => addCatalogueItem(b, product))}
            onUpdateItem={(index, patch) => edit((b) => updateCatalogueItem(b, index, patch))}
            onRemoveItem={(index) => edit((b) => removeCatalogueItem(b, index))}
            onEditBody={edit}
            onSaveDraft={onSaveDraft}
            onActivate={onActivate}
          />
        )}
      </CardBody>
    </Card>
  );
}
