import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeBanner, MembersList, SnapshotSwitch, type SnapshotSwitchProps } from "@/components/departments/DepartmentEditor";
import { DepartmentPeopleView } from "@/components/departments/DepartmentPeople";
import { DepartmentsGate } from "@/components/departments/DepartmentsCard";
import {
  acceptsDepartmentAnswer,
  checkSwitchIntent,
  departmentAdminReducer,
  departmentPayloadKey,
  departmentsOwnerId,
  initialDepartmentAdminState,
  openSwitchIntent,
  type DepartmentAdminState,
  type SwitchIntent,
} from "@/lib/departments/adminState";
import type { DepartmentChange } from "@/lib/departments/client";
import type { DepartmentPersonRow } from "@/lib/domain/departments";
import { ASSIGN_A, DEPT_A, OWNER_1, PERSON_1, PERSON_2, REQUEST_1, REQUEST_2 } from "../fixtures/departments";

/**
 * Regressions for review r1 (docs/reviews/departments-r1.md).
 *
 * P1: the owner panel must belong to the LIVE session. AuthProvider keeps
 *     account A's profile for a moment after the session has become B's.
 * P2: an open switch confirmation must never turn into its opposite.
 */

const noop = () => {};
const OWNER_A = OWNER_1;
const OWNER_B = "f5000000-0000-4000-8000-0000000000f2";
const ownerA = { user_id: OWNER_A, role: "owner" };
const ownerB = { user_id: OWNER_B, role: "owner" };

const gate = (sessionUserId: string | null, profile: { user_id: string; role: string } | null) =>
  renderToStaticMarkup(
    <DepartmentsGate backend="supabase" sessionUserId={sessionUserId} profile={profile}>
      {(id) => <p>PANEL OF {id}</p>}
    </DepartmentsGate>,
  );

describe("P1: the panel belongs to the live session", () => {
  it("allows the panel only when the loaded profile is the session's own owner profile", () => {
    expect(departmentsOwnerId(OWNER_A, ownerA)).toBe(OWNER_A);
    expect(departmentsOwnerId(OWNER_B, ownerA)).toBeNull(); // B signed in, A's profile still loaded
    expect(departmentsOwnerId(PERSON_1, ownerA)).toBeNull();
    expect(departmentsOwnerId(null, ownerA)).toBeNull(); // signed out, profile not cleared yet
    expect(departmentsOwnerId(OWNER_A, null)).toBeNull();
    expect(departmentsOwnerId(OWNER_A, { user_id: OWNER_A, role: "manager" })).toBeNull();
  });

  it("A -> non-owner: hides A's panel the moment the session changes, before B's profile arrives", () => {
    expect(gate(OWNER_A, ownerA)).toContain(`PANEL OF ${OWNER_A}`);
    // Session is now Person 1's; AuthProvider still holds A's profile.
    expect(gate(PERSON_1, ownerA)).toBe("");
    // Person 1's (staff) profile arrives: still nothing.
    expect(gate(PERSON_1, { user_id: PERSON_1, role: "staff" })).toBe("");
  });

  it("A -> another owner: nothing is shown until B's own profile is loaded, then B's panel", () => {
    expect(gate(OWNER_B, ownerA)).toBe("");
    expect(gate(OWNER_B, ownerB)).toContain(`PANEL OF ${OWNER_B}`);
    expect(gate(OWNER_B, ownerB)).not.toContain(OWNER_A);
  });

  it("keys the panel by the owner, so changing owner remounts it instead of re-rendering it", () => {
    const element = (sessionUserId: string, profile: typeof ownerA) =>
      DepartmentsGate({ backend: "supabase", sessionUserId, profile, children: (id) => <p>{id}</p> }) as ReactElement;
    const a = element(OWNER_A, ownerA);
    const b = element(OWNER_B, ownerB);
    expect(isValidElement(a) && isValidElement(b)).toBe(true);
    expect(a.key).toBe(OWNER_A);
    expect(b.key).toBe(OWNER_B);
    // Different keys at the same position: React unmounts A's subtree (its
    // lists, open forms, pending request and Retry) and mounts a fresh one.
    expect(a.key).not.toBe(b.key);
  });

  it("discards an answer that arrives after the account changed or the panel went away", () => {
    expect(acceptsDepartmentAnswer(true, OWNER_A, OWNER_A)).toBe(true);
    expect(acceptsDepartmentAnswer(true, OWNER_A, OWNER_B)).toBe(false);
    expect(acceptsDepartmentAnswer(false, OWNER_A, OWNER_A)).toBe(false);
  });

  it("never carries A's unknown request or Retry into B's panel", () => {
    const change: DepartmentChange = { kind: "switch", enabled: true, expectedVersion: "4", reason: "A's reason" };
    // Owner A: submitted, no answer -> Retry is on offer in A's panel.
    let a: DepartmentAdminState<DepartmentChange> = initialDepartmentAdminState();
    a = departmentAdminReducer(a, { type: "submit", input: change, payloadKey: departmentPayloadKey(change), newRequestId: REQUEST_1 });
    a = departmentAdminReducer(a, { type: "failed", requestId: REQUEST_1, kind: "unknown", message: "no answer" });
    expect(a.status).toBe("unknown");
    expect(a.input).toEqual(change);

    // Owner B's panel is a new mount: it starts from the initial state.
    let b: DepartmentAdminState<DepartmentChange> = initialDepartmentAdminState();
    expect(b).toMatchObject({ status: "idle", pending: null, input: null, message: null });
    expect(renderToStaticMarkup(<ChangeBanner status={b.status} message={b.message} onRetry={noop} onDismiss={noop} />)).toBe("");

    // A's late answer reaching B's state changes nothing.
    b = departmentAdminReducer(b, { type: "succeeded", requestId: REQUEST_1 });
    expect(b.status).toBe("idle");
    b = departmentAdminReducer(b, { type: "failed", requestId: REQUEST_1, kind: "conflict", message: "stale" });
    expect(b).toMatchObject({ status: "idle", input: null, message: null });

    // If B then makes a change, it is B's own request id, not A's.
    b = departmentAdminReducer(b, { type: "submit", input: change, payloadKey: departmentPayloadKey(change), newRequestId: REQUEST_2 });
    expect(b.send?.requestId).toBe(REQUEST_2);
  });
});

describe("P2: the switch confirmation keeps the intent it was opened with", () => {
  const control = (enabled: boolean, version: string) => ({
    status: "ready" as const,
    value: { enabled, tracking_started_at: "2026-11-22T10:00:00+00:00", version, updated_at: "2026-11-22T10:00:00+00:00" },
  });
  const sw = (over: Partial<SnapshotSwitchProps>) =>
    renderToStaticMarkup(
      <SnapshotSwitch location="au" control={control(false, "4")} busy={false} intent={null}
        onOpen={noop} onClose={noop} onSet={noop} initialReason="Roster checked" {...over} />,
    );
  // Opened while OFF at version 4: the owner asked for ON.
  const intentOn: SwitchIntent = openSwitchIntent({ enabled: false, version: "4" });

  it("captures the target and version when the confirmation is opened", () => {
    expect(intentOn).toEqual({ target: true, expectedVersion: "4" });
    expect(openSwitchIntent({ enabled: true, version: "9" })).toEqual({ target: false, expectedVersion: "9" });
    expect(checkSwitchIntent(intentOn, { enabled: false, version: "4" })).toBe("ready");
  });

  it("while nothing has changed, offers exactly the confirmed action", () => {
    const html = sw({ intent: intentOn });
    expect(html).toContain("Turn ON?");
    expect(html).toContain("Yes, turn on");
    expect(html).not.toContain("Yes, turn off");
  });

  it("success: after ON is saved and re-read, the open form cannot submit OFF", () => {
    // The container closes the confirmation on success; even if a render
    // happens first with the fresh read, there is nothing to submit.
    expect(checkSwitchIntent(intentOn, { enabled: true, version: "5" })).toBe("already_done");
    const html = sw({ intent: intentOn, control: control(true, "5") });
    expect(html).toContain("The switch is already ON");
    expect(html).not.toContain("Turn OFF?");
    expect(html).not.toContain("Yes, turn off");
    expect(html).not.toContain('type="submit"');
    // Closed: back to the plain button for the NEXT, separately confirmed, action.
    expect(sw({ intent: null, control: control(true, "5") })).not.toContain('type="submit"');
  });

  it("lost reply, then a read that shows ON: Retry re-sends the original ON request, never OFF", () => {
    const change: DepartmentChange = { kind: "switch", enabled: intentOn.target, expectedVersion: intentOn.expectedVersion, reason: "Roster checked" };
    let state: DepartmentAdminState<DepartmentChange> = initialDepartmentAdminState();
    state = departmentAdminReducer(state, { type: "submit", input: change, payloadKey: departmentPayloadKey(change), newRequestId: REQUEST_1 });
    state = departmentAdminReducer(state, { type: "failed", requestId: REQUEST_1, kind: "unknown", message: "no answer" });

    // The refetch shows the change did land. The open confirmation is inert.
    const html = sw({ intent: intentOn, control: control(true, "5") });
    expect(html).toContain("The switch is already ON");
    expect(html).toContain("use its Retry");
    expect(html).not.toContain('type="submit"');

    // Retry (the banner) sends what was kept: same payload, same request id.
    expect(state.input).toEqual(change);
    const retry = departmentAdminReducer(state, { type: "submit", input: state.input!, payloadKey: departmentPayloadKey(state.input!), newRequestId: REQUEST_2 });
    expect(retry.send?.requestId).toBe(REQUEST_1);
    expect(retry.send?.input).toEqual({ kind: "switch", enabled: true, expectedVersion: "4", reason: "Roster checked" });
  });

  it("another owner turned it on meanwhile: nothing to confirm, and no opposite action", () => {
    expect(checkSwitchIntent(intentOn, { enabled: true, version: "5" })).toBe("already_done");
    expect(sw({ intent: intentOn, control: control(true, "5") })).not.toContain("Yes, turn off");
  });

  it("another owner toggled it twice: the confirmation is invalidated, not silently re-aimed", () => {
    // Still OFF, but not the OFF the owner was looking at.
    expect(checkSwitchIntent(intentOn, { enabled: false, version: "6" })).toBe("changed");
    const html = sw({ intent: intentOn, control: control(false, "6") });
    expect(html).toContain("changed by someone else");
    expect(html).toContain("Nothing was sent");
    expect(html).not.toContain('type="submit"');
    expect(html).toContain(">Close<");
  });

  it("never changes the captured intent, whatever is read later", () => {
    const frozen = { ...intentOn };
    for (const later of [{ enabled: true, version: "5" }, { enabled: false, version: "6" }, { enabled: false, version: "4" }]) {
      checkSwitchIntent(intentOn, later);
      expect(intentOn).toEqual(frozen);
    }
  });

  it("says plainly that giving up on an unconfirmed change may leave it saved", () => {
    const html = renderToStaticMarkup(<ChangeBanner status="unknown" message="no answer" onRetry={noop} onDismiss={noop} />);
    expect(html).toContain(">Retry<");
    expect(html).toContain("Give up (it may have been saved)");
  });
});

describe("people and members are read a page at a time", () => {
  const person = (id: string, name: string, home: boolean): DepartmentPersonRow => ({
    person_id: id, display_name: name, assignment_id: home ? ASSIGN_A : null, department_id: home ? DEPT_A : null,
    department_name: home ? "Department A" : null, valid_from: home ? "2026-11-22T10:00:00+00:00" : null,
  });
  const peopleHtml = (hasMore: boolean, loadingMore = false) =>
    renderToStaticMarkup(
      <DepartmentPeopleView
        location="au" people={{ status: "ready", rows: [person(PERSON_1, "Person 1", true), person(PERSON_2, "Person 2", false)], hasMore, loadingMore }}
        onLoadMorePeople={noop} departments={{ status: "ready", rows: [] }} selectedPersonId={null}
        history={{ status: "ready", rows: [], hasMore: false, loadingMore: false }} busy={false}
        onSelect={noop} onSubmit={noop} onLoadMoreHistory={noop}
      />,
    );

  it("offers Load more only while the server says there is another page", () => {
    expect(peopleHtml(true)).toContain("Load more people");
    expect(peopleHtml(false)).not.toContain("Load more people");
    expect(peopleHtml(true, true)).toMatch(/<button[^>]* disabled=""[^>]*>Loading/);
  });

  it("does not present a partial list as the whole team", () => {
    const partial = peopleHtml(true);
    expect(partial).toContain("Showing the first 2 accounts");
    expect(partial).not.toContain("Every account has a home department");
    expect(partial).not.toContain("1 of 2 accounts have no home department");
    expect(peopleHtml(false)).toContain("1 of 2 accounts have no home department");
  });

  it("pages the members of a department too", () => {
    const members = (hasMore: boolean) =>
      renderToStaticMarkup(
        <MembersList location="au" onLoadMore={noop}
          members={{ status: "ready", rows: [person(PERSON_1, "Person 1", true)], hasMore, loadingMore: false }} />,
      );
    expect(members(true)).toContain("Load more members");
    expect(members(false)).not.toContain("Load more members");
  });
});
