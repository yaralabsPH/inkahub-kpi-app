import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedScannerWall, type SharedScannerWallProps } from "../SharedScannerWall";
import { emptySlots } from "@/lib/scanners/session";
import type { WallState } from "@/lib/scanners/station";
import type { ScannerJob } from "@/lib/scanners/outbox";
import type { DeviceStatus } from "../useSharedScannerStation";

const noop = () => {};
const device = (): DeviceStatus => ({ started: true, online: true, focused: true, visible: true, capturePaused: false, wakeLock: "on", audio: "on" });
const state = (over: Partial<WallState> = {}): WallState => ({
  slots: emptySlots(["S1", "S2", "S3"]), last: null, recovery: null, view: { jobs: [], corrupt: [], waiting: 0, blocked: 0, uncertain: 0 },
  storageError: null, deliveryWaiting: null, authProblem: false, lastAcceptedAt: null, ...over,
});
function render(over: Partial<SharedScannerWallProps> = {}) {
  const props: SharedScannerWallProps = {
    siteLabel: "Australia", receiverLabel: "Dispatch desk", scannerIds: ["S1", "S2", "S3"], state: state(), device: device(),
    roleAllowed: true, signedIn: true, now: 1_000_000, onStart: noop, onRetry: noop, onDismiss: noop, onSignOutAll: noop, onExit: noop, ...over,
  };
  return renderToStaticMarkup(<SharedScannerWall {...props} />);
}

const prepared = {
  mode: "dispatch", orderNumber: "10190203", displayName: "#10190203", items: 3,
  framed: [
    { sku: "INKA-ABC0001-A2-FB", quantity: 1, workType: "framed", pieces: 1 },
    { sku: "INKA-ABC0002-A3-FW", quantity: 2, workType: "framed", pieces: 2 },
  ],
  components: [], packaging: null,
  evidence: [
    { sku: "INKA-ABC0001-A2-FB", status: "measured", personId: "p1", displayName: "Alice", verifiedEventId: "v", completedEventId: "c" },
    { sku: "INKA-ABC0002-A3-FW", status: "missing", personId: null, displayName: null, verifiedEventId: null, completedEventId: null },
  ],
  choices: [],
};
const waiting = (over: Partial<ScannerJob> = {}) => ({
  requestId: "r9", scope: "s|dispatch", mode: "dispatch", orderNumber: "10190203", displayName: "Dee", scannerId: "S1", status: "blocked",
  uncertain: false, priorUnknown: false, attempts: 0, createdAt: "2026-11-22T09:00:00.000Z", prepared,
  blocked: { code: "framer_missing", message: "#10190203: framing scan missing. Choose who framed it.", stage: "prepare" }, ...over,
}) as unknown as ScannerJob;
const people = { status: "ok" as const, people: [{ personId: "p1", displayName: "Alice" }, { personId: "p2", displayName: "Bob" }] };

describe("SharedScannerWall: F7 dispatch mode", () => {
  it("shows the mode, the shift sign-in instead of the 10-minute rule, and a switch", () => {
    const slots = emptySlots(["S1", "S2", "S3"]);
    slots.S1 = { ...slots.S1, identity: { personId: "d", displayName: "Dee", badge: "B", activatedAt: 1, lastFramingAt: 1, expiresAt: Date.UTC(2026, 10, 22, 17, 0) } };
    const html = render({ mode: "dispatch", state: state({ slots }), onSwitchMode: noop });
    expect(html).toContain(">Dispatch<");
    expect(html).toContain("Dispatching until");
    expect(html).not.toContain("without a scan");
    expect(html).toContain('data-testid="switch-mode"');
    expect(html).toContain("Switch worker");
    expect(render()).toContain(">Framing<");
  });

  it("a dispatch result says who framed each SKU, with Manual clearly labelled", () => {
    const html = render({ mode: "dispatch", state: state({ last: {
      kind: "saved", title: "Dispatched #10190203", scannerId: "S1", person: "Dee", order: "10190203", pieces: 3, at: 1,
      framers: [
        { sku: "INKA-ABC0001-A2-FB", source: "scan", personId: "p1", displayName: "Alice" },
        { sku: "INKA-ABC0002-A3-FW", source: "manual", personId: "p2", displayName: "Bob" },
      ],
    } }) });
    expect(html).toContain('data-testid="framed-by"');
    expect(html).toContain("Framed by: Alice</span> ✓");
    expect(html).toMatch(/Framed by: Bob<\/span> <span[^>]*>Manual<\/span>/);
  });

  it("a waiting job gets the compact chooser: measured lines shown, missing lines flagged, people listed", () => {
    const html = render({ mode: "dispatch", state: state({ view: { jobs: [waiting()], corrupt: [], waiting: 0, blocked: 1, uncertain: 0 } }),
      onChooseFramers: noop, people });
    expect(html).toContain('data-testid="framer-picker"');
    expect(html).toContain("Framed by: Alice ✓");
    expect(html).toContain("Framing scan missing");
    expect(html).toContain(">Bob</option>");
    expect(html).toContain("adds no framing scan, time or credit");
    expect(html).toContain('data-testid="blocked-jobs"'); // the job stays in the queue list too
  });

  it("never offers a new choice for a job that may already have been saved", () => {
    const html = render({ mode: "dispatch", state: state({ view: { jobs: [waiting({ uncertain: true })], corrupt: [], waiting: 0, blocked: 1, uncertain: 1 } }),
      onChooseFramers: noop, people });
    expect(html).not.toContain('data-testid="framer-picker"');
  });

  it("one waiting job at a time: the oldest", () => {
    const older = waiting({ requestId: "old", orderNumber: "10190201", createdAt: "2026-11-22T08:00:00.000Z" } as Partial<ScannerJob>);
    const html = render({ mode: "dispatch", state: state({ view: { jobs: [waiting(), older], corrupt: [], waiting: 0, blocked: 2, uncertain: 0 } }),
      onChooseFramers: noop, people });
    expect(html.match(/data-testid="framer-picker"/g)).toHaveLength(1);
    expect(html).toContain("#10190201: framing scan missing");
  });
});
