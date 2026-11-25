/**
 * F6 shared scanner stations: who each scanner is working for.
 *
 * Each scanner has its own identity. A badge scan clears the old person at
 * once and starts an online activation; an order scan is accepted only for
 * an active, unexpired person and captures that person synchronously, so a
 * later badge scan can never re-credit it. Pure: the station hook performs
 * the network work these decisions ask for.
 */

/** Fifteen minutes without a framing scan ends a scanner's identity (scanner-stations-tuning). */
export const IDENTITY_IDLE_MS = 15 * 60 * 1000;
/** The same limit in words, for every screen that mentions it. */
export const IDENTITY_IDLE_WORDS = "15 minutes";
/** A badge sign-in/lookup answer later than this is ignored and the scanner cleared. */
export const PENDING_MAX_MS = 20 * 1000;
/**
 * scanner-stations-tuning sign-out gesture (Framing only): an active worker
 * scans their own badge three more times on the same scanner. Each counted
 * repeat needs at least this gap since the last read of that badge there, so
 * a badge held under the scanner cannot count,
 */
export const SIGN_OUT_REPEAT_GAP_MS = 1_000;
/** and all three repeats fall within this window, first to third inclusive. */
export const SIGN_OUT_WINDOW_MS = 10_000;
export const SIGN_OUT_REPEATS = 3;

export interface ScannerPerson {
  personId: string;
  displayName: string;
  badge: string;
}

export interface ActiveIdentity extends ScannerPerson {
  activatedAt: number;
  lastFramingAt: number;
  /**
   * F7 dispatch shift: absolute end of this identity (next site 04:00, at
   * most twelve hours). When set there is no idle timeout.
   */
  expiresAt?: number;
}

/** Sign-out gesture progress after one or two counted repeats. */
export interface SignOutProgress {
  badge: string;
  personId: string;
  displayName: string;
  /** Elapsed-clock arrival time of the first counted repeat. */
  firstRepeatAt: number;
  count: 1 | 2;
}

export interface PendingActivation {
  requestId: string;
  badge: string;
  startedAt: number;
  /**
   * Set when this activation is a counted own-badge repeat: the progress it
   * proposes once the server confirms the badge, valid only while the slot's
   * gesture generation is unchanged.
   */
  repeat?: { gen: number; progress: SignOutProgress } | null;
  /**
   * Set when the payload could also be an order number (eight digits
   * starting 10). If the server says it is not a badge, the order is
   * queued for this person, captured when the scan arrived.
   */
  orderFallback: { orderNumber: string; person: ActiveIdentity | null } | null;
}

export interface ScannerSlot {
  scannerId: string;
  identity: ActiveIdentity | null;
  pending: PendingActivation | null;
  /** Bumped whenever the slot is cleared; stale async results are ignored. */
  epoch: number;
  /** Last complete read of a badge on this scanner (elapsed clock), for the repeat guard. */
  lastRead: { badge: string; at: number } | null;
  /** Sign-out gesture progress, or null. */
  signOut: SignOutProgress | null;
  /** Bumped whenever gesture progress is cancelled; a late reply cannot revive it. */
  gestureGen: number;
}

export type Slots = Readonly<Record<string, ScannerSlot>>;

export function emptySlots(scannerIds: readonly string[]): Record<string, ScannerSlot> {
  const out: Record<string, ScannerSlot> = {};
  for (const id of scannerIds) out[id] = { scannerId: id, identity: null, pending: null, epoch: 0, lastRead: null, signOut: null, gestureGen: 0 };
  return out;
}

// ---------------------------------------------------------------------------
// Payload shapes (pinned)
// ---------------------------------------------------------------------------

export type PayloadShape =
  /** Eight hex characters: a badge, or (all digits, starting 10) maybe an order. */
  | { kind: "hex8"; badge: string; orderCandidate: string | null }
  /** Unambiguous order: six-digit packing-slip code, or "#" + full order. */
  | { kind: "order"; orderNumber: string; shape: "six_digit" | "hash_full" }
  | { kind: "invalid" };

const FULL_ORDER_RE = /^10\d{6}$/;

/**
 * Supported shapes, nothing else:
 *   - 8 hex characters                 -> badge first (order if all digits, 10xxxxxx, and not a badge)
 *   - 6 digits                         -> legacy packing slip, order "10" + digits
 *   - "#" + 8 digits starting with 10  -> full order, explicitly not a badge
 */
export function classifyPayload(payload: string): PayloadShape {
  const p = payload.trim();
  if (/^[0-9A-Fa-f]{8}$/.test(p)) {
    return { kind: "hex8", badge: p.toUpperCase(), orderCandidate: FULL_ORDER_RE.test(p) ? p : null };
  }
  if (/^\d{6}$/.test(p)) return { kind: "order", orderNumber: `10${p}`, shape: "six_digit" };
  const hash = /^#(\d{8})$/.exec(p);
  if (hash && FULL_ORDER_RE.test(hash[1])) return { kind: "order", orderNumber: hash[1], shape: "hash_full" };
  return { kind: "invalid" };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type RejectCode =
  | "invalid_payload"
  | "badge_offline"
  | "ambiguous_offline"
  | "badge_pending"
  | "no_person"
  | "identity_expired"
  | "pending_timeout"
  | "shift_ended"
  | "unknown_scanner";

export const REJECT_TEXT: Record<RejectCode, string> = {
  invalid_payload: "Not a badge or a supported order barcode.",
  badge_offline: "Badge scanned while offline. Badges sign in online only. Scanner cleared.",
  ambiguous_offline: "Offline: this 8-digit scan could be a badge or an order. Not saved. Scanner cleared; scan the packing-slip barcode, or wait for the network.",
  badge_pending: "Still checking the previous scan on this scanner. This scan was NOT saved: scan it again in a moment.",
  pending_timeout: "Checking the badge took too long. Scanner signed out: scan the badge again, then any order not shown as queued.",
  no_person: "Scan your badge on this scanner first.",
  identity_expired: `Signed out after ${IDENTITY_IDLE_WORDS} without a scan. Scan your badge again.`,
  shift_ended: "Your dispatch sign-in ended (04:00 workday change or 12 hours). Scan your badge again.",
  unknown_scanner: "This scanner is not configured on this station.",
};

export interface CapturedOrder {
  scannerId: string;
  orderNumber: string;
  person: ScannerPerson;
  /** Wall-clock UTC ms when the scan arrived. */
  scannedAt: number;
}

export type FrameDecision =
  | { action: "activate"; scannerId: string; pending: PendingActivation; epoch: number }
  | { action: "enqueue"; order: CapturedOrder }
  | { action: "reject"; scannerId: string; code: RejectCode; clearedIdentity: boolean }
  /** Third counted own-badge repeat: this scanner is signed out (not clocked out). */
  | { action: "sign_out"; scannerId: string; person: ScannerPerson }
  /** The same badge read again too soon: ignored, nothing sent. */
  | { action: "suppressed"; scannerId: string };

function isExpired(identity: ActiveIdentity, now: number): boolean {
  if (identity.expiresAt !== undefined) return now >= identity.expiresAt;
  return now - identity.lastFramingAt > IDENTITY_IDLE_MS;
}

/** Clear the person and any check; the last badge read is kept for the repeat guard. */
function cleared(slot: ScannerSlot): ScannerSlot {
  return { ...slot, identity: null, pending: null, epoch: slot.epoch + 1, signOut: null, gestureGen: slot.gestureGen + 1 };
}

/** Cancel sign-out progress (and any repeat still being checked) without touching the person. */
function cancelGesture(slot: ScannerSlot): ScannerSlot {
  if (!slot.signOut && !slot.pending?.repeat) return slot;
  return { ...slot, signOut: null, gestureGen: slot.gestureGen + 1 };
}

function progressExpired(p: SignOutProgress, elapsed: number): boolean {
  return elapsed - p.firstRepeatAt > SIGN_OUT_WINDOW_MS;
}

/**
 * Decide what one whole frame means and return the new slots. Everything the
 * caller needs (the captured person, the activation request) is in the
 * decision, taken before any await.
 */
export function decideFrame(
  slots: Slots,
  frame: { scannerId: string; payload: string },
  ctx: {
    online: boolean;
    now: number;
    newRequestId: () => string;
    /** Default framing. Dispatch has no sign-out gesture or repeat guard. */
    mode?: "framing" | "dispatch";
    /** Monotonic clock for the gesture; defaults to `now`. */
    elapsedNow?: number;
  },
): { slots: Record<string, ScannerSlot>; decision: FrameDecision } {
  const next: Record<string, ScannerSlot> = { ...slots };
  const found = slots[frame.scannerId];
  if (!found) {
    return { slots: next, decision: { action: "reject", scannerId: frame.scannerId, code: "unknown_scanner", clearedIdentity: false } };
  }
  const framing = (ctx.mode ?? "framing") === "framing";
  const elapsed = ctx.elapsedNow ?? ctx.now;
  const shape = classifyPayload(frame.payload);
  let slot = found;

  // Timed-out progress is gone before anything else is decided.
  if (slot.signOut && progressExpired(slot.signOut, elapsed)) slot = { ...slot, signOut: null, gestureGen: slot.gestureGen + 1 };

  if (framing && shape.kind === "hex8" && ctx.online) {
    // Rolling repeat guard: the same badge read again within the gap is
    // ignored, and the gap restarts from this read.
    const lr = slot.lastRead;
    if (lr && lr.badge === shape.badge && elapsed - lr.at < SIGN_OUT_REPEAT_GAP_MS) {
      next[slot.scannerId] = { ...slot, lastRead: { badge: shape.badge, at: elapsed } };
      return { slots: next, decision: { action: "suppressed", scannerId: slot.scannerId } };
    }
    slot = { ...slot, lastRead: { badge: shape.badge, at: elapsed } };

    // A counted own-badge repeat: only an already verified, unexpired person.
    const id = slot.identity;
    if (!slot.pending && id && id.badge === shape.badge && !isExpired(id, ctx.now)) {
      const prev = slot.signOut && slot.signOut.badge === shape.badge && slot.signOut.personId === id.personId ? slot.signOut : null;
      if (prev && prev.count === SIGN_OUT_REPEATS - 1) {
        const person: ScannerPerson = { personId: id.personId, displayName: id.displayName, badge: id.badge };
        next[slot.scannerId] = cleared(slot);
        return { slots: next, decision: { action: "sign_out", scannerId: slot.scannerId, person } };
      }
      const progress: SignOutProgress = {
        badge: id.badge, personId: id.personId, displayName: id.displayName,
        firstRepeatAt: prev ? prev.firstRepeatAt : elapsed,
        count: prev ? 2 : 1,
      };
      // The check runs through the normal sign-in (it never clocks in twice);
      // the progress only counts once the server confirms the badge.
      const pending: PendingActivation = {
        requestId: ctx.newRequestId(), badge: shape.badge, startedAt: ctx.now, orderFallback: null,
        repeat: { gen: slot.gestureGen, progress },
      };
      const s: ScannerSlot = { ...slot, identity: null, pending, epoch: slot.epoch + 1, signOut: prev };
      next[slot.scannerId] = s;
      return { slots: next, decision: { action: "activate", scannerId: slot.scannerId, pending, epoch: s.epoch } };
    }
  }

  // Anything else on this scanner cancels sign-out progress, even if refused.
  if (framing) slot = cancelGesture(slot);
  next[slot.scannerId] = slot;

  if (shape.kind === "invalid") {
    return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code: "invalid_payload", clearedIdentity: false } };
  }

  if (shape.kind === "hex8") {
    if (!ctx.online) {
      // Never guess offline, and never let a badge attempt fall back to the old person.
      next[slot.scannerId] = cleared(slot);
      const code: RejectCode = shape.orderCandidate ? "ambiguous_offline" : "badge_offline";
      return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code, clearedIdentity: slot.identity !== null } };
    }
    // One check at a time per scanner: a second badge/8-digit scan while the
    // first is still being looked up is refused loudly and the first is kept.
    if (slot.pending) {
      return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code: "badge_pending", clearedIdentity: false } };
    }
    // Online: badge first. The old person is cleared immediately; an
    // order-shaped value keeps the captured person only as a fallback.
    const fallbackPerson = slot.identity && !isExpired(slot.identity, ctx.now) ? slot.identity : null;
    const pending: PendingActivation = {
      requestId: ctx.newRequestId(),
      badge: shape.badge,
      startedAt: ctx.now,
      orderFallback: shape.orderCandidate ? { orderNumber: shape.orderCandidate, person: fallbackPerson } : null,
    };
    const s = { ...cleared(slot), pending };
    next[slot.scannerId] = s;
    return { slots: next, decision: { action: "activate", scannerId: slot.scannerId, pending, epoch: s.epoch } };
  }

  // Unambiguous order.
  if (slot.pending) {
    return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code: "badge_pending", clearedIdentity: false } };
  }
  if (!slot.identity) {
    return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code: "no_person", clearedIdentity: false } };
  }
  if (isExpired(slot.identity, ctx.now)) {
    next[slot.scannerId] = cleared(slot);
    const code: RejectCode = slot.identity.expiresAt !== undefined ? "shift_ended" : "identity_expired";
    return { slots: next, decision: { action: "reject", scannerId: slot.scannerId, code, clearedIdentity: true } };
  }
  const person: ScannerPerson = {
    personId: slot.identity.personId,
    displayName: slot.identity.displayName,
    badge: slot.identity.badge,
  };
  next[slot.scannerId] = { ...slot, identity: { ...slot.identity, lastFramingAt: ctx.now } };
  return {
    slots: next,
    decision: { action: "enqueue", order: Object.freeze({ scannerId: slot.scannerId, orderNumber: shape.orderNumber, person: Object.freeze(person), scannedAt: ctx.now }) },
  };
}

export type ActivationResult =
  | { outcome: "activated"; personId: string; displayName: string; expiresAt?: number }
  | { outcome: "unknown_badge" }
  /** A badge that exists but cannot be used here: never an order fallback. */
  | { outcome: "unusable_badge" }
  | { outcome: "failed"; message: string };

/**
 * Apply the answer to an activation. Ignored (stale: true) when the slot was
 * cleared or re-scanned since, so a slow answer can never bind a person to
 * a scanner that has moved on.
 */
export function resolveActivation(
  slots: Slots,
  scannerId: string,
  epoch: number,
  requestId: string,
  result: ActivationResult,
  now: number,
  /** Monotonic clock for the gesture window; defaults to `now`. */
  elapsedNow?: number,
): {
  slots: Record<string, ScannerSlot>;
  stale: boolean;
  /** The answer came after PENDING_MAX_MS: ignored, scanner cleared. */
  timedOut?: boolean;
  /** An order-shaped scan that turned out not to be a badge. */
  order: CapturedOrder | null;
  rejected: RejectCode | null;
} {
  const next: Record<string, ScannerSlot> = { ...slots };
  const slot = slots[scannerId];
  if (!slot || slot.epoch !== epoch || slot.pending?.requestId !== requestId) {
    return { slots: next, stale: true, order: null, rejected: null };
  }
  const pending = slot.pending;
  if (now - pending.startedAt > PENDING_MAX_MS) {
    next[scannerId] = cleared(slot);
    return { slots: next, stale: true, timedOut: true, order: null, rejected: "pending_timeout" };
  }
  if (result.outcome === "activated") {
    // A confirmed own-badge repeat counts only if nothing cancelled the
    // gesture meanwhile and its window has not run out.
    const rp = pending.repeat;
    const elapsed = elapsedNow ?? now;
    const signOut = rp && rp.gen === slot.gestureGen && rp.progress.personId === result.personId && !progressExpired(rp.progress, elapsed)
      ? rp.progress
      : null;
    next[scannerId] = {
      ...slot,
      pending: null,
      signOut,
      gestureGen: signOut || !rp ? slot.gestureGen : slot.gestureGen + 1,
      identity: {
        personId: result.personId, displayName: result.displayName, badge: pending.badge, activatedAt: now, lastFramingAt: now,
        ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
      },
    };
    return { slots: next, stale: false, order: null, rejected: null };
  }
  if (result.outcome === "unknown_badge" && pending.orderFallback) {
    const fb = pending.orderFallback;
    if (!fb.person) {
      next[scannerId] = { ...slot, pending: null };
      return { slots: next, stale: false, order: null, rejected: "no_person" };
    }
    // Not a badge: it was an order for the person captured at scan time.
    // Inactivity counts from that scan, never from the slower answer, so a
    // late reply cannot revive an expired person.
    const restored: ActiveIdentity = { ...fb.person, lastFramingAt: pending.startedAt };
    next[scannerId] = { ...slot, pending: null, identity: isExpired(restored, now) ? null : restored };
    const order: CapturedOrder = Object.freeze({
      scannerId,
      orderNumber: fb.orderNumber,
      person: Object.freeze({ personId: fb.person.personId, displayName: fb.person.displayName, badge: fb.person.badge }),
      scannedAt: pending.startedAt,
    });
    return { slots: next, stale: false, order, rejected: null };
  }
  // Unknown badge (not an order shape) or a failed lookup: the old person
  // stays cleared. A lookup failure never falls through to order handling.
  next[scannerId] = { ...slot, pending: null, signOut: null, gestureGen: slot.gestureGen + 1 };
  return { slots: next, stale: false, order: null, rejected: null };
}

/** Expire idle identities and over-long badge checks. Returns the ids cleared. */
export function expireIdle(
  slots: Slots,
  now: number,
  /** Monotonic clock for the gesture window; defaults to `now`. */
  elapsedNow?: number,
): { slots: Record<string, ScannerSlot>; expired: string[]; timedOut: string[] } {
  const next: Record<string, ScannerSlot> = { ...slots };
  const expired: string[] = [];
  const timedOut: string[] = [];
  const elapsed = elapsedNow ?? now;
  for (const [id, found] of Object.entries(slots)) {
    let slot = found;
    if (slot.signOut && progressExpired(slot.signOut, elapsed)) {
      slot = { ...slot, signOut: null, gestureGen: slot.gestureGen + 1 };
      next[id] = slot;
    }
    if (slot.pending && now - slot.pending.startedAt > PENDING_MAX_MS) {
      next[id] = cleared(slot);
      timedOut.push(id);
    } else if (slot.identity && isExpired(slot.identity, now)) {
      next[id] = cleared(slot);
      expired.push(id);
    }
  }
  return { slots: next, expired, timedOut };
}

/** Clear every scanner (reload, account/site/mode change, operator reset), gesture and read state too. */
export function clearAll(slots: Slots): Record<string, ScannerSlot> {
  const next: Record<string, ScannerSlot> = {};
  for (const [id, slot] of Object.entries(slots)) next[id] = { ...cleared(slot), lastRead: null };
  return next;
}

/**
 * A parser error cancels sign-out progress: on its scanner when the source
 * is known, on every scanner when it is not. People and checks are kept.
 */
export function cancelGestures(slots: Slots, scannerId: string | null): Record<string, ScannerSlot> {
  const next: Record<string, ScannerSlot> = { ...slots };
  for (const [id, slot] of Object.entries(slots)) {
    if (scannerId === null || id === scannerId) next[id] = cancelGesture(slot);
  }
  return next;
}

/** Clear one scanner (a whole but rejected frame from a known scanner). */
export function clearOne(slots: Slots, scannerId: string): Record<string, ScannerSlot> {
  const slot = slots[scannerId];
  if (!slot) return { ...slots };
  return { ...slots, [scannerId]: cleared(slot) };
}

/** Ms until this identity expires, or null. */
export function msUntilExpiry(identity: ActiveIdentity | null, now: number): number | null {
  if (!identity) return null;
  if (identity.expiresAt !== undefined) return Math.max(0, identity.expiresAt - now);
  return Math.max(0, identity.lastFramingAt + IDENTITY_IDLE_MS - now);
}
