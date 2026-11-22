import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import {
  NO_HOME_LABEL,
  checkDepartmentReason,
  type DepartmentPersonRow,
  type DepartmentRow,
} from "@/lib/domain/departments";

export interface HomeChange {
  personId: string;
  departmentId: string;
  /** Version of the target department the owner was looking at. */
  expectedVersion: string;
  /** The person's current open assignment the owner was looking at, or null. */
  expectedAssignmentId: string | null;
  operation: "assign" | "correct";
  reason: string;
}

export interface HomeDepartmentEditorProps {
  person: DepartmentPersonRow;
  /** Active departments only: nobody can be put into an archived one. */
  departments: DepartmentRow[];
  busy: boolean;
  onSubmit: (change: HomeChange) => void;
  onCancel: () => void;
  /** Test hooks. */
  initialDepartmentId?: string;
  initialCorrection?: boolean;
  initialReason?: string;
}

/**
 * Give a person a home department, or move them. There is no "clear" and no
 * date field: the server decides the time, which is now. A mistake is fixed
 * by moving them again with a reason; work already recorded is never changed.
 */
export function HomeDepartmentEditor(props: HomeDepartmentEditorProps) {
  const { person, departments, busy } = props;
  const [departmentId, setDepartmentId] = useState(props.initialDepartmentId ?? "");
  const [correction, setCorrection] = useState(props.initialCorrection ?? false);
  const [reason, setReason] = useState(props.initialReason ?? "");

  const hasHome = person.department_id !== null;
  const choices = departments.filter((d) => d.archived_at === null && d.id !== person.department_id);
  const target = choices.find((d) => d.id === departmentId) ?? null;
  const isCorrection = hasHome && correction;
  const reasonCheck = checkDepartmentReason(reason, isCorrection);
  const ready = target !== null && reasonCheck.ok;
  const name = person.display_name ?? "this person";

  return (
    <form
      aria-label={`Home department for ${name}`}
      className="space-y-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy || !target) return;
        props.onSubmit({
          personId: person.person_id,
          departmentId: target.id,
          expectedVersion: target.version,
          expectedAssignmentId: person.assignment_id,
          operation: isCorrection ? "correct" : "assign",
          reason,
        });
      }}
    >
      <p className="text-sm">
        <span className="font-medium">{name}</span>
        <span className="text-slate-500"> {"\u00B7"} current home: </span>
        <span className="font-medium">{person.department_name ?? NO_HOME_LABEL}</span>
      </p>

      {choices.length === 0 ? (
        <p className="text-sm text-slate-500">
          {departments.length === 0 ? "Create a department first." : "There is no other active department to move to."}
        </p>
      ) : (
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          {hasHome ? "Move to" : "Home department"}
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Choose a department{"\u2026"}</option>
            {choices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </label>
      )}

      {hasHome && (
        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" className="mt-0.5" checked={correction} onChange={(e) => setCorrection(e.target.checked)} />
          <span>
            This fixes a mistake (the current home was wrong). A reason is required. Work already recorded under the
            wrong department is <strong>not</strong> changed.
          </span>
        </label>
      )}

      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        Reason {isCorrection ? "(required)" : "(optional)"}
        <Input value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      </label>
      {!reasonCheck.ok && (reason !== "" || isCorrection) && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">{reasonCheck.error}</p>
      )}

      {target && (
        <p className="text-sm" role="status">
          {hasHome
            ? <>Confirm: move <strong>{name}</strong> from <strong>{person.department_name}</strong> to <strong>{target.name}</strong>.</>
            : <>Confirm: set <strong>{name}</strong>{"\u2019"}s home department to <strong>{target.name}</strong>.</>}
          {" "}It takes effect now, at every site. Earlier work keeps the department it had.
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !ready}>
          {hasHome ? (isCorrection ? "Confirm correction" : "Confirm move") : "Confirm home department"}
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
