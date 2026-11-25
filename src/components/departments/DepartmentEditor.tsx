import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  REMOVED_PERSON_LABEL,
  checkDepartmentName,
  checkDepartmentReason,
  formatDepartmentInstant,
  type DepartmentControl,
  type DepartmentPersonRow,
  type DepartmentRow,
} from "@/lib/domain/departments";
import {
  checkSwitchIntent,
  openSwitchIntent,
  type DepartmentAdminStatus,
  type SwitchIntent,
  type SwitchIntentCheck,
} from "@/lib/departments/adminState";

/**
 * F5 departments: presentation only. Everything here is driven by props so
 * it can be rendered in tests without a database. The container
 * (DepartmentsCard) owns the data and the requests.
 *
 * All text from the database is rendered as text by React (escaped).
 */

export interface ListState<T> {
  status: "loading" | "error" | "ready";
  rows: T[];
  message?: string | null;
}

/** A list read one page at a time ("Load more"). */
export interface PagedState<T> extends ListState<T> {
  hasMore: boolean;
  loadingMore: boolean;
}

export interface ChangeBannerProps {
  status: DepartmentAdminStatus;
  message: string | null;
  onRetry: () => void;
  onDismiss: () => void;
}

/** What happened to the last change. Never says "saved" before the server did. */
export function ChangeBanner({ status, message, onRetry, onDismiss }: ChangeBannerProps) {
  if (status === "idle") return null;
  const tone =
    status === "done" ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
    : status === "submitting" ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
    : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100";
  return (
    <div role={status === "submitting" || status === "done" ? "status" : "alert"} aria-live="polite"
         className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm ${tone}`}>
      <span className="flex-1">
        {status === "submitting" && "Saving\u2026"}
        {status === "done" && "Saved."}
        {status === "unknown" && (
          <>
            <strong>Not confirmed.</strong> {message ?? "No clear answer from the server."} Your entry is kept. Retry sends
            the same request again, so it cannot be applied twice.
          </>
        )}
        {status === "conflict" && (
          <>
            <strong>Not saved.</strong> {message ?? "Someone else changed this first."} The lists below have been
            refreshed. Check them, then apply your change again if it is still right.
          </>
        )}
        {status === "error" && (
          <>
            <strong>Not saved.</strong> {message ?? "The change was refused."}
          </>
        )}
      </span>
      {status === "unknown" && <Button size="sm" onClick={onRetry}>Retry</Button>}
      {status !== "submitting" && (
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {status === "unknown" ? "Give up (it may have been saved)" : "Dismiss"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Departments list
// ---------------------------------------------------------------------------

export interface DepartmentsViewProps {
  location: string;
  showArchived: boolean;
  departments: ListState<DepartmentRow>;
  /** Members of the department whose archive was refused, or being inspected. */
  membersOf: string | null;
  members: PagedState<DepartmentPersonRow>;
  onLoadMoreMembers: () => void;
  busy: boolean;
  onToggleArchived: (show: boolean) => void;
  onCreate: (name: string) => void;
  onRename: (department: DepartmentRow, name: string) => void;
  onArchive: (department: DepartmentRow) => void;
  onRestore: (department: DepartmentRow) => void;
  onShowMembers: (departmentId: string | null) => void;
  /** Test hook: start with this department in rename mode. */
  initialRenaming?: string | null;
  /** Test hook: start with this text in the create box. */
  initialCreateName?: string;
}

/** "  Department   A  " -> will be saved as "Department A". */
export function NamePreview({ raw }: { raw: string }) {
  if (raw.trim() === "") return null;
  const check = checkDepartmentName(raw);
  if (!check.ok) return <p className="text-xs text-red-600 dark:text-red-400" role="alert">{check.error}</p>;
  if (check.name === raw) return null;
  return (
    <p className="text-xs text-slate-500">
      Will be saved as <span className="font-medium text-slate-800 dark:text-slate-200">{"\u201C"}{check.name}{"\u201D"}</span>
    </p>
  );
}

export function DepartmentsView(props: DepartmentsViewProps) {
  const { departments, showArchived, busy, location } = props;
  const [createName, setCreateName] = useState(props.initialCreateName ?? "");
  const [renaming, setRenaming] = useState<string | null>(props.initialRenaming ?? null);
  const [renameText, setRenameText] = useState("");

  const createCheck = checkDepartmentName(createName);
  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    if (!createCheck.ok || busy) return;
    props.onCreate(createName);
  };

  return (
    <section aria-labelledby="f5-departments-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="f5-departments-heading" className="text-sm font-semibold">
          {showArchived ? "Archived departments" : "Departments"}
        </h3>
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={showArchived} onChange={(e) => props.onToggleArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {!showArchived && (
        <form onSubmit={submitCreate} className="space-y-1" aria-label="Create a department">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[14rem] text-xs font-medium text-slate-600 dark:text-slate-300">
              New department name
              <Input value={createName} maxLength={200} onChange={(e) => setCreateName(e.target.value)}
                     placeholder="For example: Department A" autoComplete="off" />
            </label>
            <Button type="submit" disabled={busy || !createCheck.ok}>Create department</Button>
          </div>
          <NamePreview raw={createName} />
        </form>
      )}

      {departments.status === "loading" && <p className="text-sm text-slate-500" role="status">Loading departments{"\u2026"}</p>}
      {departments.status === "error" && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          Couldn{"\u2019"}t load departments: {departments.message ?? "unknown error"}. Nothing is shown rather than an incomplete list.
        </p>
      )}
      {departments.status === "ready" && departments.rows.length === 0 && (
        <p className="text-sm text-slate-500">
          {showArchived ? "No archived departments." : "No departments yet. Create the first one above."}
        </p>
      )}

      {departments.status === "ready" && departments.rows.length > 0 && (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md ring-1 ring-slate-200 dark:ring-slate-800">
          {departments.rows.map((d) => {
            const isRenaming = renaming === d.id;
            const renameCheck = checkDepartmentName(renameText);
            return (
              <li key={d.id} className="p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 min-w-[10rem] text-sm font-medium">{d.name}</span>
                  <span className="text-xs text-slate-500">
                    {d.member_count} {d.member_count === 1 ? "person" : "people"}
                  </span>
                  {d.archived_at ? (
                    <>
                      <span className="text-xs text-slate-500">Archived {formatDepartmentInstant(d.archived_at, location)}</span>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => props.onRestore(d)}
                              aria-label={`Restore ${d.name}`}>Restore</Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => props.onShowMembers(props.membersOf === d.id ? null : d.id)}
                              aria-expanded={props.membersOf === d.id} aria-label={`Members of ${d.name}`}>Members</Button>
                      <Button size="sm" variant="secondary" disabled={busy}
                              onClick={() => { setRenaming(isRenaming ? null : d.id); setRenameText(d.name); }}
                              aria-label={`Rename ${d.name}`}>Rename</Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => props.onArchive(d)}
                              aria-label={`Archive ${d.name}`}>Archive</Button>
                    </>
                  )}
                </div>

                {isRenaming && (
                  <form className="space-y-1" aria-label={`Rename ${d.name}`}
                        onSubmit={(e) => { e.preventDefault(); if (renameCheck.ok && !busy) props.onRename(d, renameText); }}>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex-1 min-w-[14rem] text-xs font-medium text-slate-600 dark:text-slate-300">
                        New name for {d.name}
                        <Input value={renameText} maxLength={200} onChange={(e) => setRenameText(e.target.value)} autoComplete="off" />
                      </label>
                      <Button type="submit" size="sm" disabled={busy || !renameCheck.ok}>Save name</Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                    </div>
                    <NamePreview raw={renameText} />
                    <p className="text-xs text-slate-500">
                      Takes effect now. Work already recorded keeps the name it had at the time.
                    </p>
                  </form>
                )}

                {props.membersOf === d.id && <MembersList members={props.members} location={location} onLoadMore={props.onLoadMoreMembers} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function MembersList({ members, location, onLoadMore }: {
  members: PagedState<DepartmentPersonRow>;
  location: string;
  onLoadMore: () => void;
}) {
  if (members.status === "loading") return <p className="text-xs text-slate-500" role="status">Loading members{"\u2026"}</p>;
  if (members.status === "error") {
    return <p className="text-xs text-red-600 dark:text-red-400" role="alert">Couldn{"\u2019"}t load members: {members.message ?? "unknown error"}</p>;
  }
  if (members.rows.length === 0) return <p className="text-xs text-slate-500">Nobody is in this department.</p>;
  return (
    <div className="rounded-md bg-slate-50 dark:bg-slate-800/50 p-2">
      <p className="text-xs text-slate-600 dark:text-slate-300 mb-1">
        Move these people to another department before archiving (People, below).
      </p>
      <ul className="text-xs space-y-0.5">
        {members.rows.map((m) => (
          <li key={m.person_id}>
            <span className="font-medium">{m.display_name ?? REMOVED_PERSON_LABEL}</span>
            <span className="text-slate-500"> {"\u00B7"} since {formatDepartmentInstant(m.valid_from, location)}</span>
          </li>
        ))}
      </ul>
      {members.hasMore && (
        <Button size="sm" variant="ghost" disabled={members.loadingMore} onClick={onLoadMore}>
          {members.loadingMore ? "Loading..." : "Load more members"}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The event-snapshot switch (small on purpose: no health panel in F5)
// ---------------------------------------------------------------------------

export interface SnapshotSwitchProps {
  location: string;
  control: { status: "loading" | "error" | "ready"; value: DepartmentControl | null; message?: string | null };
  busy: boolean;
  /**
   * What the owner asked for, frozen when the confirmation was opened. Null
   * when no confirmation is open. It is owned by the container, which clears
   * it once the server has confirmed the change.
   */
  intent: SwitchIntent | null;
  onOpen: (intent: SwitchIntent) => void;
  onClose: () => void;
  /** Sends exactly the frozen intent, never a value recomputed from a later read. */
  onSet: (intent: SwitchIntent, reason: string) => void;
  /** Test hook. */
  initialReason?: string;
}

export function SnapshotSwitch({ control, busy, location, intent, onOpen, onClose, onSet, initialReason }: SnapshotSwitchProps) {
  if (control.status === "loading") return <p className="text-sm text-slate-500" role="status">Loading the switch{"\u2026"}</p>;
  if (control.status === "error" || !control.value) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400" role="alert">
        Couldn{"\u2019"}t read the switch: {control.message ?? "unknown error"}. Its state is unknown, not off.
      </p>
    );
  }
  const current = control.value;
  const { enabled, tracking_started_at } = current;

  return (
    <section aria-labelledby="f5-switch-heading" className="space-y-2">
      <h3 id="f5-switch-heading" className="text-sm font-semibold">Save the department on new work</h3>
      <p className="text-sm">
        Status:{" "}
        <strong className={enabled ? "text-emerald-700 dark:text-emerald-300" : "text-slate-700 dark:text-slate-200"}>
          {enabled ? "ON" : "OFF"}
        </strong>
        <span className="text-slate-500">
          {" "}{"\u00B7"} {enabled
            ? "each new scan keeps the worker\u2019s home department at that moment."
            : "new scans are saved without a department. Scanning itself is not affected."}
        </span>
      </p>
      <p className="text-xs text-slate-500">
        Tracking started {formatDepartmentInstant(tracking_started_at, location)}. Work recorded before that, or while
        this is off, stays {"\u201C"}unknown{"\u201D"} and is never filled in later.
      </p>
      {intent === null ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpen(openSwitchIntent(current))}>
          {enabled ? "Turn off\u2026" : "Turn on\u2026"}
        </Button>
      ) : (
        <SwitchConfirmation
          // A new confirmation starts with an empty reason.
          key={`${intent.target}:${intent.expectedVersion}`}
          intent={intent}
          check={checkSwitchIntent(intent, current)}
          busy={busy}
          onSet={onSet}
          onClose={onClose}
          initialReason={initialReason}
        />
      )}
    </section>
  );
}

function SwitchConfirmation({ intent, check, busy, onSet, onClose, initialReason }: {
  intent: SwitchIntent;
  check: SwitchIntentCheck;
  busy: boolean;
  onSet: (intent: SwitchIntent, reason: string) => void;
  onClose: () => void;
  initialReason?: string;
}) {
  const [reason, setReason] = useState(initialReason ?? "");
  const reasonCheck = checkDepartmentReason(reason, true);
  const wanted = intent.target ? "ON" : "OFF";

  // The switch is no longer what the owner was looking at. The confirmation
  // never turns into its opposite: it can only be closed.
  if (check !== "ready") {
    return (
      <div className="space-y-2 rounded-md ring-1 ring-amber-300 dark:ring-amber-700 p-3" role="alert" aria-label="Confirm the switch">
        <p className="text-sm font-medium">
          {check === "already_done"
            ? `The switch is already ${wanted}. There is nothing left to confirm.`
            : `The switch was changed by someone else while this was open. Nothing was sent. Close this and start again if you still want it ${wanted}.`}
        </p>
        {check === "already_done" && (
          <p className="text-xs text-slate-600 dark:text-slate-300">
            If a message above says your change was not confirmed, use its Retry: it re-sends the same request and
            cannot switch it back.
          </p>
        )}
        <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    );
  }

  return (
    <form className="space-y-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 p-3" aria-label="Confirm the switch"
          onSubmit={(e) => { e.preventDefault(); if (reasonCheck.ok && !busy) onSet(intent, reason); }}>
      <p className="text-sm font-medium">
        {intent.target
          ? "Turn ON? From now on every new scan saves the worker\u2019s home department."
          : "Turn OFF? New scans will be saved without a department until this is turned on again. Those scans stay unknown."}
      </p>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        Reason (required, kept in the audit log)
        <Input value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} autoComplete="off" />
      </label>
      {reason !== "" && !reasonCheck.ok && <p className="text-xs text-red-600" role="alert">{reasonCheck.error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant={intent.target ? "primary" : "danger"} disabled={busy || !reasonCheck.ok}>
          {intent.target ? "Yes, turn on" : "Yes, turn off"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </form>
  );
}
