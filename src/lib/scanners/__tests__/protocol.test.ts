import { describe, expect, it } from "vitest";
import { createFrameParser, DEFAULT_PROTOCOL, validateScannerIds, type ProtocolEvent } from "../protocol";

/** Type a string as keys starting at t0, `step` ms apart; "\n" = Enter. Returns events and the end time. */
function type(parser: ReturnType<typeof createFrameParser>, text: string, t0: number, step = 5): { events: ProtocolEvent[]; t: number } {
  const events: ProtocolEvent[] = [];
  let t = t0;
  for (const ch of text) {
    events.push(...parser.key(ch === "\n" ? "Enter" : ch, t));
    t += step;
  }
  return { events, t };
}

/** Feed an explicit list of [key, time] pairs (for interleavings). */
function feed(parser: ReturnType<typeof createFrameParser>, keys: Array<[string, number]>): ProtocolEvent[] {
  return keys.flatMap(([k, t]) => parser.key(k, t));
}

function frameKeys(text: string, t0: number, step: number): Array<[string, number]> {
  return [...text].map((ch, i) => [ch === "\n" ? "Enter" : ch, t0 + i * step]);
}

describe("scanner frame parser", () => {
  it("accepts one whole frame and reports its scanner", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S2>A1B2C3D4</S2>\n", 1000);
    expect(events).toEqual([{ kind: "frame", scannerId: "S2", payload: "A1B2C3D4", at: expect.any(Number) }]);
  });

  it("accepts back-to-back frames from different scanners", () => {
    const p = createFrameParser();
    const a = type(p, "<S1>190203</S1>\n", 0);
    const b = type(p, "<S3>#10190204</S3>\n", a.t + 50);
    expect([...a.events, ...b.events].map((e) => e.kind === "frame" && [e.scannerId, e.payload])).toEqual([
      ["S1", "190203"],
      ["S3", "#10190204"],
    ]);
  });

  it("ignores modifier keys the scanner sends for < > / and #", () => {
    const p = createFrameParser();
    const keys: Array<[string, number]> = [];
    let t = 0;
    for (const ch of "<S1>#10190203</S1>\n") {
      if (ch === "<" || ch === ">" || ch === "#") keys.push(["Shift", (t += 2)]);
      keys.push([ch === "\n" ? "Enter" : ch, (t += 3)]);
    }
    expect(feed(p, keys)).toEqual([{ kind: "frame", scannerId: "S1", payload: "#10190203", at: t }]);
  });

  it("rejects stray text without a prefix and gives no scanner (clears everyone)", () => {
    const p = createFrameParser();
    const { events } = type(p, "190203\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "stray_text", scannerId: null });
    expect(events.filter((e) => e.kind === "frame")).toHaveLength(0);
  });

  it("does not recover a frame hidden inside stray text (no substring recovery)", () => {
    const p = createFrameParser();
    // Stray burst, then a frame typed in the same burst with no quiet gap.
    const { events } = type(p, "xx<S1>190203</S1>\n", 0, 5);
    expect(events.filter((e) => e.kind === "frame")).toHaveLength(0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "stray_text" });
  });

  it("requires a quiet gap after an error before accepting a new frame", () => {
    const p = createFrameParser();
    const bad = type(p, "x", 0);
    expect(bad.events[0]).toMatchObject({ kind: "error" });
    // Starts 100 ms later: still inside the quiet window, ignored entirely.
    const tooSoon = type(p, "<S1>190203</S1>\n", 100, 5);
    expect(tooSoon.events).toEqual([]);
    expect(p.resyncing).toBe(true);
    // After a full quiet gap the next frame is accepted.
    const later = type(p, "<S1>190203</S1>\n", tooSoon.t + DEFAULT_PROTOCOL.quietMs + 1, 5);
    expect(later.events).toEqual([{ kind: "frame", scannerId: "S1", payload: "190203", at: expect.any(Number) }]);
  });

  it("rejects nested frames", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S1>12<S2>34</S2>56</S1>\n", 0);
    expect(events).toEqual([{ kind: "error", reason: "bad_structure", scannerId: null, at: expect.any(Number) }]);
  });

  it("rejects mismatched markers without trusting either scanner", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S1>190203</S2>\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "mismatched_markers", scannerId: null });
  });

  it("rejects an unknown scanner id", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S4>190203</S4>\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "unknown_scanner", scannerId: null });
  });

  it("reports a bad payload against the known scanner only", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S1>19 02</S1>\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "bad_payload", scannerId: "S1" });
  });

  it("rejects an over-long frame as soon as it passes the bound", () => {
    const p = createFrameParser({ ...DEFAULT_PROTOCOL, maxFrameLength: 20 });
    const { events } = type(p, "<S1>123456789012345678901234</S1>\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "too_long", scannerId: null });
  });

  it("rejects a frame whose keys arrive too slowly (a person typing)", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S1>190203</S1>\n", 0, DEFAULT_PROTOCOL.maxGapMs + 30);
    expect(events[0]).toMatchObject({ kind: "error", reason: "too_slow" });
  });

  it("reports a frame that stops half way on the next tick", () => {
    const p = createFrameParser();
    const { t } = type(p, "<S1>1902", 0);
    expect(p.receiving).toBe(true);
    expect(p.tick(t + 10)).toEqual([]);
    expect(p.tick(t + DEFAULT_PROTOCOL.maxGapMs + 10)).toEqual([
      { kind: "error", reason: "frame_timeout", scannerId: null, at: t + DEFAULT_PROTOCOL.maxGapMs + 10 },
    ]);
  });

  it("requires Enter after the closing marker", () => {
    const p = createFrameParser();
    const { events } = type(p, "<S1>190203</S1>9\n", 0);
    expect(events[0]).toMatchObject({ kind: "error", reason: "bad_structure" });
  });

  it("rejects a non-character key inside a frame", () => {
    const p = createFrameParser();
    const keys = frameKeys("<S1>19", 0, 5);
    keys.push(["Backspace", 40]);
    expect(feed(p, keys)[0]).toMatchObject({ kind: "error", reason: "unexpected_key" });
  });

  describe("two scanners at once", () => {
    // Representative interleavings of S1 "<S1>190203</S1>" and S2 "<S2>A1B2C3D4</S2>".
    const s1 = "<S1>190203</S1>\n";
    const s2 = "<S2>A1B2C3D4</S2>\n";

    it("character-by-character interleaving yields no frame", () => {
      const p = createFrameParser();
      const keys: Array<[string, number]> = [];
      let t = 0;
      for (let i = 0; i < Math.max(s1.length, s2.length); i++) {
        if (i < s1.length) keys.push([s1[i] === "\n" ? "Enter" : s1[i], (t += 2)]);
        if (i < s2.length) keys.push([s2[i] === "\n" ? "Enter" : s2[i], (t += 2)]);
      }
      const events = feed(p, keys);
      expect(events.filter((e) => e.kind === "frame")).toHaveLength(0);
      expect(events[0]).toMatchObject({ kind: "error", scannerId: null });
    });

    it("a second frame starting inside the first yields no frame", () => {
      const p = createFrameParser();
      const keys = [...frameKeys(s1.slice(0, 8), 0, 3), ...frameKeys(s2, 30, 3), ...frameKeys(s1.slice(8), 120, 3)];
      const events = feed(p, keys.sort((a, b) => a[1] - b[1]));
      expect(events.filter((e) => e.kind === "frame")).toHaveLength(0);
      expect(events.some((e) => e.kind === "error" && e.scannerId === null)).toBe(true);
    });

    it("payload-only interleaving with matching markers still fails", () => {
      const p = createFrameParser();
      // "<S1>19" from S1, then "A1" from S2's payload, then the rest of S1.
      const events = feed(p, frameKeys("<S1>19A10203</S1>\n", 0, 4));
      // Structurally whole and from S1, so the parser cannot detect it. The
      // payload is mixed hex: never an order shape, so it can only match an
      // active badge exactly or be rejected (session.classifyPayload).
      expect(events).toEqual([{ kind: "frame", scannerId: "S1", payload: "19A10203", at: expect.any(Number) }]);
    });

    it("frames that merely follow each other closely are both accepted", () => {
      const p = createFrameParser();
      const a = feed(p, frameKeys(s1, 0, 3));
      const b = feed(p, frameKeys(s2, 60, 3));
      expect([...a, ...b].filter((e) => e.kind === "frame")).toHaveLength(2);
    });
  });

  it("reset drops a partial frame silently", () => {
    const p = createFrameParser();
    type(p, "<S1>19", 0);
    p.reset();
    expect(p.receiving).toBe(false);
    expect(type(p, "<S1>190203</S1>\n", 1000).events[0]).toMatchObject({ kind: "frame" });
  });

  it("validates configured scanner ids", () => {
    expect(validateScannerIds(["S1", "S2", "S3"])).toBeNull();
    expect(validateScannerIds(["S1", "S1"])).toMatch(/twice/);
    expect(validateScannerIds(["s1"])).toMatch(/capital/);
    expect(validateScannerIds(["S1<"])).toMatch(/capital/);
    expect(validateScannerIds(["S1", "S2", "S3", "S4"])).toMatch(/one to three/);
    expect(() => createFrameParser({ ...DEFAULT_PROTOCOL, scannerIds: ["bad id"] })).toThrow();
  });
});
