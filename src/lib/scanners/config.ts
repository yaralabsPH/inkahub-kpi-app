/**
 * F6 shared scanner stations: this device's opt-in setting and the tiny
 * receiver-health rule. Pure apart from the storage passed in.
 */
import { DEFAULT_SCANNER_IDS, validateScannerIds } from "./protocol";
import type { ScanMode } from "./dispatch";

export const SHARED_SCANNER_KEY = "inkaar.production.sharedScanners";

export interface SharedScannerConfig {
  enabled: boolean;
  /** Stable id of this receiver page/device, e.g. "rcv-k3j9x2ab". */
  receiverId: string;
  /** Free text shown on the health card, e.g. "Framing wall". */
  label: string;
  scannerIds: string[];
  /** F7: what new scans on this receiver record. Absent (F6 configs) = framing. */
  mode?: ScanMode;
}

type KV = Pick<Storage, "getItem" | "setItem">;

const RECEIVER_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function newReceiverId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return "rcv-" + Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

export function loadSharedScannerConfig(storage: KV | null): SharedScannerConfig | null {
  try {
    const raw = storage?.getItem(SHARED_SCANNER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SharedScannerConfig>;
    if (typeof p !== "object" || p === null) return null;
    if (typeof p.receiverId !== "string" || !RECEIVER_RE.test(p.receiverId)) return null;
    const ids = Array.isArray(p.scannerIds) ? p.scannerIds.filter((x): x is string => typeof x === "string") : [...DEFAULT_SCANNER_IDS];
    if (validateScannerIds(ids)) return null;
    return {
      enabled: p.enabled === true,
      receiverId: p.receiverId,
      label: typeof p.label === "string" ? p.label.slice(0, 60) : "",
      scannerIds: ids,
      mode: p.mode === "dispatch" ? "dispatch" : "framing",
    };

  } catch {
    return null;
  }
}

export function saveSharedScannerConfig(storage: KV | null, cfg: SharedScannerConfig): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SHARED_SCANNER_KEY, JSON.stringify(cfg));
    return true;
  } catch {
    return false;
  }
}

export function browserStorage(): KV | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Receiver health (no history, no alerts: a status card only)
// ---------------------------------------------------------------------------

export const HEARTBEAT_EVERY_MS = 60_000;
export const STALE_HEARTBEAT_MS = 3 * 60_000;
export const QUIET_SCANS_MS = 30 * 60_000;

/** Site-local work hours for the "no scans" warning. Code default; no admin UI. */
export interface WorkHours {
  /** 1 = Monday ... 7 = Sunday. */
  days: number[];
  startHour: number;
  endHour: number;
}
export const DEFAULT_WORK_HOURS: WorkHours = { days: [1, 2, 3, 4, 5], startHour: 8, endHour: 18 };

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function localParts(now: Date, zone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: WEEKDAY[get("weekday")] ?? 0, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Minutes since work started today (site-local), or null outside work hours. */
export function minutesIntoWorkHours(now: Date, zone: string, hours: WorkHours = DEFAULT_WORK_HOURS): number | null {
  const { day, minutes } = localParts(now, zone);
  if (!hours.days.includes(day)) return null;
  if (minutes < hours.startHour * 60 || minutes >= hours.endHour * 60) return null;
  return minutes - hours.startHour * 60;
}

export interface ReceiverRow {
  receiver_id: string;
  label: string;
  heartbeat_at: string;
  last_scan_at: string | null;
  queue_count: number;
  blocked_count: number;
}

export interface ReceiverStatus {
  level: "ok" | "warn" | "bad";
  problems: string[];
}

export function receiverStatus(row: ReceiverRow, now: Date, zone: string, hours: WorkHours = DEFAULT_WORK_HOURS): ReceiverStatus {
  const problems: string[] = [];
  let level: ReceiverStatus["level"] = "ok";
  const beat = Date.parse(row.heartbeat_at);
  if (!Number.isFinite(beat) || now.getTime() - beat > STALE_HEARTBEAT_MS) {
    problems.push("No heartbeat for over 3 minutes: the receiver page is closed, asleep or offline.");
    level = "bad";
  }
  const into = minutesIntoWorkHours(now, zone, hours);
  if (into !== null && into >= QUIET_SCANS_MS / 60_000) {
    const last = row.last_scan_at ? Date.parse(row.last_scan_at) : NaN;
    if (!Number.isFinite(last) || now.getTime() - last > QUIET_SCANS_MS) {
      problems.push("No accepted scans for over 30 minutes during work hours.");
      if (level === "ok") level = "warn";
    }
  }
  if (row.blocked_count > 0) {
    problems.push(`${row.blocked_count} scan(s) blocked on the receiver: open it to retry or record them on the classic station.`);
    level = "bad";
  }
  if (row.queue_count > 0 && level === "ok") {
    problems.push(`${row.queue_count} scan(s) waiting to send.`);
    level = "warn";
  }
  return { level, problems };
}
