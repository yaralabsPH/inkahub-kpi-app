import { describe, expect, it } from "vitest";
import { createBindingGeneration, wallTotalsAccess } from "../wallTotalsScope";

const base = { hasClient: true, site: "au", callerId: "kiosk-1", roleAllowed: true, role: "kiosk", siteMember: true };

describe("wallTotalsAccess (review r1 M2)", () => {
  it("site-wide role with confirmed membership only", () => {
    expect(wallTotalsAccess(base)).toBe(true);
    for (const role of ["owner", "manager", "kiosk"]) expect(wallTotalsAccess({ ...base, role }), role).toBe(true);
  });

  it("no membership, a non-site-wide role, a disallowed operator, no caller, no client or an unsupported site: nothing", () => {
    expect(wallTotalsAccess({ ...base, siteMember: false })).toBe(false); // RLS would return a partial day
    expect(wallTotalsAccess({ ...base, role: "staff" })).toBe(false);
    expect(wallTotalsAccess({ ...base, role: null })).toBe(false);
    expect(wallTotalsAccess({ ...base, roleAllowed: false })).toBe(false);
    expect(wallTotalsAccess({ ...base, callerId: null })).toBe(false);
    expect(wallTotalsAccess({ ...base, hasClient: false })).toBe(false);
    expect(wallTotalsAccess({ ...base, site: "default" })).toBe(false);
  });
});

describe("createBindingGeneration (review r1 M3)", () => {
  it("A→B→A and A→empty→A are new generations; an unchanged map is not", () => {
    const g = createBindingGeneration("S1=alice");
    const readFor = g.observe("S1=alice"); // a read starts for Alice
    expect(readFor).toBe(0);
    expect(g.observe("S1=alice")).toBe(0); // own-badge repeat: unchanged
    expect(g.observe("S1=bob")).toBe(1);
    expect(g.observe("S1=alice")).toBe(2); // back to Alice before any new read
    expect(g.current).not.toBe(readFor); // the old read is not current
    expect(g.observe("S1=")).toBe(3);
    expect(g.observe("S1=alice")).toBe(4);
  });
});
