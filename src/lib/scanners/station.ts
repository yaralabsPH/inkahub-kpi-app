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
import type { ActivateOutcome, DeliveryReport, SavedAttribution } from "./client";
import { CHOICE_CODES, dispatchShiftEnd, type FramerChoice, type ScanMode } from "./dispatch";
import { jobMode, OutboxFullError, type JobScope, type ScannerJob, type ScannerOutbox, type ScopeView } from "./outbox";
import type { ProtocolErrorReason } from "./protocol";
import {
  cancelGestures,
  clearAll,
  decideFrame,
  emptySlots,
  expireIdle,
  IDENTITY_IDLE_WORDS,
  REJECT_TEXT,
  resolveActivation,
  type CapturedOrder,
  type ScannerSlot,
} from "./session";

export type WallResultKind = "saved" | "queued" | "rejected" | "already" | "signed_in" | "signed_out" | "info";

export interface WallResult {
  kind: WallResultKind;
  title: string;
  detail?: string;
  scannerId: string | null;
  person?: string;
  order?: string;
  pieces?: number;
  /** F7 dispatch: who framed each framed SKU, as saved. */
  framers?: SavedAttribution[];
  at: number;
}

/**
 * scanner-stations-tuning: shown after any scan the parser could not read.
 * Receiver-wide; stays until a good scan that arrived after it.
 */
export interface ScanRecovery {
  title: string;
  detail: string;
  /** Extra line when the scan named a scanner this station does not know. */
  setupHint: string | null;
  /** Input sequence of the error; only a newer good scan clears it. */
  seq: number;
}

export const RECOVERY_TITLE = "That scan didn't come through.";
export const RECOVERY_DETAIL =
  "Nothing was saved from that scan. Whoever just scanned: scan it again. If it was your badge, scan your badge again before your order.";
export const RECOVERY_SETUP_HINT = "This scanner isn't set up here. Ask a manager to check its scanner ID.";
export const SUPPRESSED_NOTE = "Remove the badge, wait one second, then scan again";
export const REPEAT_HINT = "Remove badge; wait one second before scanning again.";

/** scanner-wall-redesign: one unfinished scan, for its scanner's panel. */
export interface ScanProgress {
  scannerId: string;
  personId: string;
  orderNumber: string;
  mode: ScanMode;
  phase: "received" | "checking" | "saving";
  startedAt: number;
}

/** The oldest unfinished scan on a scanner, with how many are unfinished there. */
export interface SlotProgress extends ScanProgress {
  waiting: number;
}

/** The last order saved on a scanner, for the person who scanned it. */
export interface SlotSaved {
  personId: string;
  orderNumber: string;
  pieces: number;
  mode: ScanMode;
  at: number;
}

/** Who just signed a scanner out with the badge gesture. */
export interface SlotGoodbye {
  personId: string;
  displayName: string;
  at: number;
}

/** Unfinished scans tracked for display, at most (the outbox's own bound). */
export const MAX_TRACKED_PROGRESS = 200;

export interface WallState {
  slots: Record<string, ScannerSlot>;
  last: WallResult | null;
  recovery: ScanRecovery | null;
  /**
   * Short per-scanner hint shown in that scanner's panel (the sign-out
   * repeat guard). Cleared by that scanner's next counted scan.
   */
  slotNotes: Record<string, string>;
  /** Display only: unfinished scans by request id. */
  progress: Record<string, ScanProgress>;
  /** Display only: last saved order per scanner. */
  slotSaved: Record<string, SlotSaved>;
  /** Display only: goodbye after a badge sign-out, per scanner. */
  goodbye: Record<string, SlotGoodbye>;
  /** Bumped on every saved or already-recorded answer, so today's totals re-read. Not a count. */
  saveRevision: number;
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
  /** F7: the receiver's mode. Captured into every new job; old jobs keep theirs. Default framing. */
  mode?: ScanMode;
  outbox: ScannerOutbox;
  activate(a: { requestId: string; scannerId: string; badge: string }): Promise<ActivateOutcome>;
  deliver(): Promise<DeliveryReport | null>;
  isOnline(): boolean;
  now(): number;
  /** Monotonic clock for the sign-out gesture (performance.now()); defaults to now(). */
  elapsedNow?(): number;
  newRequestId(): string;
  sound(kind: SoundKind): void;
}

export class SharedScannerController {
  private s: WallState;
  private listeners = new Set<(s: WallState) => void>();
  private pumping = false;
  private pumpAgain = false;
  private disposed = false;
  /** Order of every input (frames and parser errors), for recovery clearing. */
  private inputSeq = 0;

  get mode(): ScanMode {
    return this.d.mode ?? "framing";
  }

  constructor(private readonly d: ControllerDeps) {
    this.s = {
      slots: emptySlots(d.scannerIds),
      last: null,
      recovery: null,
      slotNotes: {},
      progress: {},
      slotSaved: {},
      goodbye: {},
      saveRevision: 0,
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

  get isDisposed(): boolean {
    return this.disposed;
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

  /**
   * scanner-stations-tuning (CJ): a scan the parser could not read saves
   * nothing and credits nobody, but signs nobody out. A clear recovery
   * message stays up until a newer good scan from any scanner.
   */
  onProtocolError(reason: ProtocolErrorReason, scannerId: string | null): void {
    if (this.disposed) return;
    // Never attributed to a worker; a known source cancels only its own
    // sign-out progress, an unknown one cancels every scanner's.
    const seq = ++this.inputSeq;
    this.set({
      slots: cancelGestures(this.s.slots, scannerId),
      recovery: {
        title: RECOVERY_TITLE,
        detail: RECOVERY_DETAIL,
        setupHint: reason === "unknown_scanner" ? RECOVERY_SETUP_HINT : null,
        seq,
      },
    });
    this.d.sound("error");
  }

  private elapsed(): number {
    return this.d.elapsedNow ? this.d.elapsedNow() : this.d.now();
  }

  private dropGoodbye(scannerId: string): void {
    if (!(scannerId in this.s.goodbye)) return;
    const goodbye = { ...this.s.goodbye };
    delete goodbye[scannerId];
    this.set({ goodbye });
  }

  private setProgress(requestId: string, entry: ScanProgress | null): void {
    const progress = { ...this.s.progress };
    if (entry === null) {
      if (!(requestId in progress)) return;
      delete progress[requestId];
    } else {
      if (!(requestId in progress) && Object.keys(progress).length >= MAX_TRACKED_PROGRESS) return;
      progress[requestId] = entry;
    }
    this.set({ progress });
  }

  /**
   * scanner-wall-redesign: delivery says a job is checking or saving.
   * Display only, fenced to this station's own scope.
   */
  onDeliveryProgress(event: { job: ScannerJob; phase: "checking" | "saving" }): void {
    if (this.disposed) return;
    const j = event.job;
    if (j.backend !== this.d.scope.backend || j.callerId !== this.d.scope.callerId || j.location !== this.d.scope.location) return;
    const prev = this.s.progress[j.requestId];
    this.setProgress(j.requestId, {
      scannerId: j.scannerId, personId: j.personId, orderNumber: j.orderNumber, mode: jobMode(j),
      phase: event.phase, startedAt: prev?.startedAt ?? Date.parse(j.scannedAt),
    });
  }

  private note(scannerId: string, text: string | null): void {
    const has = scannerId in this.s.slotNotes;
    if (text === null && !has) return;
    const slotNotes = { ...this.s.slotNotes };
    if (text === null) delete slotNotes[scannerId];
    else slotNotes[scannerId] = text;
    this.set({ slotNotes });
  }

  /** A good scan that arrived after the current recovery message clears it. */
  private goodScan(seq: number): void {
    const r = this.s.recovery;
    if (r && seq > r.seq) this.set({ recovery: null });
  }

  /** Call for every whole frame. Synchronous decision; effects run after. */
  onFrame(scannerId: string, payload: string): void {
    if (this.disposed) return; // a closed station starts nothing
    const seq = ++this.inputSeq;
    const { slots, decision } = decideFrame(this.s.slots, { scannerId, payload }, {
      online: this.d.isOnline(),
      now: this.d.now(),
      newRequestId: () => this.d.newRequestId(),
      mode: this.mode,
      elapsedNow: this.elapsed(),
    });
    this.set({ slots });
    if (decision.action === "suppressed") {
      // A held badge read again: nothing sent, nothing else changes.
      this.note(scannerId, SUPPRESSED_NOTE);
      return;
    }
    this.note(scannerId, null);
    this.dropGoodbye(scannerId); // the next scan on this scanner ends the goodbye
    switch (decision.action) {
      case "sign_out": {
        const name = decision.person.displayName;
        this.goodScan(seq);
        this.set({ goodbye: { ...this.s.goodbye, [scannerId]: { personId: decision.person.personId, displayName: name, at: this.d.now() } } });
        this.show({
          kind: "signed_out", scannerId, person: name,
          title: `${scannerId} signed out`,
          detail: `${name} is still clocked in. Scan a badge to use ${scannerId}.`,
        }, "ok");
        return;
      }
      case "reject":
        this.show({ kind: "rejected", scannerId, title: `${scannerId}: not saved`, detail: REJECT_TEXT[decision.code] }, "error");
        return;
      case "enqueue":
        void this.enqueue(decision.order, seq);
        return;
      case "activate":
        void this.runActivation(scannerId, decision.epoch, decision.pending.requestId, decision.pending.badge, seq);
        return;
    }
  }

  private async runActivation(scannerId: string, epoch: number, requestId: string, badge: string, seq: number): Promise<void> {
    let res: ActivateOutcome;
    try {
      res = await this.d.activate({ requestId, scannerId, badge });
    } catch (e) {
      res = { outcome: "network_error", message: e instanceof Error ? e.message : String(e) };
    }
    if (this.disposed) return;
    // Dispatch: one sign-in per shift (next site 04:00, at most 12 h), no idle timeout.
    const expiresAt = this.mode === "dispatch" && res.outcome === "activated"
      ? dispatchShiftEnd(this.d.now(), res.workdayEndsAt ?? null)
      : undefined;
    const result =
      res.outcome === "activated"
        ? ({ outcome: "activated", personId: res.personId, displayName: res.displayName, expiresAt } as const)
        : res.outcome === "unknown_badge"
          ? ({ outcome: "unknown_badge" } as const)
          : res.outcome === "unusable_badge"
            ? ({ outcome: "unusable_badge" } as const)
            : ({ outcome: "failed", message: res.message } as const);
    const r = resolveActivation(this.s.slots, scannerId, epoch, requestId, result, this.d.now(), this.elapsed());
    if (r.timedOut) {
      // Too late: ignored, scanner cleared, and the operator is told how to recover.
      this.set({ slots: r.slots });
      this.show({ kind: "rejected", scannerId, title: `${scannerId}: badge check timed out`, detail: REJECT_TEXT.pending_timeout }, "error");
      return;
    }
    if (r.stale) return; // the scanner moved on; never bind an old answer
    this.set({ slots: r.slots });
    if (res.outcome === "activated") {
      this.goodScan(seq);
      const progress = r.slots[scannerId]?.signOut;
      if (progress) {
        this.show({
          kind: "info", scannerId, person: res.displayName,
          title: `${scannerId} · ${res.displayName} · Sign out ${progress.count}/3`,
          detail: REPEAT_HINT,
        }, "ok");
        return;
      }
      const shift = expiresAt !== undefined ? ` Dispatching until ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : "";
      this.show({ kind: "signed_in", scannerId, person: res.displayName, title: `${scannerId}: ${res.displayName}`, detail: (res.clockedIn ? "Signed in and clocked in." : "Signed in.") + shift }, "ok");
      return;
    }
    if (r.order) {
      void this.enqueue(r.order, seq);
      return;
    }
    if (r.rejected) {
      this.show({ kind: "rejected", scannerId, title: `${scannerId}: not saved`, detail: REJECT_TEXT[r.rejected] }, "error");
      return;
    }
    const detail =
      res.outcome === "unknown_badge"
        ? "Badge not recognised at this site. Scanner signed out."
        : res.outcome === "unusable_badge"
          ? "This badge cannot be used here (inactive, or issued at another site). Scanner signed out. For an order with this number, scan its packing slip or #number."
        : res.outcome === "rejected"
          ? `${res.message} Scanner signed out.`
          : `Couldn't reach the server to sign in (${res.message}). Scanner signed out; scan the badge again.`;
    if (res.outcome === "network_error" && res.auth) this.set({ authProblem: true });
    this.show({ kind: "rejected", scannerId, title: `${scannerId}: badge not signed in`, detail }, "error");
  }

  private async enqueue(order: CapturedOrder, seq: number): Promise<void> {
    let job: ScannerJob;
    try {
      job = await this.d.outbox.enqueue(order, this.d.scope, this.d.newRequestId(), this.mode);
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
    this.goodScan(seq);
    // Received only once the scan is durably stored on this device.
    this.setProgress(job.requestId, {
      scannerId: order.scannerId, personId: order.person.personId, orderNumber: order.orderNumber,
      mode: this.mode, phase: "received", startedAt: order.scannedAt,
    });
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
    if (this.disposed) return;
    const { slots, expired, timedOut } = expireIdle(this.s.slots, this.d.now(), this.elapsed());
    if (slots !== this.s.slots && Object.keys(slots).some((id) => slots[id] !== this.s.slots[id])) this.set({ slots });
    if (expired.length === 0 && timedOut.length === 0) return;
    if (timedOut.length > 0) {
      this.show({ kind: "rejected", scannerId: timedOut[0], title: `${timedOut.join(", ")}: badge check timed out`, detail: REJECT_TEXT.pending_timeout }, "error");
      return;
    }
    this.show({
      kind: "info", scannerId: expired[0],
      title: this.mode === "dispatch" ? `${expired.join(", ")} signed out: dispatch shift ended` : `${expired.join(", ")} signed out after ${IDENTITY_IDLE_WORDS} without a scan`,
      detail: "Scan your badge again.",
    }, null);
  }

  /** Clear every identity (auth/site/mode change, operator reset). */
  resetAll(reason: string): void {
    this.set({ slots: clearAll(this.s.slots), slotNotes: {}, goodbye: {} });
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
    if (this.disposed) return;
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
            if (report.kind === "waiting" || report.kind === "superseded") break;
          }
        } while (this.pumpAgain && !this.disposed);
      } finally {
        this.pumping = false;
      }
    })();
  }

  private onReport(r: DeliveryReport): void {
    const j = r.job;
    // Any answer ends this scan's busy state on its panel.
    this.setProgress(j.requestId, null);
    switch (r.kind) {
      case "saved":
        this.set({
          deliveryWaiting: null,
          authProblem: false,
          saveRevision: this.s.saveRevision + 1,
          slotSaved: {
            ...this.s.slotSaved,
            [j.scannerId]: { personId: j.personId, orderNumber: j.orderNumber, pieces: r.result.pieces, mode: jobMode(j), at: this.d.now() },
          },
        });
        this.show({
          kind: "saved", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber, pieces: r.result.pieces,
          title: j.mode === "dispatch" ? `Dispatched #${j.orderNumber}` : `Saved #${j.orderNumber}`,
          framers: r.result.attributions,
          detail: r.result.negativeCodes.length ? `Stock now below zero: ${r.result.negativeCodes.join(", ")}` : undefined,
        }, "ok");
        return;
      case "already_recorded":
        this.set({ deliveryWaiting: null, saveRevision: this.s.saveRevision + 1 });
        this.show({
          kind: "already", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
          title: j.mode === "dispatch" ? `#${j.orderNumber} already dispatched — nothing more saved` : `#${j.orderNumber} already recorded — no extra credit`,
          detail: `${r.reason}. Check the order on the classic station.`,
        }, "error");
        return;
      case "needs_choice":
        this.show({
          kind: "queued", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
          title: `#${j.orderNumber}: framing scan missing`,
          detail: "Not saved yet. Choose who framed it below; other scans keep saving.",
        }, "error");
        return;
      case "blocked":
        if (r.uncertain) {
          // An earlier attempt may have saved it: never claim "not saved" or send people to classic.
          this.show({
            kind: "queued", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
            title: `#${j.orderNumber}: outcome not confirmed yet`,
            detail: `It may already be saved. Do NOT record it on the classic station. Tap Retry when this is fixed: ${r.message}`,
          }, "error");
          return;
        }
        if (CHOICE_CODES.has(r.code)) {
          // Definitely not saved, and fixable here: the dispatcher chooses again.
          this.show({
            kind: "rejected", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
            title: `#${j.orderNumber} not saved — choose who framed it`, detail: r.message,
          }, "error");
          return;
        }
        this.show({
          kind: "rejected", scannerId: j.scannerId, person: j.displayName, order: j.orderNumber,
          title: `#${j.orderNumber} not saved — use the classic station`, detail: r.message,
        }, "error");
        return;

      case "superseded":
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

  /** F7: the dispatcher's framer choice for one waiting dispatch job, then send it. */
  async chooseFramers(requestId: string, choices: readonly FramerChoice[]): Promise<void> {
    try {
      await this.d.outbox.chooseFramers(requestId, this.d.scope, choices);
    } catch (e) {
      this.show({ kind: "rejected", scannerId: null, title: "Framer choice not saved", detail: e instanceof Error ? e.message : String(e) }, "error");
      await this.refreshView();
      return;
    }
    await this.refreshView();
    this.pump();
  }

  async dismiss(requestId: string): Promise<void> {

    await this.d.outbox.dismiss(requestId, this.d.scope);
    await this.refreshView();
  }
}
