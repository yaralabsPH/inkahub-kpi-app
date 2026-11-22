import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import type { DepartmentChange } from "@/lib/departments/client";
import type { DepartmentRow } from "@/lib/domain/departments";
import {
  useDepartmentChange,
  useDepartmentControl,
  useDepartmentPaged,
  useDepartmentRows,
  useDepartmentsSession,
} from "@/lib/hooks/useDepartments";
import { getBackendMode, type BackendMode } from "@/lib/repository/supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { ChangeBanner, DepartmentsView, SnapshotSwitch, type ListState } from "./DepartmentEditor";
import { DepartmentAuditView, DepartmentPeopleView, type PagedState } from "./DepartmentPeople";
import type { HomeChange } from "./HomeDepartmentEditor";

/**
 * F5 departments on the Team page.
 *
 * Three gates, in this order, before anything is requested:
 *   1. backend  - in Dexie mode show a notice and stop (no Supabase call)
 *   2. owner    - anyone else gets nothing: no controls, no reads
 *   3. data     - only now are the owner-only functions called
 */
export function DepartmentsCard() {
  const backend = getBackendMode();
  const auth = useAuthOptional();
  return (
    <DepartmentsGate backend={backend} role={auth?.profile?.role ?? null}>
      {auth?.profile ? <DepartmentsOwnerPanel callerId={auth.profile.user_id} /> : null}
    </DepartmentsGate>
  );
}

export interface DepartmentsGateProps {
  backend: BackendMode;
  role: string | null;
  children: React.ReactNode;
}

/** The backend and owner gates, separated so they can be tested without a client. */
export function DepartmentsGate({ backend, role, children }: DepartmentsGateProps) {
  if (backend !== "supabase") {
    return (
      <Card>
        <CardHeader><CardTitle>Departments</CardTitle></CardHeader>
        <CardBody>
          <p className="text-sm text-slate-600 dark:text-slate-300">Department management requires Supabase.</p>
          <p className="text-xs text-slate-500 mt-1">
            This copy of the app stores its data in the browser only, where there are no team accounts to assign.
          </p>
        </CardBody>
      </Card>
    );
  }
  if (role !== "owner") return null;
  return <>{children}</>;
}

function listState<T>(query: { isPending: boolean; isError: boolean; error: Error | null; data: T[] | undefined }): ListState<T> {
  if (query.isError) return { status: "error", rows: [], message: query.error?.message ?? null };
  if (query.isPending || !query.data) return { status: "loading", rows: [] };
  return { status: "ready", rows: query.data };
}

interface PagedQuery<T> {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data: { pages: Array<{ rows: T[] }> } | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

function pagedState<T>(query: PagedQuery<T>): PagedState<T> {
  const more = { hasMore: query.hasNextPage, loadingMore: query.isFetchingNextPage };
  if (query.isError) return { status: "error", rows: [], message: query.error?.message ?? null, ...more };
  if (query.isPending || !query.data) return { status: "loading", rows: [], ...more };
  return { status: "ready", rows: query.data.pages.flatMap((p) => p.rows), ...more };
}

function DepartmentsOwnerPanel({ callerId }: { callerId: string }) {
  useDepartmentsSession(callerId);
  const location = useAppStore((s) => s.location);
  const [showArchived, setShowArchived] = useState(false);
  const [membersOf, setMembersOf] = useState<string | null>(null);

  const active = useDepartmentRows(callerId, "departments_active");
  const archived = useDepartmentRows(callerId, "departments_archived", null, showArchived);
  const members = useDepartmentRows(callerId, "members", membersOf, membersOf !== null);
  const control = useDepartmentControl(callerId);
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const people = useDepartmentRows(callerId, "people");
  const history = useDepartmentPaged(callerId, "history", selectedPerson, selectedPerson !== null);
  const audit = useDepartmentPaged(callerId, "audit", null, showAudit);
  const change = useDepartmentChange(callerId);
  const busy = change.state.status === "submitting";

  const send = (c: DepartmentChange) => void change.submit(c);
  const admin = (args: Partial<Extract<DepartmentChange, { kind: "admin" }>["args"]> & { operation: Extract<DepartmentChange, { kind: "admin" }>["args"]["operation"] }) =>
    send({
      kind: "admin",
      args: { departmentId: null, personId: null, name: null, expectedVersion: null, expectedAssignmentId: null, reason: "", ...args },
    });

  const onArchive = async (d: DepartmentRow) => {
    const ok = await change.submit({
      kind: "admin",
      args: { operation: "archive", departmentId: d.id, personId: null, name: null, expectedVersion: d.version, expectedAssignmentId: null, reason: "" },
    });
    // Refused because people are still in it: show who.
    if (!ok) setMembersOf(d.id);
  };

  const onHomeChange = async (c: HomeChange) => {
    const ok = await change.submit({
      kind: "admin",
      args: {
        operation: c.operation, departmentId: c.departmentId, personId: c.personId, name: null,
        expectedVersion: c.expectedVersion, expectedAssignmentId: c.expectedAssignmentId, reason: c.reason,
      },
    });
    if (ok) setSelectedPerson(null);
  };

  // Also runs when the window regains focus (the app-wide query default), so
  // adding or removing a team member above is picked up without a callback.
  const refresh = () => {
    void active.refetch();
    void control.refetch();
    void people.refetch();
    if (selectedPerson) void history.refetch();
    if (showAudit) void audit.refetch();
    if (showArchived) void archived.refetch();
    if (membersOf) void members.refetch();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Departments</CardTitle>
        <span className="text-xs text-slate-500">
          Teams people belong to. Separate from station work types (Framed, A0 Framed, Unframed, Dispatch), which do not change.
        </span>
        <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
      </CardHeader>
      <CardBody className="space-y-5">
        <ChangeBanner
          status={change.state.status}
          message={change.state.message}
          onRetry={() => { if (change.state.input) send(change.state.input); }}
          onDismiss={change.reset}
        />

        <DepartmentsView
          location={location}
          showArchived={showArchived}
          departments={listState(showArchived ? archived : active)}
          membersOf={membersOf}
          members={listState(members)}
          busy={busy}
          onToggleArchived={(show) => { setShowArchived(show); setMembersOf(null); }}
          onCreate={(name) => admin({ operation: "create", name })}
          onRename={(d, name) => admin({ operation: "rename", departmentId: d.id, expectedVersion: d.version, name })}
          onArchive={(d) => void onArchive(d)}
          onRestore={(d) => admin({ operation: "restore", departmentId: d.id, expectedVersion: d.version })}
          onShowMembers={setMembersOf}
        />

        <DepartmentPeopleView
          location={location}
          people={listState(people)}
          departments={listState(active)}
          selectedPersonId={selectedPerson}
          history={pagedState(history)}
          busy={busy}
          onSelect={setSelectedPerson}
          onSubmit={(c) => void onHomeChange(c)}
          onLoadMoreHistory={() => void history.fetchNextPage()}
        />

        <SnapshotSwitch
          location={location}
          control={
            control.isError ? { status: "error", value: null, message: control.error?.message ?? null }
            : control.isPending || !control.data ? { status: "loading", value: null }
            : { status: "ready", value: control.data }
          }
          busy={busy}
          onSet={(enabled, reason, expectedVersion) => send({ kind: "switch", enabled, expectedVersion, reason })}
        />

        <DepartmentAuditView
          location={location}
          open={showAudit}
          audit={pagedState(audit)}
          onToggle={setShowAudit}
          onLoadMore={() => void audit.fetchNextPage()}
        />
      </CardBody>
    </Card>
  );
}
