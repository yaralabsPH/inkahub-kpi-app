import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DepartmentAuditView,
  DepartmentHistoryList,
  DepartmentPeopleView,
  type DepartmentPeopleViewProps,
  type PagedState,
} from "@/components/departments/DepartmentPeople";
import { HomeDepartmentEditor, type HomeDepartmentEditorProps } from "@/components/departments/HomeDepartmentEditor";
import type { DepartmentAuditRow, DepartmentHistoryRow, DepartmentPersonRow, DepartmentRow } from "@/lib/domain/departments";
import { ASSIGN_A, ASSIGN_B, DEPT_A, DEPT_B, OWNER_1, PERSON_1, PERSON_2, REQUEST_1 } from "../fixtures/departments";

// Static-render tests of what each state shows. Clicking, typing and focus
// are checked by hand on the staging Preview (Gate B).

const noop = () => {};
const dept = (id: string, name: string, over: Partial<DepartmentRow> = {}): DepartmentRow => ({
  id, name, version: "1", archived_at: null, created_at: "2026-11-20T00:00:00+00:00",
  updated_at: "2026-11-20T00:00:00+00:00", member_count: 0, ...over,
});
const departments = [dept(DEPT_A, "Department A", { version: "4" }), dept(DEPT_B, "Department B", { version: "7" })];
const person1: DepartmentPersonRow = {
  person_id: PERSON_1, display_name: "Person 1", assignment_id: ASSIGN_A, department_id: DEPT_A,
  department_name: "Department A", valid_from: "2026-11-22T10:00:00+00:00",
};
const person2: DepartmentPersonRow = {
  person_id: PERSON_2, display_name: "Person 2", assignment_id: null, department_id: null, department_name: null, valid_from: null,
};
const emptyHistory: PagedState<DepartmentHistoryRow> = { status: "ready", rows: [], hasMore: false, loadingMore: false };

function people(over: Partial<DepartmentPeopleViewProps> = {}): string {
  return renderToStaticMarkup(
    <DepartmentPeopleView
      location="au" people={{ status: "ready", rows: [person1, person2] }} departments={{ status: "ready", rows: departments }}
      selectedPersonId={null} history={emptyHistory} busy={false} onSelect={noop} onSubmit={noop} onLoadMoreHistory={noop} {...over}
    />,
  );
}
function editor(over: Partial<HomeDepartmentEditorProps> = {}): string {
  return renderToStaticMarkup(
    <HomeDepartmentEditor person={person1} departments={departments} busy={false} onSubmit={noop} onCancel={noop} {...over} />,
  );
}

describe("people list", () => {
  it("shows each person's one home, and 'No home assigned' rather than a guess", () => {
    const html = people();
    expect(html).toContain("Person 1");
    expect(html).toContain("Department A");
    expect(html).toContain("since 22 Nov 2026, 21:00 (Australia/Sydney)");
    expect(html).toContain("No home assigned");
    expect(html).toContain("1 of 2 accounts have no home department");
    expect(html).toContain("Their work is still recorded, without a department");
  });

  it("states that the home is global and names this site's time zone", () => {
    expect(people()).toContain("the same at every site");
    expect(people({ location: "uk" })).toContain("Times are shown in Europe/London (this site)");
    // Same person viewed from another site: same home, that site's clock.
    expect(people({ location: "uk" })).toContain("Department A");
    expect(people({ location: "uk" })).toContain("since 22 Nov 2026, 10:00 (Europe/London)");
  });

  it("does not classify anyone as a worker or show roles, rates or emails", () => {
    const html = people();
    expect(html).toContain("Shared logins");
    expect(html).not.toMatch(/staff|manager|owner|kiosk<|hourly|rate|@/i);
  });

  it("says when everyone has a home", () => {
    expect(people({ people: { status: "ready", rows: [person1] } })).toContain("Every account has a home department");
  });

  it("shows loading, and an error without pretending the list is empty", () => {
    expect(people({ people: { status: "loading", rows: [] } })).toContain("Loading people");
    const html = people({ people: { status: "error", rows: [], message: "timeout" } });
    expect(html).toContain("load people: timeout");
    expect(html).not.toContain("No team members");
  });

  it("labels the action by what it does", () => {
    const html = people();
    expect(html).toContain('aria-label="Home department and history for Person 1"');
    expect(html).toContain(">Move / history<");
    expect(html).toContain(">Assign<");
  });

  it("opens the editor and history for the selected person only", () => {
    const html = people({ selectedPersonId: PERSON_2 });
    expect(html).toContain('aria-label="Home department for Person 2"');
    expect(html).not.toContain('aria-label="Home department for Person 1"');
    expect(html).toContain("No home department history");
  });

  it("shows nothing stale when the list changes to another account's data", () => {
    const other: DepartmentPersonRow = { ...person2, person_id: OWNER_1, display_name: "Someone Else" };
    const html = people({ people: { status: "ready", rows: [other] }, selectedPersonId: PERSON_1 });
    expect(html).not.toContain("Person 1");
    expect(html).not.toContain('aria-label="Home department for');
  });
});

describe("home department editor", () => {
  it("offers only other active departments and no way to clear or date the change", () => {
    const withArchived = [...departments, dept("f5000000-0000-4000-8000-00000000000c", "Department Old", { archived_at: "2026-11-21T00:00:00+00:00" })];
    const html = editor({ departments: withArchived });
    expect(html).toContain(">Department B</option>");
    expect(html).not.toContain(">Department A</option>");
    expect(html).not.toContain("Department Old");
    expect(html).not.toMatch(/type="date"|type="datetime-local"|Clear|Remove home|Unassign/);
  });

  it("requires a choice before it can be confirmed", () => {
    expect(editor()).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(editor({ initialDepartmentId: DEPT_B })).not.toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("spells out the move, that it is now, and that earlier work is not changed", () => {
    const html = editor({ initialDepartmentId: DEPT_B });
    expect(html).toContain("Confirm: move <strong>Person 1</strong> from <strong>Department A</strong> to <strong>Department B</strong>");
    expect(html).toContain("It takes effect now, at every site");
    expect(html).toContain("Earlier work keeps the department it had");
    expect(html).toContain("Confirm move");
  });

  it("requires a reason for a correction and says recorded work stays as it is", () => {
    const missing = editor({ initialDepartmentId: DEPT_B, initialCorrection: true });
    expect(missing).toContain("Reason (required)");
    expect(missing).toContain("Enter a reason.");
    expect(missing).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(missing).toContain("<strong>not</strong> changed");
    const ok = editor({ initialDepartmentId: DEPT_B, initialCorrection: true, initialReason: "Picked the wrong team" });
    expect(ok).not.toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(ok).toContain("Confirm correction");
  });

  it("refuses a reason over 500 characters", () => {
    const html = editor({ initialDepartmentId: DEPT_B, initialReason: "r".repeat(501) });
    expect(html).toContain("at most 500 characters");
    expect(html).toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("for a first assignment has no correction option", () => {
    const html = editor({ person: person2, initialDepartmentId: DEPT_A });
    expect(html).toContain("current home: </span><span class=\"font-medium\">No home assigned");
    expect(html).not.toContain("This fixes a mistake");
    expect(html).toContain("Confirm home department");
    expect(html).toContain("home department to <strong>Department A</strong>");
  });

  it("is disabled while another change is being saved", () => {
    expect(editor({ initialDepartmentId: DEPT_B, busy: true })).toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("says what to do when there is nowhere to move to", () => {
    expect(editor({ departments: [departments[0]] })).toContain("There is no other active department to move to");
    expect(editor({ person: person2, departments: [] })).toContain("Create a department first");
  });

  it("sends the versions the owner was looking at", () => {
    // The submit handler is exercised through its inputs: the option values
    // are department ids and the picked department's version travels with it.
    const html = editor({ initialDepartmentId: DEPT_B });
    expect(html).toContain(`<option value="${DEPT_B}" selected="">Department B</option>`);
  });
});

describe("history", () => {
  const rows: DepartmentHistoryRow[] = [
    { id: ASSIGN_B, person_id: PERSON_1, department_id: DEPT_B, department_name: "Department B", valid_from: "2026-11-22T10:00:00+00:00", valid_to: null, reason: "", created_by: OWNER_1, closed_by: null },
    { id: ASSIGN_A, person_id: PERSON_1, department_id: DEPT_A, department_name: "Department A", valid_from: "2026-11-20T00:00:00+00:00", valid_to: "2026-11-22T10:00:00+00:00", reason: "First team", created_by: OWNER_1, closed_by: OWNER_1 },
  ];
  const list = (h: PagedState<DepartmentHistoryRow>) =>
    renderToStaticMarkup(<DepartmentHistoryList history={h} location="au" onLoadMore={noop} />);

  it("shows adjacent intervals meeting at the transfer time, newest first", () => {
    const html = list({ status: "ready", rows, hasMore: false, loadingMore: false });
    expect(html.indexOf("Department B")).toBeLessThan(html.indexOf("Department A"));
    expect(html).toContain("from 22 Nov 2026, 21:00 (Australia/Sydney) \u2014 current");
    expect(html).toContain("to 22 Nov 2026, 21:00 (Australia/Sydney)");
    expect(html).toContain("reason: First team");
  });

  it("keeps the name each interval had, even after a rename", () => {
    const renamed = [{ ...rows[1], department_name: "Department A" }];
    expect(list({ status: "ready", rows: renamed, hasMore: false, loadingMore: false })).toContain("Department A");
  });

  it("offers older pages only when there are some", () => {
    expect(list({ status: "ready", rows, hasMore: true, loadingMore: false })).toContain("Load older");
    expect(list({ status: "ready", rows, hasMore: false, loadingMore: false })).not.toContain("Load older");
    expect(list({ status: "ready", rows, hasMore: true, loadingMore: true })).toMatch(/<button[^>]* disabled=""[^>]*>Loading/);
  });

  it("shows loading and error states", () => {
    expect(list({ status: "loading", rows: [], hasMore: false, loadingMore: false })).toContain("Loading history");
    expect(list({ status: "error", rows: [], message: "x", hasMore: false, loadingMore: false })).toContain("load history");
  });
});

describe("change log", () => {
  const row = (over: Partial<DepartmentAuditRow>): DepartmentAuditRow => ({
    id: REQUEST_1, request_id: REQUEST_1, operation: "create", actor_id: OWNER_1, actor_name: "Owner 1",
    department_id: DEPT_A, person_id: null, person_name: null, assignment_id: null,
    recorded_at: "2026-11-22T10:00:00+00:00", effective_at: "2026-11-22T10:00:00+00:00",
    before_data: null, after_data: { name: "Department A", version: 1 }, reason: "", ...over,
  });
  const log = (rows: DepartmentAuditRow[], open = true, extra: Partial<PagedState<DepartmentAuditRow>> = {}) =>
    renderToStaticMarkup(
      <DepartmentAuditView location="us" open={open} onToggle={noop} onLoadMore={noop}
        audit={{ status: "ready", rows, hasMore: false, loadingMore: false, ...extra }} />,
    );

  it("is collapsed until asked for", () => {
    const html = log([row({})], false);
    expect(html).toContain(">Show<");
    expect(html).not.toContain("Created department");
  });

  it("says who did what and when, in the site's zone", () => {
    const html = log([row({})]);
    expect(html).toContain("22 Nov 2026, 04:00 (America/Chicago)");
    expect(html).toContain("Created department");
    expect(html).toContain("Department A");
    expect(html).toContain("by Owner 1");
  });

  it("shows a rename as old name to new name", () => {
    const html = log([row({ operation: "rename", before_data: { name: "Department A" }, after_data: { name: "Department A2" } })]);
    expect(html).toContain("Department A \u2192 Department A2");
  });

  it("shows a correction with its reason and the person", () => {
    const html = log([row({ operation: "correct", person_id: PERSON_1, person_name: "Person 1", reason: "Picked the wrong team" })]);
    expect(html).toContain("Corrected a home department");
    expect(html).toContain("Person 1");
    expect(html).toContain("reason: Picked the wrong team");
  });

  it("shows a removed person and an unknown actor honestly", () => {
    const html = log([row({ operation: "remove", actor_id: null, actor_name: null, person_id: PERSON_1, person_name: null, reason: "profile_removed_actor_unavailable" })]);
    expect(html).toContain("Left the team (home closed)");
    expect(html).toContain("Removed person");
    expect(html).toContain("by No signed-in user (server)");
    expect(html).not.toContain("profile_removed_actor_unavailable");
    expect(html).not.toContain(PERSON_1);
  });

  it("shows the switch change", () => {
    expect(log([row({ operation: "control", department_id: null, after_data: { enabled: true, version: 2 }, reason: "Roster checked" })]))
      .toContain("Changed the switch</span><span> \u00B7 turned ON");
  });

  it("shows empty, loading, error and more-pages states", () => {
    expect(log([])).toContain("No changes yet");
    expect(log([], true, { status: "loading" })).toContain("Loading the change log");
    expect(log([], true, { status: "error", message: "x" })).toContain("load the change log");
    expect(log([row({})], true, { hasMore: true })).toContain("Load older");
  });

  it("has no edit or delete control", () => {
    expect(log([row({})])).not.toMatch(/Delete|Edit|Undo/);
  });
});

describe("no raw escape sequences leak into the page", () => {
  it("renders punctuation as characters", () => {
    const html = people({ selectedPersonId: PERSON_1 }) + editor({ initialDepartmentId: DEPT_B });
    expect(html).not.toMatch(/\\u[0-9A-Fa-f]{4}/);
  });
});
