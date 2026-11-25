import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedScannerWall, type SharedScannerWallProps } from "../SharedScannerWall";
import { ordinal } from "../ScannerWallPanel";
import { emptySlots, type ScannerSlot } from "@/lib/scanners/session";
import type { WallState } from "@/lib/scanners/station";
import type { WallTotalsView, ScannerWallTotals } from "@/lib/scanners/wallTotals";
import type { DeviceStatus } from "../useSharedScannerStation";

// scanner-wall-redesign Task 4: the four approved screens and their edge states.

const noop = () => {};
const NOW = 1_000_000;
const device: DeviceStatus = { started: true, online: true, focused: true, visible: true, capturePaused: false, wakeLock: "on", audio: "on" };
const state = (over: Partial<WallState> = {}): WallState => ({
  slots: emptySlots(["S1", "S2", "S3"]), last: null, recovery: null, slotNotes: {}, progress: {}, slotSaved: {}, goodbye: {}, saveRevision: 0,
  view: { jobs: [], corrupt: [], waiting: 0, blocked: 0, uncertain: 0 },
  storageError: null, deliveryWaiting: null, authProblem: false, lastAcceptedAt: null, ...over,
});
const person = (personId: string, displayName: string, over: Partial<NonNullable<ScannerSlot["identity"]>> = {}) =>
  ({ personId, displayName, badge: `B-${personId}`, activatedAt: NOW, lastFramingAt: NOW, ...over });
function threeOn(): Record<string, ScannerSlot> {
  const s = emptySlots(["S1", "S2", "S3"]);
  s.S1 = { ...s.S1, identity: person("ben", "Ben") };
  s.S2 = { ...s.S2, identity: person("mia", "Mia") };
  s.S3 = { ...s.S3, identity: person("leo", "Leo") };
  return s;
}
const totals = (byPerson: ScannerWallTotals["byPerson"], over: Partial<ScannerWallTotals> = {}): ScannerWallTotals => ({
  byPerson, team: { orders: 39, pieces: 92 }, hasRework: false, incomplete: false, ...over,
});
const view = (t: ScannerWallTotals | null, over: Partial<WallTotalsView> = {}): WallTotalsView => ({
  status: "current", totals: t, pendingPersonIds: [], loadedAtUtc: new Date(NOW).toISOString(), message: null, ...over,
});
const COMPETITION: ScannerWallTotals["byPerson"] = {
  ben: { orders: 14, pieces: 31, rank: 2, share: 14 / 39, leading: false, jointLead: false },
  mia: { orders: 17, pieces: 42, rank: 1, share: 17 / 39, leading: true, jointLead: false },
  leo: { orders: 8, pieces: 19, rank: 3, share: 8 / 39, leading: false, jointLead: false },
};
function render(over: Partial<SharedScannerWallProps> = {}) {
  const props: SharedScannerWallProps = {
    siteLabel: "Australia", receiverLabel: "Framing wall", scannerIds: ["S1", "S2", "S3"], state: state(), device,
    roleAllowed: true, signedIn: true, now: NOW, elapsedNow: 50_000, timeZone: "Australia/Sydney",
    onStart: noop, onRetry: noop, onDismiss: noop, onSignOutAll: noop, onExit: noop, ...over,
  };
  return renderToStaticMarkup(<SharedScannerWall {...props} />);
}

describe("scanner wall redesign", () => {
  it("Main: three people, today's numbers, leader, ranks, share bars, team totals and a green saved banner", () => {
    const html = render({
      state: state({ slots: threeOn(), slotSaved: { S2: { personId: "mia", orderNumber: "10251730", pieces: 3, mode: "framing", at: NOW } },
        last: { kind: "saved", title: "Saved #10251730", scannerId: "S2", person: "Mia", order: "10251730", pieces: 3, at: NOW } }),
      totals: view(totals(COMPETITION)),
    });
    expect(html).toContain('class="scanner-wall dark"');
    expect(html).toContain('data-testid="orders-S2">17<');
    expect(html).toContain('data-testid="pieces-S2">42<');
    expect(html).toContain("Leading today");
    expect(html).toContain("2nd today");
    expect(html).toContain("3rd today");
    expect(html).toContain("Share of active people&#x27;s order credits");
    expect(html).toContain("Orders <b>39</b>");
    expect(html).toContain("Last saved here:</span> #10251730 · 3 pieces");
    expect(html).toContain("No recent saved order on this scanner"); // Ben and Leo
    expect(html).toContain('data-kind="saved"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Signs out in 15:00 without a scan");
  });

  it("joint lead when tied; nobody leads at zero; ordinal ranks", () => {
    const tie = render({ state: state({ slots: threeOn() }), totals: view(totals({
      ben: { orders: 5, pieces: 5, rank: 1, share: 0.5, leading: true, jointLead: true },
      mia: { orders: 5, pieces: 6, rank: 1, share: 0.5, leading: true, jointLead: true },
      leo: { orders: 0, pieces: 0, rank: 3, share: 0, leading: false, jointLead: false },
    })) });
    expect(tie.match(/Joint lead/g)).toHaveLength(2);
    const zero = render({ state: state({ slots: threeOn() }), totals: view(totals({
      ben: { orders: 0, pieces: 0, rank: 1, share: 0, leading: false, jointLead: false },
      mia: { orders: 0, pieces: 0, rank: 1, share: 0, leading: false, jointLead: false },
      leo: { orders: 0, pieces: 0, rank: 1, share: 0, leading: false, jointLead: false },
    })) });
    expect(zero).not.toContain("Leading today");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"]);
  });

  it("Saving: the scanning panel shows its real stage; only saved is green", () => {
    const html = render({
      state: state({ slots: threeOn(), progress: {
        r1: { scannerId: "S1", personId: "ben", orderNumber: "10251294", mode: "framing", phase: "saving", startedAt: 1 },
        r2: { scannerId: "S1", personId: "ben", orderNumber: "10251295", mode: "framing", phase: "received", startedAt: 2 },
      }, last: { kind: "queued", title: "Queued #10251294 for Ben", scannerId: "S1", at: NOW } }),
      totals: view(totals(COMPETITION)),
    });
    expect(html).toContain('data-testid="panel-progress" data-phase="saving"');
    expect(html).toContain("Order #10251294"); // the oldest unfinished scan
    expect(html).toContain("Saving to Ben…");
    expect(html).toContain("1 more waiting");
    expect(html).toContain("Working on it");
    expect(html).not.toContain('data-kind="saved"');
  });

  it("progress for a previous person is not shown under the new one", () => {
    const html = render({
      state: state({ slots: threeOn(), progress: { r1: { scannerId: "S1", personId: "alice", orderNumber: "10251294", mode: "framing", phase: "checking", startedAt: 1 } },
        slotSaved: { S1: { personId: "alice", orderNumber: "10251111", pieces: 1, mode: "framing", at: NOW } } }),
    });
    expect(html).not.toContain("10251294");
    expect(html).not.toContain("10251111");
  });

  it("Problem: the recovery message is an alert and people stay signed in", () => {
    const html = render({ state: state({ slots: threeOn(),
      recovery: { title: "That scan didn't come through.", detail: "Nothing was saved from that scan. Whoever just scanned: scan it again. If it was your badge, scan your badge again before your order.", setupHint: null, seq: 1 } }) });
    expect(html).toMatch(/<section class="w-recovery" role="alert" data-testid="scan-recovery">/);
    expect(html).toContain("NOTHING SAVED FROM THAT SCAN");
    expect(html).toContain("If it was your badge, scan your badge again before your order.");
    expect(html).not.toContain("NOBODY SIGNED OUT"); // the actual state, not a fixed claim
    for (const n of ["Ben", "Mia", "Leo"]) expect(html).toContain(n);
    expect(html).not.toMatch(/hook.{0,20}ignored/i); // no accessory-ignored copy
  });

  it("SignOut: 2 of 3 with dots and a countdown from the elapsed clock; goodbye with last known numbers; a free scanner", () => {
    const slots = threeOn();
    slots.S1 = { ...slots.S1, signOut: { badge: "B-ben", personId: "ben", displayName: "Ben", firstRepeatAt: 46_000, count: 2 } };
    slots.S2 = { ...emptySlots(["S2"]).S2 };
    slots.S3 = { ...emptySlots(["S3"]).S3 };
    const html = render({
      elapsedNow: 50_000, // 4 s into the 10 s window
      state: state({ slots, goodbye: { S2: { personId: "mia", displayName: "Mia", at: NOW - 2_000 } } }),
      totals: view(totals({ ben: COMPETITION.ben }), { lastKnown: { mia: { orders: 29, pieces: 71 } } }),
    });
    expect(html).toContain("S1 · Ben · Sign out 2/3");
    expect(html).toContain("6 seconds left, or it starts over");
    expect(html.match(/class="is-on"/g)).toHaveLength(2);
    expect(html).toContain("Bye, Mia");
    expect(html).toContain("29 orders · 71 pieces today");
    expect(html).toContain("Still clocked in.");
    expect(html).toContain("Scan your badge to start");
    // A wildly different clock origin gives the same countdown.
    const shifted = { ...slots, S1: { ...slots.S1, signOut: { ...slots.S1.signOut!, firstRepeatAt: 9_000_046_000 } } };
    expect(render({ elapsedNow: 9_000_050_000, now: 5, state: state({ slots: shifted }) })).toContain("6 seconds left");
  });

  it("the goodbye ends after five seconds", () => {
    const html = render({ state: state({ goodbye: { S1: { personId: "mia", displayName: "Mia", at: NOW - 6_000 } } }) });
    expect(html).not.toContain("Bye, Mia");
  });

  it("loading, pending, unavailable, stale and incomplete totals never show invented numbers", () => {
    const loading = render({ state: state({ slots: threeOn() }), totals: view(null, { status: "loading" }) });
    expect(loading).toContain('data-testid="orders-S1">—<');
    expect(loading).toContain("Updating today&#x27;s totals");
    const pending = render({ state: state({ slots: threeOn() }), totals: view(totals(COMPETITION), { pendingPersonIds: ["ben", "mia", "leo"] }) });
    expect(pending).toContain('data-testid="orders-S2">—<');
    expect(pending).not.toContain("Leading today");
    expect(pending).not.toContain("Orders <b>");
    const unavailable = render({ state: state({ slots: threeOn() }), totals: view(null, { status: "unavailable", message: "timeout" }) });
    expect(unavailable).toContain("Today&#x27;s totals unavailable: timeout");
    const stale = render({ state: state({ slots: threeOn() }), totals: view(totals(COMPETITION), { status: "stale" }) });
    expect(stale).toContain("Last updated");
    expect(stale).toContain('data-testid="orders-S2">17<');
    const incomplete = render({ state: state({ slots: threeOn() }), totals: view(totals(COMPETITION, { incomplete: true })) });
    expect(incomplete).toContain("Some records need checking; no ranking shown");
    expect(incomplete).not.toContain("Leading today");
    expect(incomplete).not.toContain("Share of active people");
  });

  it("long names wrap, a person on two scanners shows on both, suppression and pending badge render", () => {
    const slots = threeOn();
    slots.S1 = { ...slots.S1, identity: person("ben", "Bartholomew-Alexander Montgomery-Smythe the Third") };
    slots.S2 = { ...slots.S2, identity: person("ben", "Bartholomew-Alexander Montgomery-Smythe the Third") };
    slots.S3 = { ...emptySlots(["S3"]).S3, pending: { requestId: "r", badge: "X", startedAt: 0, orderFallback: null } };
    const html = render({ state: state({ slots, slotNotes: { S1: "Remove the badge, wait one second, then scan again" } }),
      totals: view(totals({ ben: COMPETITION.ben })) });
    expect(html.match(/Bartholomew-Alexander/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Remove the badge, wait one second, then scan again");
    expect(html).toContain("Checking badge…");
  });

  it("one or two configured scanners lay out as one or two columns", () => {
    expect(render({ scannerIds: ["S1"] })).toContain('class="w-panels n1"');
    expect(render({ scannerIds: ["S1", "S2"] })).toContain('class="w-panels n2"');
  });

  it("dispatch: no competition, idle bar or badge x3 prompt", () => {
    const slots = threeOn();
    slots.S1 = { ...slots.S1, identity: person("dee", "Dee", { expiresAt: Date.UTC(2026, 10, 22, 17, 0) }) };
    const html = render({ mode: "dispatch", state: state({ slots }), totals: view(totals(COMPETITION)) });
    expect(html).not.toContain("Leading today");
    expect(html).not.toContain('data-testid="orders-');
    expect(html).not.toContain("Sign out 1/3");
    expect(html).toContain("Dispatching until");
    expect(html).not.toContain('data-testid="wall-team"');
  });

  it("operator controls stay real buttons", () => {
    const html = render({ onSwitchMode: noop });
    for (const label of ["Sign out all", "Dispatch mode", "Classic station"]) expect(html).toMatch(new RegExp(`<button[^>]*>${label}</button>`));
  });
});
