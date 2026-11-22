import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { PACKING_POINTS, type PackingPoint } from "@/lib/domain/packaging/contents";
import {
  KIND_LABEL,
  KIND_OPTIONS,
  POINT_LABEL,
  SIZE_OPTIONS,
  addRule,
  moveRule,
  optionalCount,
  removeRule,
  requiredCount,
  ruleIssues,
  toggled,
  updateRule,
  withOutputMode,
} from "@/lib/domain/packaging/ruleEditing";
import { MAX_PACKAGE_LINES, MAX_PACKAGE_QTY, type PackageQty, type PackagingRule, type RuleSetBody } from "@/lib/domain/packaging/ruleSet";

/**
 * F4 box-auto-pick: the ordered list of packaging rules in a draft.
 * Presentational: every edit is handed up as a change to the draft body.
 * No rules are defined here; they are whatever the owner or manager types.
 */

export type ChangeBody = (change: (body: RuleSetBody) => RuleSetBody) => void;

function Ticks<T extends string>(props: {
  legend: string;
  options: readonly T[];
  labels?: Record<T, string>;
  selected: readonly T[];
  disabled: boolean;
  onToggle: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <legend className="sr-only">{props.legend}</legend>
      {props.options.map((o) => (
        <label key={o} className="inline-flex items-center gap-1">
          <input type="checkbox" disabled={props.disabled} checked={props.selected.includes(o)} onChange={() => props.onToggle(o)} />
          {props.labels ? props.labels[o] : o}
        </label>
      ))}
    </fieldset>
  );
}

/** A list of packaging items with quantities; shared with the examples table. */
export function PackageListEditor(props: {
  name: string;
  packages: readonly PackageQty[];
  body: RuleSetBody;
  disabled: boolean;
  onChange: (packages: PackageQty[]) => void;
}) {
  const { packages, body } = props;
  const known = new Set(body.catalogue.map((c) => c.key));
  const set = (i: number, patch: Partial<PackageQty>) => props.onChange(packages.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="space-y-1">
      {packages.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-20" type="number" min={1} max={MAX_PACKAGE_QTY} aria-label={`Quantity of package ${i + 1} for ${props.name}`}
            value={p.qty === 0 ? "" : p.qty} disabled={props.disabled} onChange={(e) => set(i, { qty: requiredCount(e.target.value) })} />
          <span className="text-xs text-slate-500">×</span>
          <Select className="w-56" aria-label={`Package ${i + 1} for ${props.name}`} value={p.key} disabled={props.disabled}
            onChange={(e) => set(i, { key: e.target.value })}>
            {p.key === "" ? <option value="">Choose a packaging item…</option> : null}
            {p.key !== "" && !known.has(p.key) ? <option value={p.key}>Missing item ({p.key})</option> : null}
            {body.catalogue.map((c) => <option key={c.key} value={c.key}>{c.label || c.key}</option>)}
          </Select>
          <Button type="button" variant="secondary" size="sm" disabled={props.disabled}
            aria-label={`Remove package ${i + 1} from ${props.name}`} onClick={() => props.onChange(packages.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {packages.length < MAX_PACKAGE_LINES ? (
        <Button type="button" variant="secondary" size="sm" disabled={props.disabled || body.catalogue.length === 0}
          onClick={() => props.onChange([...packages, { key: body.catalogue.find((c) => !packages.some((p) => p.key === c.key))?.key ?? "", qty: 1 }])}>
          Add a package
        </Button>
      ) : null}
    </div>
  );
}

function RuleRow(props: { body: RuleSetBody; index: number; busy: boolean; onChange: ChangeBody }) {
  const { body, index, busy } = props;
  const rule = body.rules[index];
  const name = `rule ${index + 1}`;
  const issues = ruleIssues(body, index);
  const patch = (p: Partial<PackagingRule>) => props.onChange((b) => updateRule(b, index, p));
  const fallbackKey = body.catalogue[0]?.key ?? "";
  const row = "grid grid-cols-1 md:grid-cols-12 gap-2 md:items-center";
  const tag = "md:col-span-3 text-xs font-medium text-slate-600 dark:text-slate-300";

  return (
    <li className={"space-y-2 rounded-md p-3 ring-1 " + (issues.length > 0 ? "ring-red-300 dark:ring-red-800" : "ring-slate-200 dark:ring-slate-700")}
      data-rule={rule.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500 w-14">Rule {index + 1}</span>
        <Input className="flex-1 min-w-40" aria-label={`Name of ${name}`} placeholder="Name, e.g. what this rule is for" value={rule.label ?? ""}
          disabled={busy} onChange={(e) => patch({ label: e.target.value })} />
        <Button type="button" variant="secondary" size="sm" disabled={busy || index === 0} aria-label={`Move ${name} up`}
          onClick={() => props.onChange((b) => moveRule(b, index, -1))}>Up</Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy || index === body.rules.length - 1} aria-label={`Move ${name} down`}
          onClick={() => props.onChange((b) => moveRule(b, index, 1))}>Down</Button>
        <Button type="button" variant="secondary" size="sm" disabled={busy} aria-label={`Delete ${name}`}
          onClick={() => props.onChange((b) => removeRule(b, index))}>Delete</Button>
      </div>

      <div className={row}>
        <span className={tag}>Station</span>
        <Select className="md:col-span-3" aria-label={`Station for ${name}`} value={rule.packing_point} disabled={busy}
          onChange={(e) => patch({ packing_point: e.target.value as PackingPoint })}>
          {PACKING_POINTS.map((p) => <option key={p} value={p}>{POINT_LABEL[p]}</option>)}
        </Select>
      </div>

      <div className={row}>
        <span className={tag}>Takes these items</span>
        <div className="md:col-span-9">
          <Ticks legend={`Kinds of item for ${name}`} options={KIND_OPTIONS} labels={KIND_LABEL} selected={rule.kinds} disabled={busy}
            onToggle={(k) => patch({ kinds: toggled(rule.kinds, k, KIND_OPTIONS) })} />
        </div>
      </div>

      <div className={row}>
        <span className={tag}>In these sizes <span className="font-normal text-slate-500">(none ticked = any)</span></span>
        <div className="md:col-span-9">
          <Ticks legend={`Sizes for ${name}`} options={SIZE_OPTIONS} selected={rule.sizes ?? []} disabled={busy}
            onToggle={(s) => patch({ sizes: toggled(rule.sizes, s, SIZE_OPTIONS) })} />
        </div>
      </div>

      <div className={row}>
        <span className={tag}>Only when the piece count is</span>
        <div className="md:col-span-9 flex flex-wrap items-center gap-2 text-xs">
          from
          <Input className="w-20" type="number" min={1} aria-label={`Lowest piece count for ${name}`} placeholder="any" value={rule.min_pieces ?? ""}
            disabled={busy} onChange={(e) => patch({ min_pieces: optionalCount(e.target.value) })} />
          to
          <Input className="w-20" type="number" min={1} aria-label={`Highest piece count for ${name}`} placeholder="any" value={rule.max_pieces ?? ""}
            disabled={busy} onChange={(e) => patch({ max_pieces: optionalCount(e.target.value) })} />
        </div>
      </div>

      <div className={row}>
        <span className={tag}>Only when the parcel includes <span className="font-normal text-slate-500">(optional)</span></span>
        <div className="md:col-span-9">
          <Ticks legend={`Sizes the parcel must include for ${name}`} options={SIZE_OPTIONS} selected={rule.contains_sizes ?? []} disabled={busy}
            onToggle={(s) => patch({ contains_sizes: toggled(rule.contains_sizes, s, SIZE_OPTIONS) })} />
        </div>
      </div>

      <div className={row + " md:items-start"}>
        <span className={tag}>Then use</span>
        <div className="md:col-span-9 space-y-2">
          <Select className="w-72" aria-label={`How ${name} picks packaging`} value={rule.output.mode} disabled={busy}
            onChange={(e) => patch({ output: withOutputMode(rule, e.target.value as "fixed" | "per_capacity", fallbackKey) })}>
            <option value="fixed">These packages, whatever the count</option>
            <option value="per_capacity">One package for every so many pieces</option>
          </Select>
          {rule.output.mode === "fixed" ? (
            <PackageListEditor name={name} packages={rule.output.packages} body={body} disabled={busy}
              onChange={(packages) => patch({ output: { mode: "fixed", packages } })} />
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              one
              <Select className="w-56" aria-label={`Package for ${name}`} value={rule.output.package} disabled={busy}
                onChange={(e) => patch({ output: { ...rule.output, package: e.target.value } as PackagingRule["output"] })}>
                {rule.output.package === "" ? <option value="">Choose a packaging item…</option> : null}
                {rule.output.package !== "" && !body.catalogue.some((c) => c.key === (rule.output as { package: string }).package)
                  ? <option value={rule.output.package}>Missing item ({rule.output.package})</option> : null}
                {body.catalogue.map((c) => <option key={c.key} value={c.key}>{c.label || c.key}</option>)}
              </Select>
              for every
              <Input className="w-20" type="number" min={1} max={500} aria-label={`Pieces per package for ${name}`}
                value={rule.output.capacity === 0 ? "" : rule.output.capacity} disabled={busy}
                onChange={(e) => patch({ output: { ...rule.output, capacity: requiredCount(e.target.value) } as PackagingRule["output"] })} />
              pieces (rounded up)
            </div>
          )}
        </div>
      </div>

      {issues.length > 0 ? (
        <ul className="text-xs text-red-600 dark:text-red-400 list-disc pl-5" role="alert" data-rule-issues={rule.id}>
          {issues.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

export function RuleEditor(props: { body: RuleSetBody; busy: boolean; onChange: ChangeBody }) {
  const { body, busy } = props;
  return (
    <section className="space-y-2" data-section="rules">
      <h4 className="text-sm font-semibold">Rules</h4>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        For each station the rules are tried from the top. A rule that fits takes all the items it covers, and the next rules
        only see what is left. If anything is left at the end, the order is flagged and nothing is deducted.
      </p>
      {body.rules.length === 0 ? <p className="text-sm text-slate-500">No rules yet.</p> : null}
      <ol className="space-y-2">
        {body.rules.map((r, i) => <RuleRow key={`${r.id}-${i}`} body={body} index={i} busy={busy} onChange={props.onChange} />)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {PACKING_POINTS.map((p) => (
          <Button key={p} type="button" variant="secondary" size="sm" disabled={busy} onClick={() => props.onChange((b) => addRule(b, p))}>
            Add a {POINT_LABEL[p]} rule
          </Button>
        ))}
      </div>
    </section>
  );
}
