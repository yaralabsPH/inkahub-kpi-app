import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { PACKING_POINTS, type PackingPoint, type PieceGroup, type PieceKind } from "@/lib/domain/packaging/contents";
import { runExample } from "@/lib/domain/packaging/evaluate";
import {
  KIND_LABEL,
  KIND_OPTIONS,
  POINT_LABEL,
  SIZE_OPTIONS,
  addExample,
  describeGroup,
  describePackages,
  exampleFromSimulation,
  exampleIssues,
  removeExample,
  requiredCount,
  simulate,
  updateExample,
  usableContents,
  withKind,
} from "@/lib/domain/packaging/ruleEditing";
import type { PackagingExample, RuleSetBody } from "@/lib/domain/packaging/ruleSet";
import { PackageListEditor, type ChangeBody } from "./RuleEditor";

/**
 * F4 box-auto-pick: the examples table (worked cases every rule version must
 * get right before it can be activated) and the simulator (type a parcel,
 * see what the draft would pick). Both run the same evaluation the stations
 * use. Example parcels are typed by the owner or manager; none ship in code.
 */

type Size = (typeof SIZE_OPTIONS)[number];

function ContentsEditor(props: { name: string; contents: readonly PieceGroup[]; disabled: boolean; onChange: (contents: PieceGroup[]) => void }) {
  const { contents } = props;
  const set = (i: number, next: PieceGroup) => props.onChange(contents.map((g, j) => (j === i ? next : g)));
  return (
    <div className="space-y-1">
      {contents.map((g, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-20" type="number" min={1} aria-label={`Pieces in row ${i + 1} of ${props.name}`} value={g.pieces === 0 ? "" : g.pieces}
            disabled={props.disabled} onChange={(e) => set(i, { ...g, pieces: requiredCount(e.target.value) })} />
          <span className="text-xs text-slate-500">×</span>
          <Select className="w-24" aria-label={`Size in row ${i + 1} of ${props.name}`} value={g.size ?? ""} disabled={props.disabled || g.kind === "accessory"}
            onChange={(e) => set(i, { ...g, size: (e.target.value || null) as Size | null })}>
            {g.size === null ? <option value="">No size</option> : null}
            {SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Select className="w-44" aria-label={`Kind of item in row ${i + 1} of ${props.name}`} value={g.kind} disabled={props.disabled}
            onChange={(e) => set(i, withKind(g, e.target.value as PieceKind))}>
            {KIND_OPTIONS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </Select>
          <Button type="button" variant="secondary" size="sm" disabled={props.disabled}
            aria-label={`Remove row ${i + 1} from ${props.name}`} onClick={() => props.onChange(contents.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" disabled={props.disabled}
        onClick={() => props.onChange([...contents, { kind: "framed", size: "A1", pieces: 1 }])}>
        Add an item
      </Button>
    </div>
  );
}

function ExampleRow(props: { body: RuleSetBody; index: number; ready: boolean; busy: boolean; onChange: ChangeBody }) {
  const { body, index, busy } = props;
  const example = body.examples[index];
  const name = `example ${index + 1}`;
  const issues = exampleIssues(body, index);
  const patch = (p: Partial<PackagingExample>) => props.onChange((b) => updateExample(b, index, p));
  const result = props.ready && issues.length === 0 ? runExample(body, example) : null;
  const flagged = example.expect === "unresolved";
  const tag = "text-xs font-medium text-slate-600 dark:text-slate-300";

  return (
    <li className={"space-y-2 rounded-md p-3 ring-1 " + (issues.length > 0 || result?.pass === false ? "ring-red-300 dark:ring-red-800" : "ring-slate-200 dark:ring-slate-700")}
      data-example={example.id} data-result={result ? (result.pass ? "pass" : "fail") : "none"}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500 w-20">Example {index + 1}</span>
        <Input className="flex-1 min-w-40" aria-label={`Name of ${name}`} placeholder="Name, e.g. the order it came from" value={example.label ?? ""}
          disabled={busy} onChange={(e) => patch({ label: e.target.value })} />
        <Select className="w-36" aria-label={`Station for ${name}`} value={example.packing_point} disabled={busy}
          onChange={(e) => patch({ packing_point: e.target.value as PackingPoint })}>
          {PACKING_POINTS.map((p) => <option key={p} value={p}>{POINT_LABEL[p]}</option>)}
        </Select>
        <Button type="button" variant="secondary" size="sm" disabled={busy} aria-label={`Delete ${name}`}
          onClick={() => props.onChange((b) => removeExample(b, index))}>Delete</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className={tag}>The parcel holds</div>
          <ContentsEditor name={name} contents={example.contents} disabled={busy} onChange={(contents) => patch({ contents })} />
        </div>
        <div className="space-y-1">
          <div className={tag}>It should get</div>
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" disabled={busy} checked={flagged} aria-label={`${name} should be flagged`}
              onChange={() => patch({ expect: flagged ? [] : "unresolved" })} />
            Nothing automatic: the order should be flagged
          </label>
          {example.expect === "unresolved" ? null : (
            <PackageListEditor name={name} packages={example.expect} body={body} disabled={busy} onChange={(expect) => patch({ expect })} />
          )}
        </div>
      </div>

      {issues.length > 0 ? (
        <ul className="text-xs text-red-600 dark:text-red-400 list-disc pl-5" role="alert" data-example-issues={example.id}>
          {issues.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      ) : result ? (
        result.pass ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">Passes.</p>
        ) : (
          <p className="text-xs text-red-600 dark:text-red-400" role="alert">
            Fails. The rules give: {describePackages(result.actual, body)}. Expected: {describePackages(result.expected, body)}.
          </p>
        )
      ) : (
        <p className="text-xs text-slate-500">Fix the marked problems to see the result.</p>
      )}
    </li>
  );
}

export function ExamplesTable(props: { body: RuleSetBody; ready: boolean; busy: boolean; onChange: ChangeBody }) {
  const { body, busy } = props;
  return (
    <section className="space-y-2" data-section="examples">
      <h4 className="text-sm font-semibold">Examples</h4>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Real parcels and the packaging they should get. Every example must pass before a version can be activated, so a later
        rule change that breaks one is caught here and not at a station.
      </p>
      {body.examples.length === 0 ? <p className="text-sm text-slate-500">No examples yet. At least one is needed to activate.</p> : null}
      <ol className="space-y-2">
        {body.examples.map((e, i) => <ExampleRow key={`${e.id}-${i}`} body={body} index={i} ready={props.ready} busy={busy} onChange={props.onChange} />)}
      </ol>
      <div className="flex flex-wrap gap-2">
        {PACKING_POINTS.map((p) => (
          <Button key={p} type="button" variant="secondary" size="sm" disabled={busy} onClick={() => props.onChange((b) => addExample(b, p))}>
            Add a {POINT_LABEL[p]} example
          </Button>
        ))}
      </div>
    </section>
  );
}

export interface RuleSimulatorViewProps {
  body: RuleSetBody;
  /** False while the draft has problems: results would be misleading. */
  ready: boolean;
  busy: boolean;
  point: PackingPoint;
  contents: readonly PieceGroup[];
  onPoint: (point: PackingPoint) => void;
  onContents: (contents: PieceGroup[]) => void;
  onSaveExample: () => void;
}

export function RuleSimulatorView(props: RuleSimulatorViewProps) {
  const { body, point, contents } = props;
  const usable = usableContents(contents);
  const sim = props.ready && usable.length > 0 ? simulate(body, point, usable) : null;
  return (
    <section className="space-y-2" data-section="simulator">
      <h4 className="text-sm font-semibold">Try a parcel</h4>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Type what is in a parcel to see what these rules would pick. Nothing is saved or deducted.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        Station
        <Select className="w-36" aria-label="Station to try" value={point} disabled={props.busy} onChange={(e) => props.onPoint(e.target.value as PackingPoint)}>
          {PACKING_POINTS.map((p) => <option key={p} value={p}>{POINT_LABEL[p]}</option>)}
        </Select>
      </div>
      <ContentsEditor name="the trial parcel" contents={contents} disabled={props.busy} onChange={props.onContents} />

      {!props.ready ? (
        <p className="text-xs text-slate-500">Fix the marked problems to try a parcel.</p>
      ) : !sim ? (
        <p className="text-xs text-slate-500">Add at least one item with a piece count.</p>
      ) : (
        <div className="rounded-md bg-slate-50 dark:bg-slate-800/60 p-3 text-sm space-y-1" data-sim={sim.evaluation.status} aria-live="polite">
          {sim.evaluation.status === "resolved" ? (
            <div><span className="font-semibold">Picks:</span> {describePackages(sim.evaluation.packages, body)}</div>
          ) : (
            <div className="text-amber-700 dark:text-amber-400">
              <span className="font-semibold">Flagged, nothing deducted.</span> {sim.evaluation.reason}
            </div>
          )}
          <div className="text-xs text-slate-600 dark:text-slate-300">
            {sim.fired.length === 0
              ? "No rule fired."
              : `Rules that fired: ${sim.fired.map((f) => `Rule ${f.position}${f.label ? ` (${f.label})` : ""}`).join(", ")}.`}
          </div>
          {sim.evaluation.unassigned.length > 0 ? (
            <div className="text-xs text-slate-600 dark:text-slate-300">
              Not covered by any rule: {sim.evaluation.unassigned.map(describeGroup).join(", ")}.
            </div>
          ) : null}
          <Button type="button" variant="secondary" size="sm" disabled={props.busy} onClick={props.onSaveExample}>
            Keep this as an example
          </Button>
        </div>
      )}
    </section>
  );
}

/** The simulator with its own trial parcel; the parcel is never part of the draft. */
export function RuleSimulator(props: { body: RuleSetBody; ready: boolean; busy: boolean; onChange: ChangeBody }) {
  const [point, setPoint] = useState<PackingPoint>("dispatch");
  const [contents, setContents] = useState<PieceGroup[]>([{ kind: "framed", size: "A1", pieces: 1 }]);
  return (
    <RuleSimulatorView body={props.body} ready={props.ready} busy={props.busy} point={point} contents={contents}
      onPoint={setPoint} onContents={setContents}
      onSaveExample={() => props.onChange((b) => exampleFromSimulation(b, point, contents))} />
  );
}
