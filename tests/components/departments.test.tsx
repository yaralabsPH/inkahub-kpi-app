import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChangeBanner,
  DepartmentsView,
  MembersList,
  NamePreview,
  SnapshotSwitch,
  type DepartmentsViewProps,
  type SnapshotSwitchProps,
} from "@/components/departments/DepartmentEditor";
import { DepartmentsGate } from "@/components/departments/DepartmentsCard";
import type { DepartmentRow } from "@/lib/domain/departments";
import { ASSIGN_A, DEPT_A, DEPT_B, OWNER_1, PERSON_1 } from "../fixtures/departments";

// Rendered to static HTML (as the packaging tests do): this checks what is
// shown for each state. Clicks, focus and keyboard use are checked by hand
// on the staging Preview (Gate B).

const noop = () => {};
const dept = (over: Partial<DepartmentRow> = {}): DepartmentRow => ({
  id: DEPT_A, name: "Department A", version: "3", archived_at: null,
  created_at: "2026-11-20T00:00:00+00:00", updated_at: "2026-11-20T00:00:00+00:00", member_count: 2, ...over,
});

function view(over: Partial<DepartmentsViewProps> = {}): string {
  return renderToStaticMarkup(
    <DepartmentsView
      location="au" showArchived={false} departments={{ status: "ready", rows: [] }} membersOf={null}
      members={{ status: "ready", rows: [], hasMore: false, loadingMore: false }} onLoadMoreMembers={noop} busy={false} onToggleArchived={noop} onCreate={noop} onRename={noop}
      onArchive={noop} onRestore={noop} onShowMembers={noop} {...over}
    />,
  );
}

describe("backend and owner gates", () => {
  it("shows the Supabase notice in Dexie mode and never renders the data panel", () => {
    const html = renderToStaticMarkup(<DepartmentsGate backend="dexie" sessionUserId={OWNER_1} profile={{ user_id: OWNER_1, role: "owner" }}>{() => <p>DATA PANEL</p>}</DepartmentsGate>);
    expect(html).toContain("Department management requires Supabase");
    expect(html).not.toContain("DATA PANEL");
  });

  it("renders nothing at all for every non-owner role", () => {
    for (const role of ["manager", "staff", "kiosk", "cs"]) {
      expect(renderToStaticMarkup(
        <DepartmentsGate backend="supabase" sessionUserId={PERSON_1} profile={{ user_id: PERSON_1, role }}>{() => <p>DATA PANEL</p>}</DepartmentsGate>,
      )).toBe("");
    }
    expect(renderToStaticMarkup(
      <DepartmentsGate backend="supabase" sessionUserId={null} profile={null}>{() => <p>DATA PANEL</p>}</DepartmentsGate>,
    )).toBe("");
  });

  it("renders the data panel only for an owner on Supabase", () => {
    expect(renderToStaticMarkup(<DepartmentsGate backend="supabase" sessionUserId={OWNER_1} profile={{ user_id: OWNER_1, role: "owner" }}>{(id) => <p>DATA PANEL {id}</p>}</DepartmentsGate>)).toContain(`DATA PANEL ${OWNER_1}`);
  });

  it("does not load the Supabase client or any query when the gate is closed", async () => {
    vi.resetModules();
    const getSupabase = vi.fn(() => { throw new Error("getSupabase must not be called"); });
    vi.doMock("@/lib/repository/supabase/client", () => ({ getBackendMode: () => "dexie", getSupabase }));
    vi.doMock("@/lib/auth/AuthProvider", () => ({ useAuthOptional: () => null }));
    const { DepartmentsCard } = await import("@/components/departments/DepartmentsCard");
    const html = renderToStaticMarkup(<DepartmentsCard />);
    expect(html).toContain("Department management requires Supabase");
    expect(getSupabase).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/repository/supabase/client");
    vi.doUnmock("@/lib/auth/AuthProvider");
    vi.resetModules();
  });

  it("renders nothing for a signed-in manager without calling the client", async () => {
    vi.resetModules();
    const getSupabase = vi.fn(() => { throw new Error("getSupabase must not be called"); });
    vi.doMock("@/lib/repository/supabase/client", () => ({ getBackendMode: () => "supabase", getSupabase }));
    vi.doMock("@/lib/auth/AuthProvider", () => ({
      useAuthOptional: () => ({
        session: { user: { id: PERSON_1 } },
        profile: { user_id: PERSON_1, display_name: "Manager", role: "manager", allowed_nav: null },
      }),
    }));
    const { DepartmentsCard } = await import("@/components/departments/DepartmentsCard");
    expect(renderToStaticMarkup(<DepartmentsCard />)).toBe("");
    expect(getSupabase).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/repository/supabase/client");
    vi.doUnmock("@/lib/auth/AuthProvider");
    vi.resetModules();
  });
});

describe("departments list", () => {
  it("says so when there are none yet", () => {
    expect(view()).toContain("No departments yet");
    expect(view({ showArchived: true })).toContain("No archived departments");
  });

  it("shows loading, and an error without pretending the list is empty", () => {
    expect(view({ departments: { status: "loading", rows: [] } })).toContain("Loading departments");
    const html = view({ departments: { status: "error", rows: [], message: "timeout" } });
    expect(html).toContain("load departments: timeout");
    expect(html).not.toContain("No departments yet");
    expect(html).toContain('role="alert"');
  });

  it("lists active departments with member counts and labelled actions", () => {
    const html = view({ departments: { status: "ready", rows: [dept(), dept({ id: DEPT_B, name: "Department B", member_count: 1 })] } });
    expect(html).toContain("Department A");
    expect(html).toContain("2 people");
    expect(html).toContain("1 person");
    expect(html).toContain('aria-label="Rename Department A"');
    expect(html).toContain('aria-label="Archive Department B"');
    expect(html).toContain('aria-label="Members of Department A"');
    expect(html).not.toContain("Restore");
  });

  it("offers only Restore on an archived department, with the time in the site's zone", () => {
    const html = view({
      showArchived: true,
      departments: { status: "ready", rows: [dept({ archived_at: "2026-11-22T10:00:00+00:00", member_count: 0 })] },
    });
    expect(html).toContain('aria-label="Restore Department A"');
    expect(html).toContain("Archived 22 Nov 2026, 21:00 (Australia/Sydney)");
    expect(html).not.toContain('aria-label="Archive Department A"');
    expect(html).not.toContain("Create department");
  });

  it("disables every change while one is being saved", () => {
    const html = view({ busy: true, departments: { status: "ready", rows: [dept()] }, initialCreateName: "Department C" });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const changing = buttons.filter((b) => /Rename|Archive/.test(b) || b.includes('type="submit"'));
    expect(changing.length).toBe(3);
    for (const b of changing) expect(b).toContain(' disabled=""');
  });

  it("escapes names that look like markup", () => {
    const html = view({ departments: { status: "ready", rows: [dept({ name: '<img src=x onerror="alert(1)">' })] } });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("explains in the rename form that recorded work keeps its old name", () => {
    const html = view({ departments: { status: "ready", rows: [dept()] }, initialRenaming: DEPT_A });
    expect(html).toContain("New name for Department A");
    expect(html).toContain("Work already recorded keeps the name it had at the time");
  });
});

describe("name preview", () => {
  it("shows the normalized name before saving", () => {
    const html = renderToStaticMarkup(<NamePreview raw={"  Department   A  "} />);
    expect(html).toContain("Will be saved as");
    expect(html).toContain("Department A");
  });

  it("shows nothing when the name is already normal or empty", () => {
    expect(renderToStaticMarkup(<NamePreview raw="Department A" />)).toBe("");
    expect(renderToStaticMarkup(<NamePreview raw="   " />)).toBe("");
  });

  it("explains a refused name", () => {
    expect(renderToStaticMarkup(<NamePreview raw={"x".repeat(81)} />)).toContain("at most 80 characters");
    expect(renderToStaticMarkup(<NamePreview raw={"Dept\tA"} />)).toContain("control characters");
  });

  it("starts the create box with the kept input and enables Create only for a valid name", () => {
    expect(view({ initialCreateName: "Department C" })).toMatch(/value="Department C"/);
    expect(view({ initialCreateName: "" })).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(view({ initialCreateName: "Department C" })).not.toMatch(/<button type="submit"[^>]* disabled=""/);
  });
});

describe("members of a department (archive refused)", () => {
  const member = { person_id: PERSON_1, display_name: "Person 1", assignment_id: ASSIGN_A, department_id: DEPT_A, department_name: "Department A", valid_from: "2026-11-22T10:00:00+00:00" };

  it("lists who must be moved first", () => {
    const html = view({ departments: { status: "ready", rows: [dept()] }, membersOf: DEPT_A, members: { status: "ready", rows: [member], hasMore: false, loadingMore: false } });
    expect(html).toContain("Person 1");
    expect(html).toContain("Move these people to another department before archiving");
  });

  it("shows a removed person by a fixed label, never an id or a guess", () => {
    const html = renderToStaticMarkup(<MembersList location="au" onLoadMore={noop} members={{ status: "ready", rows: [{ ...member, display_name: null }], hasMore: false, loadingMore: false }} />);
    expect(html).toContain("Removed person");
    expect(html).not.toContain(PERSON_1);
  });

  it("shows loading, error and empty states", () => {
    expect(renderToStaticMarkup(<MembersList location="au" onLoadMore={noop} members={{ status: "loading", rows: [], hasMore: false, loadingMore: false }} />)).toContain("Loading members");
    expect(renderToStaticMarkup(<MembersList location="au" onLoadMore={noop} members={{ status: "error", rows: [], message: "x", hasMore: false, loadingMore: false }} />)).toContain("load members");
    expect(renderToStaticMarkup(<MembersList location="au" onLoadMore={noop} members={{ status: "ready", rows: [], hasMore: false, loadingMore: false }} />)).toContain("Nobody is in this department");
  });
});

describe("change banner", () => {
  const banner = (status: Parameters<typeof ChangeBanner>[0]["status"], message: string | null = null) =>
    renderToStaticMarkup(<ChangeBanner status={status} message={message} onRetry={noop} onDismiss={noop} />);

  it("shows nothing when idle", () => {
    expect(banner("idle")).toBe("");
  });

  it("says Saving while in flight and Saved only when done", () => {
    expect(banner("submitting")).toContain("Saving");
    expect(banner("submitting")).not.toContain("Saved.");
    expect(banner("done")).toContain("Saved.");
  });

  it("offers Retry only when the outcome is unknown, and says the entry is kept", () => {
    const html = banner("unknown", "No clear answer from the server.");
    expect(html).toContain("Not confirmed");
    expect(html).toContain("Your entry is kept");
    expect(html).toContain("cannot be applied twice");
    expect(html).toContain(">Retry<");
    expect(html).toContain('role="alert"');
    expect(banner("error", "x")).not.toContain(">Retry<");
  });

  it("asks for a deliberate reapply after a conflict, with no Retry", () => {
    const html = banner("conflict", "Someone else changed this department. Refresh and try again.");
    expect(html).toContain("Not saved");
    expect(html).toContain("have been refreshed");
    expect(html).not.toContain(">Retry<");
  });

  it("shows why a change was refused", () => {
    expect(banner("error", "A department already has that name.")).toContain("A department already has that name.");
  });
});

describe("snapshot switch", () => {
  const control = (enabled: boolean) => ({
    status: "ready" as const,
    value: { enabled, tracking_started_at: "2026-11-22T10:00:00+00:00", version: "4", updated_at: "2026-11-22T10:00:00+00:00" },
  });
  const sw = (over: Partial<SnapshotSwitchProps> = {}) =>
    renderToStaticMarkup(<SnapshotSwitch location="uk" control={control(false)} busy={false} intent={null} onOpen={noop} onClose={noop} onSet={noop} {...over} />);

  it("shows OFF with what that means, and offers to turn on", () => {
    const html = sw();
    expect(html).toContain(">OFF<");
    expect(html).toContain("saved without a department");
    expect(html).toContain("Scanning itself is not affected");
    expect(html).toContain("Turn on");
    expect(html).toContain("Tracking started 22 Nov 2026, 10:00 (Europe/London)");
  });

  it("shows ON and offers to turn off", () => {
    const html = sw({ control: control(true) });
    expect(html).toContain(">ON<");
    expect(html).toContain("Turn off");
  });

  it("asks for explicit confirmation and a reason before changing", () => {
    const off = sw({ control: control(true), intent: { target: false, expectedVersion: "4" } });
    expect(off).toContain("Turn OFF?");
    expect(off).toContain("Reason (required");
    expect(off).toMatch(/<button type="submit"[^>]* disabled=""/);
    const ready = sw({ control: control(true), intent: { target: false, expectedVersion: "4" }, initialReason: "Wrong roster loaded" });
    expect(ready).not.toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(ready).toContain("Yes, turn off");
  });

  it("never reports an unreadable switch as off", () => {
    const html = sw({ control: { status: "error", value: null, message: "timeout" } });
    expect(html).toContain("Its state is unknown, not off");
    expect(html).not.toContain(">OFF<");
  });

  it("has no health panel", () => {
    expect(sw()).not.toMatch(/health|last 24|unknown rate/i);
  });
});
