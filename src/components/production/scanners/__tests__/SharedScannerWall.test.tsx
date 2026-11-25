import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedScannerWall, type SharedScannerWallProps } from "../SharedScannerWall";
import { ScannerHealthView } from "../ScannerHealthCard";
import { emptySlots } from "@/lib/scanners/session";
import type { WallState } from "@/lib/scanners/station";
import type { ScannerJob } from "@/lib/scanners/outbox";
import type { DeviceStatus } from "../useSharedScannerStation";

const noop = () => {};
const device = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  started: true, online: true, focused: true, visible: true, capturePaused: false, wakeLock: "on", audio: "on", ...over,
});
const state = (over: Partial<WallState> = {}): WallState => ({
  slots: emptySlots(["S1", "S2", "S3"]), last: null, recovery: null, slotNotes: {}, progress: {}, slotSaved: {}, goodbye: {}, saveRevision: 0, view: { jobs: [], corrupt: [], waiting: 0, blocked: 0, uncertain: 0 },
  storageError: null, deliveryWaiting: null, authProblem: false, lastAcceptedAt: null, ...over,
});
function render(over: Partial<SharedScannerWallProps> = {}) {
  const props: SharedScannerWallProps = {
    siteLabel: "Australia", receiverLabel: "Framing wall", scannerIds: ["S1", "S2", "S3"], state: state(), device: device(),
    roleAllowed: true, signedIn: true, now: 1_000_000, onStart: noop, onRetry: noop, onDismiss: noop, onSignOutAll: noop, onExit: noop, ...over,
  };
  return renderToStaticMarkup(<SharedScannerWall {...props} />);
}

describe("SharedScannerWall", () => {
  it("asks for the one start gesture until started", () => {
    expect(render({ device: device({ started: false }) })).toContain('data-testid="start-station"');
    expect(render()).not.toContain('data-testid="start-station"');
  });

  it("shows each scanner's person and expiry", () => {
    const slots = emptySlots(["S1", "S2", "S3"]);
    slots.S1 = { ...slots.S1, identity: { personId: "p", displayName: "Alice", badge: "B", activatedAt: 1_000_000, lastFramingAt: 1_000_000 - 60_000 } };
    slots.S2 = { ...slots.S2, pending: { requestId: "r", badge: "X", startedAt: 0, orderFallback: null } };
    const html = render({ state: state({ slots }) });
    expect(html).toContain("Alice");
    expect(html).toContain("Signs out in 14:00");
    expect(html).toContain("Checking badge…"); // an unverified badge never looks signed in
    expect(html).toContain("Scan your badge to start");
  });

  it("green saved with person, order and pieces; amber queued; red not saved", () => {
    const saved = render({ state: state({ last: { kind: "saved", title: "Saved #10190203", scannerId: "S1", person: "Alice", order: "10190203", pieces: 3, at: 1 } }) });
    expect(saved).toContain('data-kind="saved"');
    expect(saved).toContain("SAVED · S1");
    expect(saved).toContain("Alice · #10190203 · 3 pieces");
    const queued = render({ state: state({ last: { kind: "queued", title: "Queued #10190203 for Alice", scannerId: "S1", at: 1 } }) });
    expect(queued).toContain('data-kind="queued"');
    expect(queued).toContain("QUEUED");
    expect(queued).not.toContain('data-kind="saved"');
    const red = render({ state: state({ last: { kind: "rejected", title: "NOT SAVED: #1", scannerId: "S2", at: 1 } }) });
    expect(red).toContain('data-kind="rejected"');
    expect(red).toContain("NOT SAVED · S2");
  });

  it("is loud about offline, storage, focus, paused capture, auth and role", () => {
    const html = render({
      device: device({ online: false, focused: false, capturePaused: true }),
      state: state({ storageError: "QuotaExceededError", authProblem: true, deliveryWaiting: "timeout" }),
      roleAllowed: false,
    });
    for (const text of ["Offline", "Device storage problem", "not focused", "capture is paused", "session has expired", "cannot run shared scanners", "Waiting to save: timeout"]) {
      expect(html).toContain(text);
    }
  });

  it("lists blocked scans with their reason and recovery buttons", () => {
    const job = { requestId: "r1", orderNumber: "10190203", displayName: "Alice", scannerId: "S1", status: "blocked",
      blocked: { code: "cancelled", message: "Order #10190203 is cancelled. Use the classic station for this order.", stage: "prepare" } } as ScannerJob;
    const html = render({ state: state({ view: { jobs: [job], corrupt: [{ key: "k", raw: 1 }], waiting: 0, blocked: 1, uncertain: 0 } }) });
    expect(html).toContain('data-testid="blocked-jobs"');
    expect(html).toContain("is cancelled");
    expect(html).toContain("Retry");
    expect(html).toContain("Recorded on classic");
    expect(html).toContain("cannot be read");
  });

  it("a fresh framing countdown reads 15:00", () => {
    const slots = emptySlots(["S1", "S2", "S3"]);
    slots.S1 = { ...slots.S1, identity: { personId: "p", displayName: "Alice", badge: "B", activatedAt: 1_000_000, lastFramingAt: 1_000_000 } };
    expect(render({ state: state({ slots }) })).toContain("Signs out in 15:00");
  });

  it("shows sign-out progress per scanner, survives another scanner's result, and the suppression note", () => {
    const slots = emptySlots(["S1", "S2", "S3"]);
    slots.S2 = {
      ...slots.S2,
      identity: { personId: "p", displayName: "Ben", badge: "B", activatedAt: 1_000_000, lastFramingAt: 1_000_000 },
      signOut: { badge: "B", personId: "p", displayName: "Ben", firstRepeatAt: 0, count: 2 },
    };
    const html = render({
      state: state({
        slots,
        slotNotes: { S2: "Remove the badge, wait one second, then scan again" },
        last: { kind: "saved", title: "Saved #10190203", scannerId: "S1", person: "Alice", order: "10190203", pieces: 1, at: 1 },
      }),
    });
    expect(html).toContain('data-testid="signout-S2"');
    expect(html).toContain("S2 · Ben · Sign out 2/3");
    expect(html).toContain("Remove badge; wait one second before scanning again.");
    expect(html).toContain("Remove the badge, wait one second, then scan again");
    expect(html).toContain('data-kind="saved"');
    const out = render({ state: state({ last: { kind: "signed_out", title: "S2 signed out", detail: "Ben is still clocked in. Scan a badge to use S2.", scannerId: "S2", person: "Ben", at: 1 } }) });
    expect(out).toContain("SIGNED OUT");
    expect(out).not.toContain("SIGNED IN");
    expect(out).toContain("Ben is still clocked in. Scan a badge to use S2.");
  });

  it("recovery stays visible beside an earlier saved result", () => {
    for (const mode of ["framing", "dispatch"] as const) {
      const html = render({
        mode,
        state: state({
          last: { kind: "saved", title: "Saved #10190203", scannerId: "S1", person: "Alice", order: "10190203", pieces: 3, at: 1 },
          recovery: { title: "That scan didn't come through.", detail: "Nothing was saved from that scan.", setupHint: null, seq: 4 },
        }),
      });
      expect(html).toContain('data-testid="scan-recovery"');
      expect(html).toContain("That scan didn&#x27;t come through.");
      expect(html).toContain('data-kind="saved"');
      expect(html).not.toContain("isn&#x27;t set up here");
    }
  });

  it("unknown scanner adds setup instruction", () => {
    for (const mode of ["framing", "dispatch"] as const) {
      const html = render({
        mode,
        state: state({ recovery: { title: "That scan didn't come through.", detail: "x", setupHint: "This scanner isn't set up here. Ask a manager to check its scanner ID.", seq: 1 } }),
      });
      expect(html).toContain("isn&#x27;t set up here. Ask a manager to check its scanner ID.");
    }
  });

  it("R1-2: an uncertain blocked scan never offers classic re-recording", () => {
    const job = { requestId: "r2", orderNumber: "10190204", displayName: "Bob", scannerId: "S2", status: "blocked", uncertain: true,
      blocked: { code: "forbidden_role", message: "Only an owner, manager or kiosk account can run shared scanners.", stage: "commit" } } as ScannerJob;
    const html = render({ state: state({ view: { jobs: [job], corrupt: [], waiting: 0, blocked: 1, uncertain: 1 } }) });
    expect(html).toContain("may already have saved this");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Recorded on classic");
  });
});

describe("ScannerHealthView", () => {
  it("shows stale receivers in red", () => {
    const html = renderToStaticMarkup(
      <ScannerHealthView zone="Australia/Sydney" now={new Date("2026-11-23T23:00:00Z")} rows={[
        { receiver_id: "rcv-1", label: "Wall", heartbeat_at: "2026-11-23T22:50:00Z", last_scan_at: null, queue_count: 0, blocked_count: 0 },
      ]} />,
    );
    expect(html).toContain('data-level="bad"');
    expect(html).toContain("No heartbeat");
  });
});
