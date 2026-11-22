import { describe, expect, it } from "vitest";
import {
  createScannerOutbox,
  MAX_ACTIVE_JOBS,
  memoryJobStore,
  OutboxFullError,
  OutboxStorageError,
  type JobScope,
} from "../outbox";
import { commitParams, processNext, type CommitOutcome, type DeliveryDeps, type LookupOutcome } from "../client";
import type { CapturedOrder } from "../session";
import type { OrderLookup } from "../order";

const scope: JobScope = { backend: "supabase", callerId: "kiosk-1", location: "au", receiverId: "wall-1" };
const otherCaller: JobScope = { ...scope, callerId: "kiosk-2" };
const otherSite: JobScope = { ...scope, location: "uk" };

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function captured(orderNumber = "10190203", person = "11111111-1111-4111-8111-111111111111"): CapturedOrder {
  return { scannerId: "S1", orderNumber, person: { personId: person, displayName: "Alice", badge: "AAAA0001" }, scannedAt: Date.UTC(2026, 10, 22, 1, 2, 3) };
}

const framedOrder = (n = "10190203"): OrderLookup => ({
  found: true, complete: true, truncated: false, order_name: `#${n}`, cancelled_at: null, tags: [],
  line_items: [{ sku: "INKA-ABC0001-A2-FB", quantity: 2 }],
});

function deps(over: Partial<DeliveryDeps> & { outbox: DeliveryDeps["outbox"] }): DeliveryDeps & { commits: Array<Record<string, unknown>> } {
  const commits: Array<Record<string, unknown>> = [];
  return {
    scope,
    owner: "tab-1",
    lookupOrder: async (): Promise<LookupOutcome> => ({ kind: "ok", lookup: framedOrder() }),
    openCase: async () => false,
    products: () => [],
    packaging: async () => ({ mode: "scan", ruleSet: null }),
    commit: async (job, prepared): Promise<CommitOutcome> => {
      commits.push(commitParams(job, prepared));
      return { outcome: "saved", result: { pieces: 2, eventIds: ["e1"], negativeCodes: [], replayed: false } };
    },
    commits,
    ...over,
  };
}

describe("scanner outbox", () => {
  it("persists the scan before any network work and survives a reload", async () => {
    const store = memoryJobStore();
    const job = await createScannerOutbox(store).enqueue(captured(), scope, uuid());
    expect(store.rows.size).toBe(1);
    expect(job).toMatchObject({ status: "queued", personId: "11111111-1111-4111-8111-111111111111", badge: "AAAA0001", scannedAt: "2026-11-22T01:02:03.000Z" });
    // "Reload": a brand-new outbox over the same storage still sees it.
    const after = await createScannerOutbox(store).view(scope);
    expect(after.jobs.map((j) => j.requestId)).toEqual([job.requestId]);
    expect(after.waiting).toBe(1);
  });

  it("a storage failure is a rejection, never an in-memory acceptance", async () => {
    const store = memoryJobStore({ failWrites: () => true });
    await expect(createScannerOutbox(store).enqueue(captured(), scope, uuid())).rejects.toBeInstanceOf(OutboxStorageError);
    expect(store.rows.size).toBe(0);
  });

  it("refuses new scans when full, loudly", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    for (let i = 0; i < MAX_ACTIVE_JOBS; i++) await ob.enqueue(captured(), scope, uuid());
    await expect(ob.enqueue(captured(), scope, uuid())).rejects.toBeInstanceOf(OutboxFullError);
  });

  it("never drains a job under another account or site", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    await ob.enqueue(captured(), scope, uuid());
    expect(await ob.claimNext(otherCaller, "tab-1")).toBeNull();
    expect(await ob.claimNext(otherSite, "tab-1")).toBeNull();
    expect((await ob.view(otherCaller)).jobs).toEqual([]);
    expect(await ob.claimNext(scope, "tab-1")).not.toBeNull();
  });

  it("two tabs cannot claim the same job at once", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    await ob.enqueue(captured(), scope, uuid());
    const [a, b] = await Promise.all([ob.claimNext(scope, "tab-1"), ob.claimNext(scope, "tab-2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("keeps unreadable rows visible and counted; never drops them", async () => {
    const store = memoryJobStore();
    store.rows.set("garbage", { nope: true });
    const ob = createScannerOutbox(store);
    const v = await ob.view(scope);
    expect(v.corrupt).toEqual([{ key: "garbage", raw: { nope: true } }]);
    await ob.enqueue(captured(), scope, uuid());
    expect(store.rows.has("garbage")).toBe(true);
  });

  it("only a definitely-blocked job can be dismissed, and only in its own scope", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    const job = await ob.enqueue(captured(), scope, uuid());
    await expect(ob.dismiss(job.requestId, scope)).rejects.toThrow(/Only a blocked/);
    await ob.markBlocked(job.requestId, { code: "cancelled", message: "x", stage: "prepare" });
    await expect(ob.dismiss(job.requestId, otherCaller)).rejects.toThrow(/another account/);
    await ob.dismiss(job.requestId, scope);
    expect((await ob.view(scope)).jobs[0].status).toBe("dismissed");
  });
});

describe("delivery", () => {
  it("raw lookup -> persisted prepared payload -> commit -> done", async () => {
    const store = memoryJobStore();
    const ob = createScannerOutbox(store);
    const job = await ob.enqueue(captured(), scope, uuid());
    const d = deps({
      outbox: ob,
      commit: async (j, p) => {
        // The prepared payload is already on disk when the commit is sent.
        const stored = store.rows.get(j.requestId) as { status: string; prepared: unknown; uncertain: boolean };
        expect(stored.status).toBe("prepared");
        expect(stored.prepared).toEqual(p);
        expect(stored.uncertain).toBe(true);
        return { outcome: "saved", result: { pieces: 2, eventIds: ["e1"], negativeCodes: [], replayed: false } };
      },
    });
    const r = await processNext(d);
    expect(r).toMatchObject({ kind: "saved", result: { pieces: 2 } });
    const v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ requestId: job.requestId, status: "done", uncertain: false, outcome: { kind: "saved" } });
    expect(await processNext(d)).toBeNull();
  });

  it("a lost response is retried with the identical request id and payload", async () => {
    const store = memoryJobStore();
    let clock = 1_000;
    const ob = createScannerOutbox(store, () => clock);
    await ob.enqueue(captured(), scope, uuid());
    let answer: CommitOutcome = { outcome: "network_error", message: "timeout" };
    const d = deps({ outbox: ob });
    const realCommit = d.commit;
    d.commit = async (j, p) => {
      await realCommit(j, p);
      return answer;
    };
    expect(await processNext(d)).toMatchObject({ kind: "waiting" });
    let v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "prepared", uncertain: true, attempts: 1 });
    // The order changes in Shopify meanwhile: the prepared payload must NOT be rebuilt.
    d.lookupOrder = async () => ({ kind: "ok", lookup: { ...framedOrder(), line_items: [{ sku: "INKA-ZZZ0009-A1-FW", quantity: 9 }] } });
    expect(await processNext(d)).toBeNull(); // backing off
    clock += 120_000;
    answer = { outcome: "saved", result: { pieces: 2, eventIds: ["e1"], negativeCodes: [], replayed: true } };
    expect(await processNext(d)).toMatchObject({ kind: "saved", result: { replayed: true } });
    expect(d.commits).toHaveLength(2);
    expect(d.commits[1]).toEqual(d.commits[0]);
    v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "done", uncertain: false, attempts: 2 });
  });

  it("an order that is not safe for shared scanners is blocked with its reason, not dropped", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const job = await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, lookupOrder: async () => ({ kind: "ok", lookup: { ...framedOrder(), cancelled_at: "2026-01-01" } }) });
    expect(await processNext(d)).toMatchObject({ kind: "blocked", code: "cancelled" });
    expect(d.commits).toHaveLength(0);
    const v = await ob.view(scope);
    expect(v.blocked).toBe(1);
    expect(v.jobs[0].blocked).toMatchObject({ code: "cancelled", stage: "prepare" });
    // Operator fixes the cause and retries: same request id, prepared fresh (nothing was ever sent).
    await ob.retryBlocked(job.requestId, scope);
    d.lookupOrder = async () => ({ kind: "ok", lookup: framedOrder() });
    expect(await processNext(d)).toMatchObject({ kind: "saved" });
    expect(d.commits[0].p_request_id).toBe(job.requestId);
  });

  it("network trouble before the commit keeps the job queued (amber), never green", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, lookupOrder: async () => ({ kind: "network", message: "offline" }) });
    expect(await processNext(d)).toMatchObject({ kind: "waiting", message: "offline" });
    expect((await ob.view(scope)).jobs[0]).toMatchObject({ status: "queued", prepared: null, attempts: 0 });
    expect(d.commits).toHaveLength(0);
  });

  it("a server refusal after a commit blocks the job and settles its uncertainty", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, commit: async () => ({ outcome: "rejected", code: "badge_inactive", message: "revoked" }) });
    expect(await processNext(d)).toMatchObject({ kind: "blocked", code: "badge_inactive" });
    expect((await ob.view(scope)).jobs[0]).toMatchObject({ status: "blocked", uncertain: false, blocked: { stage: "commit" } });
  });

  it("already-recorded is finished but not a green save", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, commit: async () => ({ outcome: "already_recorded", reason: "framed already completed" }) });
    expect(await processNext(d)).toMatchObject({ kind: "already_recorded" });
    expect((await ob.view(scope)).jobs[0].outcome).toMatchObject({ kind: "already_recorded", pieces: 0 });
  });

  it("processes strictly one job at a time in scan order, and new scans can queue meanwhile", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const first = await ob.enqueue(captured("10190203"), scope, uuid());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const d = deps({
      outbox: ob,
      lookupOrder: async (n) => ({ kind: "ok", lookup: framedOrder(n) }),
      commit: async (j) => {
        order.push(j.orderNumber);
        if (j.requestId === first.requestId) await gate;
        return { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: false } };
      },
    });
    const running = processNext(d);
    // A scan arriving while the first is in flight is stored, not ignored.
    await ob.enqueue(captured("10190204"), scope, uuid());
    release();
    await running;
    await processNext(d);
    expect(order).toEqual(["10190203", "10190204"]);
  });
});
