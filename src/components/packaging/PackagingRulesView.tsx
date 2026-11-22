import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import type { PackingPoint } from "@/lib/domain/packaging/contents";
import { toggleCataloguePoint, type DraftCheck } from "@/lib/domain/packaging/editing";
import { runExamples } from "@/lib/domain/packaging/evaluate";
import type { CatalogueItem, RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import type { PackagingMode, RuleSetRow } from "@/lib/repository/supabase/orderPackaging";

/**
 * F4 box-auto-pick: Settings view for the site's packaging mode, rule-set
 * versions and a draft's packaging catalogue. Presentational; state and
 * saving live in PackagingRulesCard.
 */

export interface ProductOption {
  id: string;
  code: string;
}

export interface DraftEditorState {
  /** Null for a draft that has not been saved yet. */
  id: string | null;
  basedOnVersion: number | null;
  body: RuleSetBody;
  note: string;
  dirty: boolean;
  check: DraftCheck;
}

export interface PackagingRulesViewProps {
  siteLabel: string;
  mode: PackagingMode;
  ruleSets: RuleSetRow[];
  products: ProductOption[];
  draft: DraftEditorState | null;
  busy: boolean;
  message: { kind: "ok" | "error"; text: string } | null;
  onSetMode: (mode: PackagingMode) => void;
  onNewDraft: (from: RuleSetRow | null) => void;
  onOpenDraft: (row: RuleSetRow) => void;
  onCloseDraft: () => void;
  onChangeNote: (note: string) => void;
  onAddItem: (product: ProductOption) => void;
  onUpdateItem: (index: number, patch: Partial<CatalogueItem>) => void;
  onRemoveItem: (index: number) => void;
  onSaveDraft: () => void;
  onActivate: () => void;
}

const POINT_LABEL: Record<PackingPoint, string> = { a0_framed: "A0 Framed", dispatch: "Dispatch", unframed: "Unframed" };
const POINTS: PackingPoint[] = ["a0_framed", "dispatch", "unframed"];

const STATUS_TEXT: Record<RuleSetRow["status"], string> = { draft: "Draft", active: "Active", retired: "Retired" };

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function ModeSection(props: Pick<PackagingRulesViewProps, "mode" | "ruleSets" | "busy" | "onSetMode" | "siteLabel">) {
  const active = props.ruleSets.find((r) => r.status === "active") ?? null;
  const option = (mode: PackagingMode, title: string, text: string, disabled: boolean) => (
    <button
      type="button"
      aria-pressed={props.mode === mode}
      disabled={disabled || props.busy || props.mode === mode}
      onClick={() => props.onSetMode(mode)}
      className={
        "flex-1 text-left rounded-lg px-4 py-3 ring-1 transition " +
        (props.mode === mode
          ? "ring-2 ring-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
          : "ring-slate-200 dark:ring-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-60")
      }
    >
      <div className="text-sm font-semibold">{title}{props.mode === mode ? " (current)" : ""}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{text}</div>
    </button>
  );
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">How {props.siteLabel} stations handle packaging</h3>
      <div className="flex flex-col sm:flex-row gap-2">
        {option("scan", "Scan the box", "Workers scan a box barcode before Complete, as before.", false)}
        {option(
          "auto",
          "Pick automatically",
          active
            ? `The app picks the packaging using rules version ${active.version}. No box scan.`
            : "Needs an active rule set first.",
          !active,
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Stations pick up a change on their next order. Switching back to scanning is always safe.
      </p>
    </section>
  );
}

function VersionsSection(props: Pick<PackagingRulesViewProps, "ruleSets" | "busy" | "onNewDraft" | "onOpenDraft">) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Rule versions</h3>
        <Button type="button" variant="secondary" disabled={props.busy} onClick={() => props.onNewDraft(null)}>
          New empty draft
        </Button>
      </div>
      {props.ruleSets.length === 0 ? (
        <p className="text-sm text-slate-500">No rule sets yet. Start a draft, add the packaging items, rules and examples, then activate it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="py-1 pr-3">Version</th><th className="pr-3">Status</th><th className="pr-3">Note</th><th className="pr-3">Activated</th><th /></tr>
            </thead>
            <tbody>
              {props.ruleSets.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2 pr-3 font-mono">v{r.version}</td>
                  <td className="pr-3">{STATUS_TEXT[r.status]}</td>
                  <td className="pr-3 text-slate-600 dark:text-slate-300">{r.note}</td>
                  <td className="pr-3 text-slate-500">{when(r.activated_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    {r.status === "draft" ? (
                      <Button type="button" variant="secondary" disabled={props.busy} onClick={() => props.onOpenDraft(r)}>Edit draft</Button>
                    ) : (
                      <Button type="button" variant="secondary" disabled={props.busy} onClick={() => props.onNewDraft(r)}>
                        New draft from v{r.version}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Active and retired versions never change. To change the rules, or to go back to an older version, make a draft from it and activate that.
      </p>
    </section>
  );
}

function CatalogueSection(props: Pick<PackagingRulesViewProps, "products" | "busy" | "onAddItem" | "onUpdateItem" | "onRemoveItem"> & { body: RuleSetBody }) {
  const known = new Set(props.products.map((p) => p.id));
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">Packaging items</h4>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        The boxes and tubes this site uses. Each one is a stock item; that stock is what gets deducted.
      </p>
      {props.body.catalogue.length === 0 ? <p className="text-sm text-slate-500">No packaging items yet.</p> : null}
      {props.body.catalogue.map((item, i) => (
        <div key={i} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center rounded-md ring-1 ring-slate-200 dark:ring-slate-700 p-2">
          <Input className="md:col-span-3" aria-label={`Name of packaging item ${i + 1}`} placeholder="Name shown to workers" value={item.label}
            disabled={props.busy} onChange={(e) => props.onUpdateItem(i, { label: e.target.value })} />
          <Select className="md:col-span-3" aria-label={`Stock item for ${item.label || `item ${i + 1}`}`} value={item.product_id}
            disabled={props.busy} onChange={(e) => props.onUpdateItem(i, { product_id: e.target.value })}>
            {known.has(item.product_id) ? null : <option value={item.product_id}>Missing stock item ({item.product_id})</option>}
            {props.products.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
          </Select>
          <Input className="md:col-span-2" aria-label={`Old box barcode for ${item.label || `item ${i + 1}`}`} placeholder="Old barcode, e.g. +48="
            value={item.legacy_barcode ?? ""} disabled={props.busy} onChange={(e) => props.onUpdateItem(i, { legacy_barcode: e.target.value.trim() || undefined })} />
          <div className="md:col-span-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {POINTS.map((pt) => (
              <label key={pt} className="inline-flex items-center gap-1">
                <input type="checkbox" disabled={props.busy} checked={!item.packing_points || item.packing_points.includes(pt)}
                  onChange={() => props.onUpdateItem(i, { packing_points: toggleCataloguePoint(item, pt) })} />
                {POINT_LABEL[pt]}
              </label>
            ))}
          </div>
          <Button type="button" variant="secondary" className="md:col-span-1" disabled={props.busy}
            aria-label={`Remove ${item.label || `item ${i + 1}`}`} onClick={() => props.onRemoveItem(i)}>
            Remove
          </Button>
        </div>
      ))}
      <Select aria-label="Add a packaging item" value="" disabled={props.busy || props.products.length === 0}
        onChange={(e) => {
          const p = props.products.find((x) => x.id === e.target.value);
          if (p) props.onAddItem(p);
        }}>
        <option value="">{props.products.length === 0 ? "No stock items at this site" : "Add a packaging item from stock…"}</option>
        {props.products.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
      </Select>
    </section>
  );
}

function DraftSection(props: PackagingRulesViewProps & { draft: DraftEditorState }) {
  const { draft } = props;
  const results = draft.check.problems.length === 0 ? runExamples(draft.body) : [];
  const failing = results.filter((r) => !r.pass).length;
  return (
    <section className="space-y-4 rounded-lg ring-1 ring-slate-200 dark:ring-slate-700 p-4" data-draft={draft.id ?? "new"}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {draft.id ? "Editing draft" : "New draft"}
          {draft.basedOnVersion ? ` (from v${draft.basedOnVersion})` : ""}
          {draft.dirty ? " · not saved" : ""}
        </h3>
        <Button type="button" variant="secondary" disabled={props.busy} onClick={props.onCloseDraft}>Close</Button>
      </div>
      <Input aria-label="Note for this version" placeholder="Note, e.g. what changed and who asked" value={draft.note}
        disabled={props.busy} onChange={(e) => props.onChangeNote(e.target.value)} />

      <CatalogueSection body={draft.body} products={props.products} busy={props.busy}
        onAddItem={props.onAddItem} onUpdateItem={props.onUpdateItem} onRemoveItem={props.onRemoveItem} />

      <div className="text-sm text-slate-600 dark:text-slate-300" data-summary="rules">
        {draft.body.rules.length} {draft.body.rules.length === 1 ? "rule" : "rules"} · {draft.body.examples.length}{" "}
        {draft.body.examples.length === 1 ? "example" : "examples"}
        {results.length > 0 ? (failing === 0 ? " · all examples pass" : ` · ${failing} failing`) : ""}
      </div>

      {draft.check.problems.length > 0 ? (
        <ul className="text-sm text-red-600 dark:text-red-400 list-disc pl-5" role="alert">
          {draft.check.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={props.busy || !draft.dirty || draft.check.problems.length > 0} onClick={props.onSaveDraft}>Save draft</Button>
        <Button type="button" variant="secondary" disabled={props.busy || draft.dirty || !draft.id || !draft.check.canActivate} onClick={props.onActivate}>
          Activate this version
        </Button>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {draft.check.activationHint ?? (draft.dirty ? "Save the draft before activating." : "Activating retires the current version. Existing records are not changed.")}
        </span>
      </div>
    </section>
  );
}

export function PackagingRulesView(props: PackagingRulesViewProps) {
  return (
    <div className="space-y-6">
      <ModeSection mode={props.mode} ruleSets={props.ruleSets} busy={props.busy} onSetMode={props.onSetMode} siteLabel={props.siteLabel} />
      <VersionsSection ruleSets={props.ruleSets} busy={props.busy} onNewDraft={props.onNewDraft} onOpenDraft={props.onOpenDraft} />
      {props.draft ? <DraftSection {...props} draft={props.draft} /> : null}
      {props.message ? (
        <div role={props.message.kind === "error" ? "alert" : "status"}
          className={"text-sm " + (props.message.kind === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
          {props.message.text}
        </div>
      ) : null}
    </div>
  );
}
