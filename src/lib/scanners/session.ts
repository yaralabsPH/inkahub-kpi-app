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

export interface PendingActivation {
  requestId: string;
  badge: string;
  startedAt: number;
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
}

export type Slots = Readonly<Record<string, ScannerSlot>>;

export function emptySlots(scannerIds: readonly string[]): Record<string, ScannerSlot> {
  const out: Record<string, ScannerSlot> = {};
  for (const id of scannerIds) out[id] = { scannerId: id, identity: null, pending: null, epoch: 0 };
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
  | { action: "reject"; scannerId: string; code: RejectCode; clearedIdentity: boolean };

function isExpired(identity: ActiveIdentity, now: number): boolean {
  if (identity.expiresAt !== undefined) return now >= identity.expiresAt;
  return now - identity.lastFramingAt > IDENTITY_IDLE_MS;
}

function cleared(slot: ScannerSlot): ScannerSlot {
  return { ...slot, identity: null, pending: null, epoch: slot.epoch + 1 };
}

/**
 * Decide what one whole frame means and return the new slots. Everything the
 * caller needs (the captured person, the activation request) is in the
 * decision, taken before any await.
 */
export function decideFrame(
  slots: Slots,
  frame: { scannerId: string; payload: string },
  ctx: { online: boolean; now: number; newRequestId: () => string },
): { slots: Record<string, ScannerSlot>; decision: FrameDecision } {
  const next: Record<string, ScannerSlot> = { ...slots };
  const slot = slots[frame.scannerId];
  if (!slot) {
    return { slots: next, decision: { action: "reject", scannerId: frame.scannerId, code: "unknown_scanner", clearedIdentity: false } };
  }
  const shape = classifyPayload(frame.payload);

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
    next[scannerId] = {
      ...slot,
      pending: null,
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
  next[scannerId] = { ...slot, pending: null };
  return { slots: next, stale: false, order: null, rejected: null };
}

/** Expire idle identities and over-long badge checks. Returns the ids cleared. */
export function expireIdle(
  slots: Slots,
  now: number,
): { slots: Record<string, ScannerSlot>; expired: string[]; timedOut: string[] } {
  const next: Record<string, ScannerSlot> = { ...slots };
  const expired: string[] = [];
  const timedOut: string[] = [];
  for (const [id, slot] of Object.entries(slots)) {
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

/** Clear every scanner (reload, account/site/mode change, operator reset). */
export function clearAll(slots: Slots): Record<string, ScannerSlot> {
  const next: Record<string, ScannerSlot> = {};
  for (const [id, slot] of Object.entries(slots)) next[id] = cleared(slot);
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
