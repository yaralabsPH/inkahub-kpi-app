/** F9 UI seams: pinned-generation request lifecycle, rendered labels/states, owner weight saves. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FrameTimingView, timingQuery, type FrameTimingResultView } from "../../src/components/FrameTimingSection";
import { afterSubmit, canSave, needsReload, submitWeights, weightsFromForm, type WeightsRpc } from "../../src/components/FrameTimingWeightsCard";
import { createOverviewLoader, type OverviewState } from "../../src/lib/hooks/useReportsOverview";
import { computeFrameTiming } from "../../src/lib/domain/frameTimingReport";

const U1 = "11111111-1111-4111-8111-111111111111";
const G1 = "11111111-0000-4000-8000-000000000001";
const G2 = "11111111-0000-4000-8000-000000000002";
const REQ = { site: "au" as const, firstDate: "2026-11-16", lastDate: "2026-11-16" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const view = (generationId: string, measured: number, weights: FrameTimingResultView["weights"] = null): FrameTimingResultView => {
  const b = computeFrameTiming(
    [
      { id: "a", staffId: U1, at: "2026-11-16T09:00:00Z", productionDate: "2026-11-16", kind: "verify", workType: "framed", sku: "INKA-ABC0003-A3-FN", pieces: 1, effective: true, rework: false, departmentId: null, stationId: null },
      { id: "b", staffId: U1, at: `2026-11-16T09:${String(measured).padStart(2, "0")}:00Z`, productionDate: "2026-11-16", kind: "verify", workType: "framed", sku: "INKA-ABC0003-A3-FN", pieces: 1, effective: true, rework: false, departmentId: null, stationId: null },
    ],
    weights,
    "2026-11-16T23:00:00Z",
  );
  return { ...b, request: { ...REQ, generationId }, meta: { site: "au", generationId, ruleVersion: "r", sourceCutoffUtc: "2026-11-16T23:00:00Z", verifiedAtUtc: "x", publishedAtUtc: "x", freshUntilUtc: "x", expiresAtUtc: "", visibility: { kind: "site" }, state: "current" } };
};

describe("timing requests are pinned to the summary's generation", () => {
  it("the query names the generation; a new generation is a new identity and a late answer for the old one is dropped", async () => {
    expect(timingQuery({ ...REQ, generationId: G1 })).toBe(`site=au&firstDate=2026-11-16&lastDate=2026-11-16&generationId=${G1}`);
    const pending: Array<{ url: string; resolve: (b: unknown) => void }> = [];
    const loader = createOverviewLoader<typeof REQ & { generationId: string }, FrameTimingResultView>({
      path: "/api/reports/timing",
      queryOf: timingQuery,
      token: async () => "t.t.t",
      fetch: (url) => new Promise((resolve) => pending.push({ url, resolve: (b) => resolve({ ok: true, status: 200, json: async () => b }) })),
      onChange: () => {},
    });
    const scope = `${U1}|owner|site`;
    void loader.load(scope, { ...REQ, generationId: G1 });
    await tick();
    void loader.load(scope, { ...REQ, generationId: G2 }); // the summary refreshed to a newer publication
    await tick();
    expect(pending.map((p) => p.url)).toEqual([`/api/reports/timing?${timingQuery({ ...REQ, generationId: G1 })}`, `/api/reports/timing?${timingQuery({ ...REQ, generationId: G2 })}`]);
    pending[0].resolve(view(G1, 5));
    await tick();
    expect(loader.state()).toMatchObject({ status: "loading", data: null });
    pending[1].resolve(view(G2, 7));
    await tick();
    expect(loader.state().data?.meta.generationId).toBe(G2);
  });
  it("the section is mounted from the summary's DISPLAYED request and generation", () => {
    const src = readFileSync("src/components/ReportsOverview.tsx", "utf8");
    expect(src).toContain("request={{ ...data.request, generationId: data.meta.generationId }}");
  });
});

describe("rendered timing", () => {
  const r = (s: OverviewState<FrameTimingResultView>) => renderToStaticMarkup(<FrameTimingView state={s} onRetry={() => {}} />);
  it("labels both methods, shows the version, coverage and that estimates are unavailable without weights", () => {
    const html = r({ key: "k", status: "ready", data: view(G1, 5), error: null, code: null });
    expect(html).toContain("not stopwatch timing");
    expect(html).toContain("never combined");
    expect(html).toContain("No size weights saved for this site: estimates are unavailable");
    expect(html).toContain("Same report version as the summary (11111111)");
    expect(html).toContain("1 of 2 frame pieces measured");
    expect(html).toContain("<td class=\"tabular-nums\">5.0</td>");
    const w = r({ key: "k", status: "ready", data: view(G1, 5, { version: 3, weights: { A3: 1 } }), error: null, code: null });
    expect(w).toContain("size weights version 3");
  });
  it("loading, not ready and error with Retry", () => {
    expect(r({ key: "k", status: "loading", data: null, error: null, code: null })).toContain("Loading frame timing");
    expect(r({ key: "k", status: "not_ready", data: null, error: "x", code: "READ_MODE_LEGACY" })).toContain("not ready");
    const e = r({ key: "k", status: "error", data: null, error: "gone", code: "GENERATION_EXPIRED" });
    expect(e).toContain("role=\"alert\"");
    expect(e).toContain("Retry");
  });
});

describe("owner weight saves", () => {
  it("blank fields are left out; non-numbers, zero and unknown sizes are refused", () => {
    expect(weightsFromForm({ A1: "2", A2: " ", A3: "0.5" })).toEqual({ A1: 2, A3: 0.5 });
    for (const f of [{}, { A1: "0" }, { A1: "-1" }, { A1: "1e3x" }, { A1: "abc" }]) expect(() => weightsFromForm(f)).toThrow();
  });
  it("saves from the loaded version; a conflict reloads the current values instead of overwriting", async () => {
    const store = { version: 1, weights: { A1: 2 } as Record<string, number> };
    const calls: Array<[number, Record<string, number>]> = [];
    const rpc: WeightsRpc = {
      read: async () => ({ ...store }),
      save: async (_site, expected, w) => {
        calls.push([expected, w]);
        if (expected !== store.version) throw new Error(`version_conflict: current version is ${store.version}`);
        store.version++;
        store.weights = w;
        return { ...store };
      },
    };
    expect(await submitWeights(rpc, "au", 1, { A1: "3" })).toMatchObject({ kind: "saved", version: 2 });
    const stale = await submitWeights(rpc, "au", 1, { A1: "9" }); // edited from version 1 while version 2 exists
    expect(stale).toMatchObject({ kind: "conflict", version: 2, weights: { A1: 3 } });
    expect(store.weights).toEqual({ A1: 3 });
    expect(await submitWeights(rpc, "au", 2, { A1: "x" })).toMatchObject({ kind: "error" });
    expect(calls).toHaveLength(2);
  });
  it("review r1 #3: a conflict whose reload fails is recoverable — save blocked, Reload offered, a retry succeeds", async () => {
    const store = { version: 2, weights: { A1: 3 } as Record<string, number> };
    let readFails = true;
    const rpc: WeightsRpc = {
      read: async () => {
        if (readFails) throw new Error("network down");
        return { ...store };
      },
      save: async (_s, expected, w) => {
        if (expected !== store.version) throw new Error(`version_conflict: current version is ${store.version}`);
        store.version++;
        store.weights = w;
        return { ...store };
      },
    };
    const outcome = await submitWeights(rpc, "au", 1, { A1: "9" }); // must not reject
    expect(outcome.kind).toBe("reload_failed");
    const st = afterSubmit({ version: 1, form: { A1: "9" } }, outcome);
    expect(st.version).toBeNull();
    expect(canSave(st.version, st.status)).toBe(false);
    expect(needsReload(st.version, st.status)).toBe(true);
    expect(st.status.kind).toBe("reload_failed");
    // Reload works once the network is back; saving from the reloaded version succeeds
    readFails = false;
    const cur = await rpc.read("au");
    expect(canSave(cur.version, { kind: "idle" })).toBe(true);
    expect(await submitWeights(rpc, "au", cur.version, { A1: "4" })).toMatchObject({ kind: "saved", version: 3 });
    // an initial load failure also offers Reload and blocks Save
    expect(needsReload(null, { kind: "error" })).toBe(true);
    expect(canSave(null, { kind: "error" })).toBe(false);
  });
  it("Clear all weights appends an empty version from the loaded one", async () => {
    const calls: Array<[number, Record<string, number>]> = [];
    const rpc: WeightsRpc = { read: async () => ({ version: 4, weights: {} }), save: async (_s, e, w) => (calls.push([e, w]), { version: e + 1, weights: w }) };
    const r = await submitWeights(rpc, "au", 4, { A1: "2" }, { clear: true });
    expect(r).toMatchObject({ kind: "saved", version: 5 });
    expect(calls).toEqual([[4, {}]]);
    expect(afterSubmit({ version: 4, form: { A1: "2" } }, r).form).toEqual({});
  });
  it("Settings shows the card only for a loaded owner whose profile matches the session user", () => {
    const src = readFileSync("src/pages/Settings.tsx", "utf8");
    expect(src).toContain('auth.profile?.user_id === auth.user.id && auth.profile?.role === "owner"');
    expect(src).toContain("!auth.loading");
  });
});
