import { Button } from "@/components/ui/Button";
import {
  NO_HOME_LABEL,
  REMOVED_PERSON_LABEL,
  formatDepartmentInstant,
  siteTimeZone,
  type DepartmentAuditRow,
  type DepartmentHistoryRow,
  type DepartmentPersonRow,
  type DepartmentRow,
} from "@/lib/domain/departments";
import type { ListState } from "./DepartmentEditor";
import { HomeDepartmentEditor, type HomeChange } from "./HomeDepartmentEditor";

/** A list read one page at a time. */
export interface PagedState<T> extends ListState<T> {
  hasMore: boolean;
  loadingMore: boolean;
}

export interface DepartmentPeopleViewProps {
  location: string;
  people: ListState<DepartmentPersonRow>;
  /** Active departments, for the picker. */
  departments: ListState<DepartmentRow>;
  selectedPersonId: string | null;
  history: PagedState<DepartmentHistoryRow>;
  busy: boolean;
  onSelect: (personId: string | null) => void;
  onSubmit: (change: HomeChange) => void;
  onLoadMoreHistory: () => void;
}

/**
 * Everyone who currently has a team profile, with their home department.
 * This is an account list: the app does not decide who is a "worker". People
 * without a home are shown as such, never given a guessed department.
 */
export function DepartmentPeopleView(props: DepartmentPeopleViewProps) {
  const { people, location, selectedPersonId, busy } = props;
  const without = people.rows.filter((p) => p.department_id === null).length;

  return (
    <section aria-labelledby="f5-people-heading" className="space-y-3">
      <div>
        <h3 id="f5-people-heading" className="text-sm font-semibold">People and home departments</h3>
        <p className="text-xs text-slate-500">
          One home department per person, the same at every site. Times are shown in {siteTimeZone(location)} (this site).
          Shared logins (for example a kiosk account) do not need one.
        </p>
      </div>

      {people.status === "loading" && <p className="text-sm text-slate-500" role="status">Loading people{"\u2026"}</p>}
      {people.status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          Couldn{"\u2019"}t load people: {people.message ?? "unknown error"}. Nothing is shown rather than an incomplete list.
        </p>
      )}
      {people.status === "ready" && people.rows.length === 0 && <p className="text-sm text-slate-500">No team members.</p>}

      {people.status === "ready" && people.rows.length > 0 && (
        <>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {without === 0
              ? "Every account has a home department."
              : `${without} of ${people.rows.length} accounts have no home department. Their work is still recorded, without a department.`}
          </p>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md ring-1 ring-slate-200 dark:ring-slate-800">
            {people.rows.map((p) => {
              const open = selectedPersonId === p.person_id;
              const name = p.display_name ?? REMOVED_PERSON_LABEL;
              return (
                <li key={p.person_id} className="p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex-1 min-w-[10rem] text-sm font-medium">{name}</span>
                    {p.department_id ? (
                      <span className="text-sm">
                        {p.department_name}
                        <span className="text-xs text-slate-500"> {"\u00B7"} since {formatDepartmentInstant(p.valid_from, location)}</span>
                      </span>
                    ) : (
                      <span className="text-sm text-amber-700 dark:text-amber-300">{NO_HOME_LABEL}</span>
                    )}
                    <Button size="sm" variant={open ? "ghost" : "secondary"} aria-expanded={open}
                            aria-label={open ? `Close ${name}` : `Home department and history for ${name}`}
                            onClick={() => props.onSelect(open ? null : p.person_id)}>
                      {open ? "Close" : p.department_id ? "Move / history" : "Assign"}
                    </Button>
                  </div>
                  {open && (
                    <div className="space-y-3">
                      <HomeDepartmentEditor
                        person={p}
                        departments={props.departments.rows}
                        busy={busy || props.departments.status !== "ready"}
                        onSubmit={props.onSubmit}
                        onCancel={() => props.onSelect(null)}
                      />
                      <DepartmentHistoryList history={props.history} location={location} onLoadMore={props.onLoadMoreHistory} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export function DepartmentHistoryList({ history, location, onLoadMore }: {
  history: PagedState<DepartmentHistoryRow>;
  location: string;
  onLoadMore: () => void;
}) {
  if (history.status === "loading") return <p className="text-xs text-slate-500" role="status">Loading history{"\u2026"}</p>;
  if (history.status === "error") {
    return <p className="text-xs text-red-600 dark:text-red-400" role="alert">Couldn{"\u2019"}t load history: {history.message ?? "unknown error"}</p>;
  }
  if (history.rows.length === 0) return <p className="text-xs text-slate-500">No home department history.</p>;
  return (
    <div>
      <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">History (newest first)</h4>
      <ol className="text-xs space-y-1">
        {history.rows.map((h) => (
          <li key={h.id}>
            <span className="font-medium">{h.department_name ?? "Unknown name"}</span>
            <span className="text-slate-500">
              {" "}{"\u00B7"} from {formatDepartmentInstant(h.valid_from, location)}
              {h.valid_to ? ` to ${formatDepartmentInstant(h.valid_to, location)}` : " \u2014 current"}
            </span>
            {h.reason !== "" && <span className="text-slate-500"> {"\u00B7"} reason: {h.reason}</span>}
          </li>
        ))}
      </ol>
      {history.hasMore && (
        <Button size="sm" variant="ghost" disabled={history.loadingMore} onClick={onLoadMore}>
          {history.loadingMore ? "Loading\u2026" : "Load older"}
        </Button>
      )}
    </div>
  );
}

const OPERATION_LABELS: Record<DepartmentAuditRow["operation"], string> = {
  create: "Created department",
  rename: "Renamed department",
  archive: "Archived department",
  restore: "Restored department",
  assign: "Gave a home department",
  transfer: "Moved to another department",
  correct: "Corrected a home department",
  remove: "Left the team (home closed)",
  control: "Changed the switch",
};

function auditDetail(row: DepartmentAuditRow): string {
  const pick = (data: unknown, key: string): string | null => {
    if (!data || typeof data !== "object") return null;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "boolean" ? String(value) : null;
  };
  if (row.operation === "rename") return `${pick(row.before_data, "name") ?? "?"} \u2192 ${pick(row.after_data, "name") ?? "?"}`;
  if (row.operation === "create") return pick(row.after_data, "name") ?? "";
  if (row.operation === "control") return pick(row.after_data, "enabled") === "true" ? "turned ON" : "turned OFF";
  return "";
}

export interface DepartmentAuditViewProps {
  location: string;
  open: boolean;
  audit: PagedState<DepartmentAuditRow>;
  onToggle: (open: boolean) => void;
  onLoadMore: () => void;
}

/** Who changed what and when. Read-only; nothing here can be edited or deleted. */
export function DepartmentAuditView({ location, open, audit, onToggle, onLoadMore }: DepartmentAuditViewProps) {
  return (
    <section aria-labelledby="f5-audit-heading" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id="f5-audit-heading" className="text-sm font-semibold">Change log</h3>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => onToggle(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
      </div>
      {open && audit.status === "loading" && <p className="text-sm text-slate-500" role="status">Loading the change log{"\u2026"}</p>}
      {open && audit.status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">Couldn{"\u2019"}t load the change log: {audit.message ?? "unknown error"}</p>
      )}
      {open && audit.status === "ready" && audit.rows.length === 0 && <p className="text-sm text-slate-500">No changes yet.</p>}
      {open && audit.status === "ready" && audit.rows.length > 0 && (
        <>
          <ol className="text-xs space-y-1">
            {audit.rows.map((a) => {
              const actor = a.actor_name ?? (a.actor_id ? REMOVED_PERSON_LABEL : "No signed-in user (server)");
              const person = a.person_id ? (a.person_name ?? REMOVED_PERSON_LABEL) : null;
              const detail = auditDetail(a);
              return (
                <li key={a.id}>
                  <span className="text-slate-500">{formatDepartmentInstant(a.recorded_at, location)} {"\u00B7"} </span>
                  <span className="font-medium">{OPERATION_LABELS[a.operation]}</span>
                  {detail !== "" && <span> {"\u00B7"} {detail}</span>}
                  {person && <span> {"\u00B7"} {person}</span>}
                  <span className="text-slate-500"> {"\u00B7"} by {actor}</span>
                  {a.reason !== "" && !a.reason.startsWith("profile_removed") && <span className="text-slate-500"> {"\u00B7"} reason: {a.reason}</span>}
                </li>
              );
            })}
          </ol>
          {audit.hasMore && (
            <Button size="sm" variant="ghost" disabled={audit.loadingMore} onClick={onLoadMore}>
              {audit.loadingMore ? "Loading\u2026" : "Load older"}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
