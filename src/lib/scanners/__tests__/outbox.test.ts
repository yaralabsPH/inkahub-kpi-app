import { describe, expect, it } from "vitest";
import {
  createScannerOutbox,
  LEASE_MS,
  LeaseLostError,
  MAX_ACTIVE_JOBS,
  memoryJobStore,
  OutboxFullError,
  OutboxStorageError,
  type JobScope,
} from "../outbox";
import { classifyRpcError, commitParams, processNext, type CommitOutcome, type DeliveryDeps, type LookupOutcome } from "../client";
import type { CapturedOrder } from "../session";
import type { OrderLookup, PreparedFraming } from "../order";

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
    const claimed = await ob.claimNext(scope, "tab-1");
    await ob.markBlocked(job.requestId, claimed!.leaseOwner!, { code: "cancelled", message: "x", stage: "prepare" });
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

describe("R1 corrections", () => {
  const savedResult: CommitOutcome = { outcome: "saved", result: { pieces: 2, eventIds: [], negativeCodes: [], replayed: true } };

  it("R1-2: an unanswered save then a refusal stays uncertain, cannot be dismissed, and an exact replay resolves it", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    const job = await ob.enqueue(captured(), scope, uuid());
    const answers: CommitOutcome[] = [
      { outcome: "network_error", message: "timeout" }, // may have saved
      { outcome: "rejected", code: "forbidden_role", message: "role revoked" }, // refused before the receipt check
      savedResult, // retry: the receipt says it was saved by attempt 1
    ];
    const d = deps({ outbox: ob });
    const realCommit = d.commit;
    d.commit = async (j, p) => { await realCommit(j, p); return answers.shift()!; };
    expect(await processNext(d)).toMatchObject({ kind: "waiting" });
    clock += 120_000;
    expect(await processNext(d)).toMatchObject({ kind: "blocked", code: "forbidden_role", uncertain: true });
    let v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "blocked", uncertain: true });
    await expect(ob.dismiss(job.requestId, scope)).rejects.toThrow(/Only a blocked/);
    await ob.retryBlocked(job.requestId, scope);
    expect(await processNext(d)).toMatchObject({ kind: "saved" });
    v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "done", uncertain: false, outcome: { kind: "saved" } });
    expect(new Set(d.commits.map((c) => JSON.stringify(c))).size).toBe(1); // the identical request every time
  });

  it("R1-2: a refusal of the first and only attempt is definite and may be dismissed", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    const job = await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, commit: async () => ({ outcome: "rejected", code: "badge_inactive", message: "revoked" }) });
    expect(await processNext(d)).toMatchObject({ kind: "blocked", uncertain: false });
    await ob.dismiss(job.requestId, scope);
  });

  it("R1-4: a stale claim's late refusal cannot downgrade a job another claim saved", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    await ob.enqueue(captured(), scope, uuid());
    let releaseA!: (o: CommitOutcome) => void;
    const dA = deps({ outbox: ob, owner: "tab-A", commit: () => new Promise<CommitOutcome>((r) => (releaseA = r)) });
    const runA = processNext(dA); // A sends and hangs
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    clock += LEASE_MS + 1; // A's lease expires
    const dB = deps({ outbox: ob, owner: "tab-B", commit: async () => savedResult });
    expect(await processNext(dB)).toMatchObject({ kind: "saved" });
    releaseA({ outcome: "rejected", code: "forbidden_role", message: "late" });
    // R2-1: the stale claim reports "superseded", never its own false "not saved".
    expect(await runA).toMatchObject({ kind: "superseded" });
    const v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "done", uncertain: false, outcome: { kind: "saved" } });
    // A late retry-later from the old claim is ignored too.
    await ob.retryLater(v.jobs[0].requestId, "tab-A#1-stale", "late");
    expect((await ob.view(scope)).jobs[0].status).toBe("done");
  });

  it("R1-8: account A's job is never sent as B; a disposed station starts nothing; the job waits for A", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    await ob.enqueue(captured(), scope, uuid()); // scanned by kiosk-1 (scope.callerId)
    let signedIn = "kiosk-1";
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((r) => (releaseLookup = r));
    let stationOpen = true;
    // Server stand-in: refuses a request whose expected caller is not the signed-in account.
    const d = deps({
      outbox: ob,
      active: () => stationOpen,
      lookupOrder: async (n) => { await lookupGate; return { kind: "ok", lookup: framedOrder(n) }; },
      commit: async (j, p) => (commitParams(j, p).p_expected_caller === signedIn
        ? savedResult : classifyRpcError({ message: "scanner: caller_mismatch", code: "P0001" }) as CommitOutcome),
    });
    const run = processNext(d);
    signedIn = "kiosk-2"; // B signs in while A's preparation is delayed
    stationOpen = false; // ...and A's station is torn down
    releaseLookup();
    expect(await run).toMatchObject({ kind: "superseded" });
    let v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "queued", attempts: 0, prepared: null });
    // Even if a station did send it under B, the expected caller makes the server refuse: kept for A, not blocked.
    stationOpen = true;
    clock += 120_000;
    expect(await processNext(d)).toMatchObject({ kind: "waiting", auth: true });
    v = await ob.view(scope);
    expect(v.jobs[0]).toMatchObject({ status: "prepared" });
    // A signs back in: the identical request saves.
    signedIn = "kiosk-1";
    clock += 120_000;
    expect(await processNext(d)).toMatchObject({ kind: "saved" });
  });

  it("R1-10: regular-only orders never need box rules; A0 with missing rules gets a classic reason; transport failure waits", async () => {
    const ob = createScannerOutbox(memoryJobStore());
    await ob.enqueue(captured("10190203"), scope, uuid());
    let packagingCalls = 0;
    const d = deps({ outbox: ob, packaging: async () => { packagingCalls++; return "network"; } });
    expect(await processNext(d)).toMatchObject({ kind: "saved" });
    expect(packagingCalls).toBe(0);

    const ob2 = createScannerOutbox(memoryJobStore());
    await ob2.enqueue(captured("10190204"), scope, uuid());
    const a0 = (n: string): OrderLookup => ({ ...framedOrder(n), line_items: [{ sku: "INKA-ABC0001-A0-FB", quantity: 1 }] });
    const products = [{ id: "p-a0b", code: "A0-Black" }];
    const transport = deps({ outbox: ob2, products: () => products, lookupOrder: async (n) => ({ kind: "ok", lookup: a0(n) }), packaging: async () => "network" });
    expect(await processNext(transport)).toMatchObject({ kind: "waiting", message: "Couldn't load the box rules." });
    const ob3 = createScannerOutbox(memoryJobStore());
    await ob3.enqueue(captured("10190205"), scope, uuid());
    const missing = deps({ outbox: ob3, products: () => products, lookupOrder: async (n) => ({ kind: "ok", lookup: a0(n) }),
      packaging: async () => ({ mode: "auto", ruleSet: null }) });
    expect(await processNext(missing)).toMatchObject({ kind: "blocked", code: "packaging_not_auto", uncertain: false });
  });

  it("R2-1: a stale claim's late network error and late preparation refusal are superseded too", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    await ob.enqueue(captured("10190203"), scope, uuid());
    let releaseA!: (o: CommitOutcome) => void;
    const dA = deps({ outbox: ob, owner: "tab-A", commit: () => new Promise<CommitOutcome>((r) => (releaseA = r)) });
    const runA = processNext(dA);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    clock += LEASE_MS + 1;
    expect(await processNext(deps({ outbox: ob, owner: "tab-B", commit: async () => savedResult }))).toMatchObject({ kind: "saved" });
    releaseA({ outcome: "network_error", message: "late timeout" });
    expect(await runA).toMatchObject({ kind: "superseded" });
    expect((await ob.view(scope)).jobs[0]).toMatchObject({ status: "done", outcome: { kind: "saved" } });

    // Preparation: A's lookup outlives its lease; B saves; A's "cancelled" verdict is ignored.
    const ob2 = createScannerOutbox(memoryJobStore(), () => clock);
    await ob2.enqueue(captured("10190204"), scope, uuid());
    let releaseLookup!: () => void;
    const gate = new Promise<void>((r) => (releaseLookup = r));
    const slowA = deps({ outbox: ob2, owner: "tab-A",
      lookupOrder: async (n) => { await gate; return { kind: "ok", lookup: { ...framedOrder(n), cancelled_at: "2026-01-01" } }; } });
    const runA2 = processNext(slowA);
    await new Promise((r) => setImmediate(r));
    clock += LEASE_MS + 1;
    expect(await processNext(deps({ outbox: ob2, owner: "tab-B", lookupOrder: async (n) => ({ kind: "ok", lookup: framedOrder(n) }), commit: async () => savedResult }))).toMatchObject({ kind: "saved" });
    releaseLookup();
    expect(await runA2).toMatchObject({ kind: "superseded" });
    expect((await ob2.view(scope)).jobs[0]).toMatchObject({ status: "done" });
  });

  it("R2-1: a stale lease surfaces as LeaseLostError through the store, not a storage failure", async () => {
    let clock = 1_000;
    const ob = createScannerOutbox(memoryJobStore(), () => clock);
    await ob.enqueue(captured(), scope, uuid());
    const a = await ob.claimNext(scope, "tab-A");
    clock += LEASE_MS + 1;
    await ob.claimNext(scope, "tab-B");
    await expect(ob.markAttempt(a!.requestId, a!.leaseOwner!)).rejects.toBeInstanceOf(LeaseLostError);
    await expect(ob.setPrepared(a!.requestId, a!.leaseOwner!, {} as never)).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("R2-2: the station stopping while the attempt is recorded sends nothing and invents no unknown outcome", async () => {
    const base = createScannerOutbox(memoryJobStore());
    let stationOpen = true;
    let releaseAttempt!: () => void;
    const attemptGate = new Promise<void>((r) => (releaseAttempt = r));
    const ob = {
      ...base,
      markAttempt: async (id: string, lease: string) => {
        const j = await base.markAttempt(id, lease);
        await attemptGate; // the IndexedDB write is slow; the station closes meanwhile
        return j;
      },
    };
    const job = await ob.enqueue(captured(), scope, uuid());
    const d = deps({ outbox: ob, active: () => stationOpen });
    const run = processNext(d);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stationOpen = false;
    releaseAttempt();
    expect(await run).toMatchObject({ kind: "superseded" });
    expect(d.commits).toHaveLength(0);
    const v = await base.view(scope);
    expect(v.jobs[0]).toMatchObject({ requestId: job.requestId, status: "prepared", attempts: 0, uncertain: false, leaseOwner: null });
    const payload = v.jobs[0].prepared;
    // Reopened: the same job, same payload, is claimable at once and saves.
    stationOpen = true;
    const d2 = deps({ outbox: base });
    expect(await processNext(d2)).toMatchObject({ kind: "saved" });
    expect(d2.commits[0].p_lines).toEqual((payload as PreparedFraming).lines.map((l) => ({ sku: l.sku, quantity: l.quantity, work_type: l.workType })));
  });
});

