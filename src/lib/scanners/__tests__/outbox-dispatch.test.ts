import { describe, expect, it } from "vitest";
import { createScannerOutbox, memoryJobStore, OutboxStorageError, scopeKey, type JobScope, type ScannerJob } from "../outbox";
import {
  commitParams,
  dispatchParams,
  processNext,
  type CommitOutcome,
  type DeliveryDeps,
  type EvidenceOutcome,
  type LookupOutcome,
} from "../client";
import type { CapturedOrder } from "../session";
import type { OrderLookup } from "../order";
import type { DispatchFramedLine, FramerEvidence, PreparedDispatch } from "../dispatch";
import type { RuleSetBody } from "@/lib/domain/packaging/ruleSet";

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "wall-1" };
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function captured(orderNumber = "10190203"): CapturedOrder {
  return { scannerId: "S2", orderNumber, person: { personId: P2, displayName: "Dee", badge: "DDDD0001" }, scannedAt: Date.UTC(2026, 10, 22, 9, 0, 0) };
}

const products = [{ id: "p-a2b", code: "A2-Black" }, { id: "p-box", code: "BOX-M" }];
const body: RuleSetBody = {
  schema_version: 1,
  catalogue: [{ key: "BOXM", product_id: "p-box", label: "Medium box", packing_points: ["dispatch"] }],
  rules: [{ id: "d", packing_point: "dispatch", kinds: ["framed", "unframed", "accessory"], output: { mode: "per_capacity", capacity: 4, package: "BOXM" } }],
  examples: [],
};
const framedOrder = (n = "10190203"): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: "INKA-ABC0001-A2-FB", quantity: 2 }],
});
const ev = (status: FramerEvidence["status"]): FramerEvidence =>
  status === "measured"
    ? { sku: "INKA-ABC0001-A2-FB", status, personId: P1, displayName: "Alice", verifiedEventId: "scn-a-v01", completedEventId: "scn-a-c-framed" }
    : { sku: "INKA-ABC0001-A2-FB", status, personId: null, displayName: null, verifiedEventId: null, completedEventId: null };

function deps(over: Partial<DeliveryDeps> & { outbox: DeliveryDeps["outbox"] }) {
  const framing: Array<Record<string, unknown>> = [];
  const dispatch: Array<Record<string, unknown>> = [];
  const evidenceCalls: Array<readonly DispatchFramedLine[]> = [];
  let evidence: FramerEvidence["status"] = "measured";
  let next: CommitOutcome | null = null;
  const d: DeliveryDeps = {
    scope,
    owner: "tab-1",
    lookupOrder: async (): Promise<LookupOutcome> => ({ kind: "ok", lookup: framedOrder() }),
    openCase: async () => false,
    products: () => products,
    packaging: async () => ({ mode: "auto", ruleSet: { id: "rs-d", version: 2, body } }),
    commit: async (job, prepared): Promise<CommitOutcome> => {
      framing.push(commitParams(job, prepared));
      return { outcome: "saved", result: { pieces: 2, eventIds: ["e1"], negativeCodes: [], replayed: false } };
    },
    evidence: async (_n, lines): Promise<EvidenceOutcome> => {
      evidenceCalls.push(lines);
      return { outcome: "ok", evidence: [ev(evidence)] };
    },
    commitDispatch: async (job, prepared): Promise<CommitOutcome> => {
      dispatch.push(dispatchParams(job, prepared));
      const r = next ?? { outcome: "saved", result: { pieces: 2, eventIds: ["dsp-d"], negativeCodes: [], replayed: false, attributions: [] } };
      next = null;
      return r;
    },
    ...over,
  };
  return {
    d, framing, dispatch, evidenceCalls,
    setEvidence: (s: FramerEvidence["status"]) => { evidence = s; },
    answerNext: (o: CommitOutcome) => { next = o; },
  };
}

describe("dispatch jobs in the shared outbox", () => {
  it("keep their own scope suffix (an F6 app never claims them) and are read as dispatch", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    const job = await ob.enqueue(captured(), scope, uuid(), "dispatch");
    expect(job.scope).toBe(scopeKey(scope) + "|dispatch");
    expect(job.mode).toBe("dispatch");
    // The F6 claim filter is `j.scope === scopeKey(scope)`: never true for this job.
    expect([...store.rows.values()].filter((r) => (r as ScannerJob).scope === scopeKey(scope))).toHaveLength(0);
    const view = await ob.view(scope);
    expect(view.jobs.map((j) => j.requestId)).toEqual([job.requestId]);
  });

  it("an F6 row without a mode is a framing job; a row whose mode and scope disagree is unreadable, not guessed", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    const old = await ob.enqueue(captured(), scope, uuid());
    expect("mode" in old).toBe(false);
    expect(old.scope).toBe(scopeKey(scope)); // unchanged F6 key
    store.rows.set("bad", { ...old, requestId: "00000000-0000-4000-8000-00000000beef", mode: "dispatch" });
    const v = await ob.view(scope);
    expect(v.jobs.map((j) => j.requestId)).toEqual([old.requestId]);
    expect(v.corrupt.map((c) => c.key)).toEqual(["bad"]);
  });

  it("an old framing job is still delivered by the framing commit, exactly as F6 prepared it", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    await ob.enqueue(captured(), scope, uuid());
    const t = deps({ outbox: ob });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(t.framing).toHaveLength(1);
    expect(t.dispatch).toHaveLength(0);
    expect(t.evidenceCalls).toHaveLength(0);
  });

  it("measured evidence: saves at once with no manual choice", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(t.framing).toHaveLength(0);
    expect(t.dispatch).toHaveLength(1);
    expect(t.dispatch[0]).toMatchObject({
      p_staff_id: P2, p_badge: "DDDD0001", p_order_number: "10190203", p_scanned_at: "2026-11-22T09:00:00.000Z",
      p_items: 2, p_lines: [{ sku: "INKA-ABC0001-A2-FB", quantity: 2, work_type: "framed" }],
      p_components: [{ code: "A2-Black", qty: 2 }], p_choices: [], p_expected_caller: "kiosk-1",
    });
  });

  it("missing evidence parks the unsent job for a choice; the choice is bound to that job and then sent", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const a = await ob.enqueue(captured("10190203"), scope, uuid(), "dispatch");
    const b = await ob.enqueue(captured("10190204"), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob, lookupOrder: async (n) => ({ kind: "ok", lookup: framedOrder(n) }) });
    t.setEvidence("missing");
    expect(await processNext(t.d)).toMatchObject({ kind: "needs_choice", job: { requestId: a.requestId } });
    expect(await processNext(t.d)).toMatchObject({ kind: "needs_choice", job: { requestId: b.requestId } });
    expect(t.dispatch).toHaveLength(0);
    let v = await ob.view(scope);
    expect(v.blocked).toBe(2); // both stay visible; neither overwrote the other
    const ja = v.jobs.find((j) => j.requestId === a.requestId)!;
    expect(ja).toMatchObject({ status: "blocked", attempts: 0, uncertain: false, blocked: { code: "framer_missing", stage: "prepare" } });

    await ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-ABC0001-A2-FB", personId: P1, displayName: "Alice" }]);
    v = await ob.view(scope);
    expect(v.jobs.find((j) => j.requestId === b.requestId)).toMatchObject({ status: "blocked", prepared: { choices: [] } });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved", job: { requestId: a.requestId } });
    expect(t.dispatch[0]).toMatchObject({ p_order_number: "10190203", p_choices: [{ sku: "INKA-ABC0001-A2-FB", person_id: P1 }] });
  });

  it("Retry on a waiting job re-reads the framing records (a scan may have arrived) and then saves as measured", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const a = await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    t.setEvidence("missing");
    expect(await processNext(t.d)).toMatchObject({ kind: "needs_choice" });
    t.setEvidence("measured");
    await ob.retryBlocked(a.requestId, scope);
    expect((await ob.view(scope)).jobs[0]).toMatchObject({ status: "queued", prepared: null });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(t.dispatch[0].p_choices).toEqual([]);
    expect(t.evidenceCalls).toHaveLength(2);
  });

  it("a definite first refusal (chosen framer inactive) can be re-chosen; a possibly-saved job is frozen", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const a = await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    t.setEvidence("missing");
    await processNext(t.d);
    await ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-ABC0001-A2-FB", personId: P1, displayName: "Alice" }]);
    t.answerNext({ outcome: "rejected", code: "framer_inactive", message: "inactive" });
    expect(await processNext(t.d)).toMatchObject({ kind: "blocked", uncertain: false });
    await ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-ABC0001-A2-FB", personId: P2, displayName: "Dee" }]);

    // Now an unanswered send, then a refusal: the first send may have saved. Frozen.
    t.answerNext({ outcome: "network_error", message: "timeout" });
    expect(await processNext(t.d)).toMatchObject({ kind: "waiting" });
    // Lease/backoff: make the job ready again.
    const store2 = (await ob.view(scope)).jobs[0];
    expect(store2.uncertain).toBe(true);
  });

  it("an uncertain dispatch job refuses a new choice and Retry resends the identical request", async () => {
    let now = 1_000_000;
    const ob = createScannerOutbox(memoryJobStore(), () => now);
    const a = await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    t.setEvidence("missing");
    await processNext(t.d);
    await ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-ABC0001-A2-FB", personId: P1, displayName: "Alice" }]);
    t.answerNext({ outcome: "network_error", message: "timeout" });
    await processNext(t.d);
    now += 120_000;
    t.answerNext({ outcome: "rejected", code: "framer_inactive", message: "inactive" });
    expect(await processNext(t.d)).toMatchObject({ kind: "blocked", uncertain: true });
    await expect(ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-ABC0001-A2-FB", personId: P2, displayName: "Dee" }]))
      .rejects.toBeInstanceOf(OutboxStorageError);
    await ob.retryBlocked(a.requestId, scope);
    const j = (await ob.view(scope)).jobs[0];
    expect(j.status).toBe("prepared"); // exact replay, not a re-read
    expect((j.prepared as PreparedDispatch).choices).toEqual([{ sku: "INKA-ABC0001-A2-FB", personId: P1, displayName: "Alice" }]);
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(t.dispatch).toHaveLength(3);
    expect(t.dispatch[2]).toEqual(t.dispatch[1]);
    expect(t.dispatch[2]).toEqual(t.dispatch[0]);
  });

  it("choices only for the job's missing SKUs, and only within the job's own scope", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const a = await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    t.setEvidence("conflict");
    await processNext(t.d);
    await expect(ob.chooseFramers(a.requestId, { ...scope, location: "uk" }, [{ sku: "INKA-ABC0001-A2-FB", personId: P1, displayName: "Alice" }]))
      .rejects.toThrow(/another account, site or receiver/);
    await expect(ob.chooseFramers(a.requestId, scope, [{ sku: "INKA-XYZ0001-A2-FB", personId: P1, displayName: "Alice" }]))
      .rejects.toThrow(/unknown_sku/);
    await expect(ob.chooseFramers(a.requestId, scope, [])).rejects.toThrow(/incomplete/);
  });

  it("evidence overflow is a clear refusal, never treated as missing", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob, evidence: async () => ({ outcome: "rejected", code: "evidence_overflow", message: "too many" }) });
    expect(await processNext(t.d)).toMatchObject({ kind: "blocked", code: "evidence_overflow" });
    expect(t.dispatch).toHaveLength(0);
    const j = (await ob.view(scope)).jobs[0];
    expect(j.prepared).toBeNull();
  });

  it("a framing job and a dispatch job of the same order are separate requests (framing then dispatch)", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid(), "framing");
    await ob.enqueue(captured(), scope, uuid(), "dispatch");
    const t = deps({ outbox: ob });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(await processNext(t.d)).toMatchObject({ kind: "saved" });
    expect(t.framing).toHaveLength(1);
    expect(t.dispatch).toHaveLength(1);
    expect(t.framing[0].p_request_id).not.toEqual(t.dispatch[0].p_request_id);
  });
});
