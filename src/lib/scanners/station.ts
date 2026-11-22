/**
 * F6 shared scanner stations: the receiver's controller. Wires frames to
 * identity decisions, the durable queue and delivery, with every effect
 * injected so it is tested without a browser. The React hook only feeds it
 * key events and renders its state.
 *
 * Rules it enforces:
 *   - A frame is decided synchronously (person captured before any await).
 *   - No scan is ignored because another request is busy: activations run
 *     per scanner, queue writes never wait for delivery, and delivery is one
 *     serialized loop that re-checks for new jobs before it stops.
 *   - Green only after the server saved it; amber while queued; red when
 *     refused or when the device could not store the scan.
 */
import type { ActivateOutcome, DeliveryReport } from "./client";
import { OutboxFullError, type JobScope, type ScannerOutbox, type ScopeView } from "./outbox";
import { PROTOCOL_ERROR_TEXT, type ProtocolErrorReason } from "./protocol";
import {
  clearAll,
  decideFrame,
  emptySlots,
  expireIdle,
  REJECT_TEXT,
  resolveActivation,
  type CapturedOrder,
  type ScannerSlot,
} from "./session";

export type WallResultKind = "saved" | "queued" | "rejected" | "already" | "signed_in" | "info";

export interface WallResult {
  kind: WallResultKind;
  title: string;
  detail?: string;
  scannerId: string | null;
  person?: string;
  order?: string;
  pieces?: number;
  at: number;
}

export interface WallState {
  slots: Record<string, ScannerSlot>;
  last: WallResult | null;
  view: ScopeView | null;
  storageError: string | null;
  deliveryWaiting: string | null;
  authProblem: boolean;
  lastAcceptedAt: number | null;
}

export type SoundKind = "ok" | "queued" | "error";

export interface ControllerDeps {
  scannerIds: readonly string[];
  scope: JobScope;
  outbox: ScannerOutbox;
  activate(a: { requestId: string; scannerId: string; badge: string }): Promise<ActivateOutcome>;
  deliver(): Promise<DeliveryReport | null>;
  isOnline(): boolean;
  now(): number;
  newRequestId(): string;
  sound(kind: SoundKind): void;
}

export class SharedScannerController {
  private s: WallState;
  private listeners = new Set<(s: WallState) => void>();
  private pumping = false;
  private pumpAgain = false;
  private disposed = false;

  constructor(private readonly d: ControllerDeps) {
    this.s = {
      slots: emptySlots(d.scannerIds),
      last: null,
      view: null,
      storageError: null,
      deliveryWaiting: null,
      authProblem: false,
      lastAcceptedAt: null,
    };
  }

  get state(): WallState {
    return this.s;
  }

  subscribe(fn: (s: WallState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<WallState>): void {
    if (this.disposed) return;
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  private show(r: Omit<WallResult, "at">, sound: SoundKind | null): void {
    this.set({ last: { ...r, at: this.d.now() } });
    if (sound) this.d.sound(sound);
  }

  // ---- input -------------------------------------------------------------

  onProtocolError(reason: ProtocolErrorReason, scannerId: string | null): void {
    if (scannerId === null) {
      // Source uncertain: nobody keeps an identity.
      this.set({ slots: clearAll(this.s.slots) });
      this.show({ kind: "rejected", scannerId: null, title: "Scan garbled — every scanner signed out", detail: `${PROTOCOL_ERROR_TEXT[reason]} Scan your badge again, then the order.` }, "error");
      return;
    }
    this.show({ kind: "rejected", scannerId, title: `${scannerId}: scan not accepted`, detail: PROTOCOL_ERROR_TEXT[reason] }, "error");
  }

  /** Call for every whole frame. Synchronous decision; effects run after. */
  onFrame(scannerId: string, payload: string): void {
    const { slots, decision } = decideFrame(this.s.slots, { scannerId, payload }, {
      online: this.d.isOnline(),
      now: this.d.now(),
      newRequestId: () => this.d.newRequestId(),
    });
    this.set({ slots });
    switch (decision.action) {
      case "reject":
        this.show({ kind: "rejected", scannerId, title: `${scannerId}: not saved`, detail: REJECT_TEXT[decision.code] }, "error");
        return;
      case "enqueue":
        void this.enqueue(decision.order);
        return;
      case "activate":
        void this.runActivation(scannerId, decision.epoch, decision.pending.requestId, decision.pending.badge);
        return;
    }
  }

  private async runActivation(scannerId: string, epoch: number, requestId: string, badge: string): Promise<void> {
    let res: ActivateOutcome;
    try {
      res = await this.d.activate({ requestId, scannerId, badge });
    } catch (e) {
      res = { outcome: "network_error", message: e instanceof Error ? e.message : String(e) };
    }
    const result =
      res.outcome === "activated"
        ? ({ outcome: "activated", personId: res.personId, displayName: res.displayName } as const)
        : res.outcome === "unknown_badge"
          ? ({ outcome: "unknown_badge" } as const)
          : ({ outcome: "failed", message: res.message } as const);
    const r = resolveActivation(this.s.slots, scannerId, epoch, requestId, result, this.d.now());
    if (r.stale) return; // the scanner moved on; never bind an old answer
    this.set({ slots: r.slots });
    if (res.outcome === "activated") {
      this.show({ kind: "signed_in", scannerId, person: res.displayName, title: `${scannerId}: ${res.displayName}`, detail: res.clockedIn ? "Signed in and clocked in." : "Signed in." }, "ok");
      return;
    }
    if (r.order) {
      void this.enqueue(r.order);
      return;
    }
    if (r.rejected) {
      this.show({ kind: "rejected", scannerId, title: `${scannerId}: not saved`, detail: REJECT_TEXT[r.rejected] }, "error");
      return;
    }
    const detail =
      res.outcome === "unknown_badge"
        ? "Badge not recognised at this site. Scanner signed out."
        : res.outcome === "rejected"
          ? `${res.message} Scanner signed out.`
          : `Couldn't reach the server to sign in (${res.message}). Scanner signed out; scan the badge again.`;
    if (res.outcome === "network_error" && res.auth) this.set({ authProblem: true });
    this.show({ kind: "rejected", scannerId, title: `${scannerId}: badge not signed in`, detail }, "error");
  }

  private async enqueue(order: CapturedOrder): Promise<void> {
    try {
      await this.d.outbox.enqueue(order, this.d.scope, this.d.newRequestId());
    } catch (e) {
      const full = e instanceof OutboxFullError;
      const message = e instanceof Error ? e.message : String(e);
      if (!full) this.set({ storageError: message });
      this.show({
        kind: "rejected",
        scannerId: order.scannerId,
        person: order.person.displayName,
        order: order.orderNumber,
        title: `NOT SAVED: #${order.orderNumber}`,
        detail: full ? message : `This device could not store the scan (${message}). Record it on the classic station.`,
      }, "error");
      return;
    }
    this.set({ storageError: null, lastAcceptedAt: this.d.now() });
    this.show({
      kind: "queued",
      scannerId: order.scannerId,
      person: order.person.displayName,
      order: order.orderNumber,
      title: `Queued #${order.orderNumber} for ${order.person.displayName}`,
      detail: this.d.isOnline() ? "Saving…" : "Offline: it will be saved when the network is back.",
    }, "queued");
    await this.refreshView();
    this.pump();
  }

  /** Periodic: expire idle identities. */
  tick(): void {
    const { slots, expired } = expireIdle(this.s.slots, this.d.now());
    if (expired.length === 0) return;
    this.set({ slots });
    this.show({ kind: "info", scannerId: expired[0], title: `${expired.join(", ")} signed out after 10 minutes without a scan`, detail: "Scan your badge again." }, null);
  }

  /** Clear every identity (auth/site/mode change, operator reset). */
  resetAll(reason: string): void {
    this.set({ slots: clearAll(this.s.slots) });
    this.show({ kind: "info", scannerId: null, title: "All scanners signed out", detail: reason }, null);
  }

  // ---- queue -------------------------------------------------------------

  async refreshView(): Promise<void> {
    try {
      const view = await this.d.outbox.view(this.d.scope);
      this.set({ view });
    } catch (e) {
      this.set({ storageError: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Start (or re-check) the single delivery loop. */
  pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    void (async () => {
      try {
        do {
          this.pumpAgain = false;
          for (;;) {
            if (this.disposed) return;
            let report: DeliveryReport | null;
            try {
              report = await this.d.deliver();
            } catch (e) {
              this.set({ storageError: e instanceof Error ? e.message : String(e) });
              return;
            }
            if (!report) break;
            this.onReport(report);
            await this.refreshView();
            if (report.kind === "waiting") break;
          }
        } while (this.pumpAgain && !this.disposed);
      } finally {
        this.pumping = false;
      }
    })();
  }

  private onReport(r: DeliveryReport): void {
    const j = r.job;
    switch (r.kind) {
      case "saved":
        this.set({ deliveryWaiting: null, authProblem: false });
        this.show({
          kind: "saved", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber, pieces: r.result.pieces,
          title: `Saved #${j.orderNumber}`,
          detail: r.result.negativeCodes.length ? `Stock now below zero: ${r.result.negativeCodes.join(", ")}` : undefined,
        }, "ok");
        return;
      case "already_recorded":
        this.set({ deliveryWaiting: null });
        this.show({
          kind: "already", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
          title: `#${j.orderNumber} already recorded — no extra credit`,
          detail: `${r.reason}. Check the order on the classic station.`,
        }, "error");
        return;
      case "blocked":
        this.show({
          kind: "rejected", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
          title: `#${j.orderNumber} not saved — use the classic station`, detail: r.message,
        }, "error");
        return;
      case "waiting":
        this.set({ deliveryWaiting: r.message, authProblem: r.auth });
        return;
    }
  }

  async retry(requestId: string): Promise<void> {
    await this.d.outbox.retryBlocked(requestId, this.d.scope);
    await this.refreshView();
    this.pump();
  }

  async dismiss(requestId: string): Promise<void> {
    await this.d.outbox.dismiss(requestId, this.d.scope);
    await this.refreshView();
  }
}
