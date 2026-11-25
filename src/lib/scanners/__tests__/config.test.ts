import { describe, expect, it } from "vitest";
import {
  loadSharedScannerConfig,
  minutesIntoWorkHours,
  receiverStatus,
  saveSharedScannerConfig,
  SHARED_SCANNER_KEY,
  type ReceiverRow,
} from "../config";

function mem(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("device config", () => {
  it("round-trips and rejects unsafe values", () => {
    const s = mem();
    expect(loadSharedScannerConfig(s)).toBeNull();
    saveSharedScannerConfig(s, { enabled: true, receiverId: "rcv-abc", label: "Wall", scannerIds: ["S1", "S2"] });
    // An F6 config (no mode) reads as framing; F7 dispatch round-trips; anything else is framing.
    expect(loadSharedScannerConfig(s)).toEqual({ enabled: true, receiverId: "rcv-abc", label: "Wall", scannerIds: ["S1", "S2"], mode: "framing" });
    saveSharedScannerConfig(s, { enabled: true, receiverId: "rcv-abc", label: "Desk", scannerIds: ["S1"], mode: "dispatch" });
    expect(loadSharedScannerConfig(s)?.mode).toBe("dispatch");
    expect(loadSharedScannerConfig(mem({ [SHARED_SCANNER_KEY]: '{"enabled":true,"receiverId":"r","mode":"x"}' }))?.mode).toBe("framing");

    expect(loadSharedScannerConfig(mem({ [SHARED_SCANNER_KEY]: '{"enabled":true,"receiverId":"bad id"}' }))).toBeNull();
    expect(loadSharedScannerConfig(mem({ [SHARED_SCANNER_KEY]: '{"enabled":true,"receiverId":"r","scannerIds":["S1","S1"]}' }))).toBeNull();
    expect(loadSharedScannerConfig(mem({ [SHARED_SCANNER_KEY]: "not json" }))).toBeNull();
    expect(loadSharedScannerConfig(null)).toBeNull();
  });
});

describe("receiver health", () => {
  // Tuesday 2026-11-24 10:00 in Sydney (UTC+11) = 23:00 UTC Monday.
  const tueMorningAu = new Date("2026-11-23T23:00:00Z");
  const row = (over: Partial<ReceiverRow> = {}): ReceiverRow => ({
    receiver_id: "rcv-1", label: "Wall", heartbeat_at: "2026-11-23T22:59:30Z", last_scan_at: "2026-11-23T22:50:00Z",
    queue_count: 0, blocked_count: 0, ...over,
  });

  it("uses site-local weekday hours", () => {
    expect(minutesIntoWorkHours(tueMorningAu, "Australia/Sydney")).toBe(120);
    expect(minutesIntoWorkHours(tueMorningAu, "Europe/London")).toBeNull(); // 23:00 Monday in London
    expect(minutesIntoWorkHours(new Date("2026-11-28T01:00:00Z"), "Australia/Sydney")).toBeNull(); // Saturday
  });

  it("is ok when fresh and busy", () => {
    expect(receiverStatus(row(), tueMorningAu, "Australia/Sydney")).toEqual({ level: "ok", problems: [] });
  });

  it("flags a heartbeat older than 3 minutes", () => {
    const s = receiverStatus(row({ heartbeat_at: "2026-11-23T22:56:00Z" }), tueMorningAu, "Australia/Sydney");
    expect(s.level).toBe("bad");
    expect(s.problems[0]).toMatch(/heartbeat/);
  });

  it("flags 30 minutes without scans only inside work hours", () => {
    const quiet = row({ last_scan_at: "2026-11-23T22:20:00Z" });
    expect(receiverStatus(quiet, tueMorningAu, "Australia/Sydney").level).toBe("warn");
    expect(receiverStatus(quiet, tueMorningAu, "Europe/London").level).toBe("ok");
    // 08:10 local: work only just started, no warning yet.
    expect(receiverStatus(row({ last_scan_at: null, heartbeat_at: "2026-11-23T21:09:50Z" }), new Date("2026-11-23T21:10:00Z"), "Australia/Sydney").level).toBe("ok");
  });

  it("shows blocked and waiting scans", () => {
    expect(receiverStatus(row({ blocked_count: 2 }), tueMorningAu, "Australia/Sydney").level).toBe("bad");
    expect(receiverStatus(row({ queue_count: 3 }), tueMorningAu, "Australia/Sydney")).toMatchObject({ level: "warn" });
  });
});
