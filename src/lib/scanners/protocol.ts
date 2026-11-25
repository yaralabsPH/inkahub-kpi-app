/**
 * F6 shared scanner stations: the wire protocol between cordless scanners
 * and the receiver page.
 *
 * Every scanner is programmed with a prefix and suffix so one keyboard
 * stream can carry three scanners:
 *
 *     <S1>payload</S1>⏎
 *
 * The parser accepts only that whole frame. There is no substring recovery:
 * anything else (stray text, nested or mismatched markers, an unknown
 * scanner id, a frame that is too long or too slow, two scanners typing at
 * once) is an error. Errors whose source cannot be known for certain carry
 * `scannerId: null`; the station then clears every scanner identity.
 *
 * After any error the parser waits for a quiet gap (`quietMs` with no keys)
 * before it accepts a new frame, so the tail of a broken burst can never be
 * read as the start of a good one.
 *
 * Pure and clock-free: the caller passes the time of each key.
 */

export interface ProtocolConfig {
  /** Configured scanner ids, e.g. ["S1", "S2", "S3"]. */
  scannerIds: readonly string[];
  /** Longest whole frame, markers included, before Enter. */
  maxFrameLength: number;
  /** Longest gap between two keys inside one frame. */
  maxGapMs: number;
  /** Longest time from "<" to Enter. */
  maxFrameMs: number;
  /** Silence needed after an error before a new frame is accepted. */
  quietMs: number;
}

export const DEFAULT_SCANNER_IDS = ["S1", "S2", "S3"] as const;

export const DEFAULT_PROTOCOL: ProtocolConfig = {
  scannerIds: DEFAULT_SCANNER_IDS,
  maxFrameLength: 48,
  maxGapMs: 120,
  maxFrameMs: 1500,
  quietMs: 400,
};

/** Payload characters a frame may carry: badges, order numbers, "#". */
const PAYLOAD_RE = /^[A-Za-z0-9#-]{1,32}$/;
/** Scanner ids: short, safe, upper-case ASCII starting with a letter. */
const SCANNER_ID_RE = /^[A-Z][A-Z0-9]{0,3}$/;
/** Structure only; the id and payload are checked separately. */
const FRAME_RE = /^<([^<>/]{1,8})>([^<>]*)<\/([^<>/]{1,8})>$/;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "NumLock", "ScrollLock"]);

export type ProtocolErrorReason =
  | "stray_text"
  | "too_long"
  | "too_slow"
  | "frame_timeout"
  | "bad_structure"
  | "mismatched_markers"
  | "unknown_scanner"
  | "bad_payload"
  | "unexpected_key";

export type ProtocolEvent =
  | { kind: "frame"; scannerId: string; payload: string; at: number }
  | {
      kind: "error";
      reason: ProtocolErrorReason;
      /** Set only when the frame was whole and its source certain. */
      scannerId: string | null;
      at: number;
    };

export function validateScannerIds(ids: readonly string[]): string | null {
  if (ids.length < 1 || ids.length > 3) return "Configure one to three scanners.";
  const seen = new Set<string>();
  for (const id of ids) {
    if (!SCANNER_ID_RE.test(id)) return `Scanner id "${id}" must be 1-4 capital letters/digits starting with a letter.`;
    if (seen.has(id)) return `Scanner id "${id}" is used twice.`;
    seen.add(id);
  }
  return null;
}

export interface FrameParser {
  /** Feed one KeyboardEvent.key at time `at` (ms). */
  key(key: string, at: number): ProtocolEvent[];
  /** Call periodically: reports a frame that stopped half way. */
  tick(at: number): ProtocolEvent[];
  /** Drop any partial frame without reporting (capture paused / page reset). */
  reset(): void;
  /** True while a frame is being received. */
  readonly receiving: boolean;
  /** True after an error until the quiet gap has passed. */
  readonly resyncing: boolean;
}

export function createFrameParser(config: ProtocolConfig = DEFAULT_PROTOCOL): FrameParser {
  const problem = validateScannerIds(config.scannerIds);
  if (problem) throw new Error(problem);
  const ids = new Set(config.scannerIds);

  let buffer: string | null = null; // null = idle
  let frameStart = 0;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  let resync = false;

  const fail = (reason: ProtocolErrorReason, at: number, scannerId: string | null = null): ProtocolEvent[] => {
    buffer = null;
    resync = true;
    return [{ kind: "error", reason, scannerId, at }];
  };

  const finish = (at: number): ProtocolEvent[] => {
    const text = buffer ?? "";
    buffer = null;
    const m = FRAME_RE.exec(text);
    if (!m) return fail("bad_structure", at);
    const [, open, payload, close] = m;
    if (open !== close) return fail("mismatched_markers", at);
    if (!ids.has(open)) return fail("unknown_scanner", at);
    // The frame was whole and its markers agree: the source is certain.
    if (!PAYLOAD_RE.test(payload)) return fail("bad_payload", at, open);
    return [{ kind: "frame", scannerId: open, payload, at }];
  };

  return {
    get receiving() {
      return buffer !== null;
    },
    get resyncing() {
      return resync;
    },
    reset() {
      buffer = null;
      resync = false;
      lastKeyAt = Number.NEGATIVE_INFINITY;
    },
    tick(at: number): ProtocolEvent[] {
      if (buffer !== null && (at - lastKeyAt > config.maxGapMs || at - frameStart > config.maxFrameMs)) {
        return fail("frame_timeout", at);
      }
      return [];
    },
    key(key: string, at: number): ProtocolEvent[] {
      if (MODIFIER_KEYS.has(key)) return [];
      const gap = at - lastKeyAt;
      lastKeyAt = at;

      if (resync) {
        // Still inside (or right after) a broken burst: wait for silence.
        if (gap < config.quietMs) return [];
        resync = false;
      }

      if (buffer !== null) {
        if (gap > config.maxGapMs) return fail("too_slow", at);
        if (at - frameStart > config.maxFrameMs) return fail("frame_timeout", at);
        if (key === "Enter") return finish(at);
        if (key.length !== 1) return fail("unexpected_key", at);
        if (buffer.length + 1 > config.maxFrameLength) return fail("too_long", at);
        buffer += key;
        return [];
      }

      // Idle.
      if (key === "Enter") return []; // a bare Enter carries no text
      if (key === "<") {
        buffer = "<";
        frameStart = at;
        return [];
      }
      if (key.length === 1) return fail("stray_text", at);
      return []; // navigation keys while idle are not scanner text
    },
  };
}

export const PROTOCOL_ERROR_TEXT: Record<ProtocolErrorReason, string> = {
  stray_text: "Text arrived without a scanner prefix.",
  too_long: "Scan was too long.",
  too_slow: "Scan arrived too slowly (keys from two sources?).",
  frame_timeout: "Scan stopped half way.",
  bad_structure: "Scan was not one whole <Sx>…</Sx> frame (two scanners at once?).",
  mismatched_markers: "Scan start and end markers did not match.",
  unknown_scanner: "Scan came from a scanner id this station does not know.",
  bad_payload: "Scan contained characters a badge or order never has.",
  unexpected_key: "An unexpected key arrived inside a scan.",
};
