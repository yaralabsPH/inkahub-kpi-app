import { describe, expect, it } from "vitest";
import { checkSet, compareSets, deductSummary, STEPS, type SetOutcome } from "./writeCompat";
import { PRE_0036_RESTORE } from "./writeCompatRun";

const GOOD: Record<string, string> = {
  s00: "stg-box-medium=80,stg-frame-a3-black=120",
  s01: "0", s02: "1", s03: "1", s04: "wc-lv1", s05: "1",
  s06: "status=ok,deducted=2,skipped=0,missing=,negative=",
  s07: "status=ok,deducted=0,skipped=2,missing=,negative=",
  s08: "stg-box-medium=79,stg-frame-a3-black=118;ledger=2",
  s09: "1", s10: "1", s11: "error 42501",
  s12: "wc-cancel,wc-done,wc-lv1,wc-self", s13: "wc-cancel,wc-done,wc-lv1,wc-self", s14: "wc-cancel,wc-done,wc-lv1,wc-self",
  s15: "v1=4,v2=4", s16: "v1=4,v2=4", s17: "0", s18: "1", s19: "0", s20: "0", s21: "2", s22: "1",
  s23: "wc-cancel,wc-lv1,wc-self", s24: "1289:abc", s25: "1289:abc", s26: "v1=1313,v2=1313",
  s27: "error 42501", s28: "error 42501", s29: "error 42501",
};
const outcome = (set: "post" | "pre", over: Record<string, string> = {}): SetOutcome => ({
  set,
  policyHash: set,
  policyProblems: [],
  steps: STEPS.map((s) => ({ id: s.id, actor: s.actor, result: over[s.id] ?? GOOD[s.id] })),
});

describe("write-path compatibility checks", () => {
  it("accepts the expected behaviour and identical sets", () => {
    expect(checkSet(outcome("post"))).toEqual([]);
    expect(compareSets(outcome("post"), outcome("pre"))).toEqual([]);
  });

  it("covers every step it checks", () => {
    expect(STEPS.map((s) => s.id)).toEqual(Object.keys(GOOD));
  });

  it.each([
    ["s07", "status=ok,deducted=2,skipped=0,missing=,negative=", "s07"],
    ["s08", "stg-box-medium=78,stg-frame-a3-black=116;ledger=4", "stock moved"],
    ["s11", "1", "s11"],
    ["s17", "1", "s17"],
    ["s22", "0", "s22"],
    ["s24", "1288:abd", "s24"],
    ["s26", "v1=1313,v2=1312", "s26"],
    ["s29", "0", "s29"],
  ])("fails when %s gives %s", (id, value, needle) => {
    expect(checkSet(outcome("post", { [id]: value })).join("\n")).toContain(needle);
  });

  it("fails an empty digest read even when it matches the reference", () => {
    expect(checkSet(outcome("post", { s24: "0:", s25: "0:" })).join("\n")).toContain("s24");
  });

  it("fails when the two policy sets behave differently", () => {
    expect(compareSets(outcome("post"), outcome("pre", { s12: "wc-self" }))[0]).toContain("s12");
  });

  it("reports policy problems and missing steps", () => {
    const o = outcome("pre");
    o.policyProblems = ["hash differs"];
    o.steps = o.steps.filter((s) => s.id !== "s05");
    const p = checkSet(o).join("\n");
    expect(p).toContain("pre: hash differs");
    expect(p).toContain("s05 did not run");
  });

  it("summarises deduction results without generated ids", () => {
    expect(deductSummary({ status: "ok", deducted: 1, skipped_idempotent: 0, missing_codes: ["X"], negative_codes: [], event_id: "e1" }))
      .toBe("status=ok,deducted=1,skipped=0,missing=X,negative=");
    expect(deductSummary('{"status":"skipped_event_type"}')).toBe("status=skipped_event_type,deducted=undefined,skipped=undefined,missing=,negative=");
  });

  it("restores exactly the plan's pre-0036 policies and nothing else", () => {
    expect(PRE_0036_RESTORE.filter((s) => /^(drop|create) policy/.test(s)).map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
      "drop policy production_events_read", "drop policy production_events_select",
      "create policy production_events_read", "create policy production_events_select",
    ]);
    expect(PRE_0036_RESTORE.join(";")).not.toMatch(/\b(commit|grant|revoke|alter)\b/i);
  });

  it("only writes on the isolated staging site", () => {
    for (const s of STEPS.filter((x) => /^\s*(insert|update|delete)/i.test(x.sql))) {
      expect(s.sql).toMatch(/'staging'|id = 'wc-done'|parent_event_id = 'wc-done'/);
    }
  });
});
