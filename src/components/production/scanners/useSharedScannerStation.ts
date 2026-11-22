import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateBadge, commitFraming, fetchOrderLookup, hasOpenCase, newRequestId, processNext, sendHeartbeat } from "@/lib/scanners/client";
import { createFrameParser, DEFAULT_PROTOCOL } from "@/lib/scanners/protocol";
import { createScannerOutbox, dexieJobStore, type JobScope } from "@/lib/scanners/outbox";
import { SharedScannerController, type SoundKind, type WallState } from "@/lib/scanners/station";
import { HEARTBEAT_EVERY_MS } from "@/lib/scanners/config";
import type { CatalogueProduct, PackagingSetup } from "@/lib/scanners/order";
import { loadPackagingConfig } from "@/lib/repository/supabase/orderPackaging";

/**
 * F6: browser wiring for the shared scanner wall. All decisions live in
 * SharedScannerController; this only feeds it keys and timers and exposes
 * device capabilities. Mount it with a `key` of caller|site|receiver|ids so
 * any change there starts from empty identities.
 */

export interface DeviceStatus {
  started: boolean;
  online: boolean;
  focused: boolean;
  visible: boolean;
  capturePaused: boolean;
  wakeLock: "unsupported" | "off" | "on" | "failed";
  audio: "off" | "on" | "unsupported";
}

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  return EDITABLE.has(el.tagName) || (el as HTMLElement).isContentEditable === true;
}

interface WakeLockSentinelLike { release(): Promise<void>; addEventListener?(t: string, f: () => void): void }

export function useSharedScannerStation(opts: {
  client: SupabaseClient;
  location: string;
  callerId: string;
  receiverId: string;
  label: string;
  scannerIds: string[];
  products: readonly CatalogueProduct[] | null;
}) {
  const { client, location, callerId, receiverId, label, scannerIds } = opts;
  const productsRef = useRef(opts.products);
  productsRef.current = opts.products;

  const scope: JobScope = useMemo(() => ({ backend: "supabase", callerId, location, receiverId }), [callerId, location, receiverId]);
  const owner = useMemo(() => newRequestId(), []);
  const audioRef = useRef<AudioContext | null>(null);
  const [device, setDevice] = useState<DeviceStatus>(() => ({
    started: false,
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    focused: typeof document === "undefined" ? true : document.hasFocus(),
    visible: typeof document === "undefined" ? true : document.visibilityState === "visible",
    capturePaused: false,
    wakeLock: typeof navigator !== "undefined" && "wakeLock" in navigator ? "off" : "unsupported",
    audio: typeof window !== "undefined" && "AudioContext" in window ? "off" : "unsupported",
  }));

  const sound = useCallback((kind: SoundKind) => {
    const ctx = audioRef.current;
    if (!ctx) return;
    try {
      const tones: Record<SoundKind, Array<[number, number]>> = {
        ok: [[880, 0.08], [1320, 0.1]],
        queued: [[660, 0.12]],
        error: [[220, 0.18], [160, 0.25]],
      };
      let t = ctx.currentTime;
      for (const [freq, dur] of tones[kind]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = kind === "error" ? "square" : "sine";
        osc.frequency.value = freq;
        gain.gain.value = 0.2;
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
        t += dur + 0.02;
      }
    } catch {
      // Sound is a nicety; the screen always shows the result.
    }
  }, []);

  const controller = useMemo(() => {
    const outbox = createScannerOutbox(dexieJobStore());
    const packaging = async (): Promise<PackagingSetup | "network"> => {
      const cfg = await loadPackagingConfig(client, location);
      if (cfg.warning) return "network"; // auto requested but rules unreadable: wait, never guess
      return { mode: cfg.mode, ruleSet: cfg.ruleSet };
    };
    return new SharedScannerController({
      scannerIds,
      scope,
      outbox,
      activate: (a) => activateBadge(client, { location, receiverId, ...a }),
      deliver: () =>
        processNext({
          outbox,
          scope,
          owner,
          lookupOrder: async (n) => {
            const { data } = await client.auth.getSession();
            return fetchOrderLookup(fetch, data.session?.access_token ?? null, n);
          },
          openCase: (n) => hasOpenCase(client, location, n),
          products: () => productsRef.current,
          packaging,
          commit: (job, prepared) => commitFraming(client, job, prepared),
        }),
      isOnline: () => navigator.onLine,
      now: () => Date.now(),
      newRequestId,
      sound,
    });
    // scannerIds is compared by value through the mount key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, location, receiverId, scope, owner, sound]);

  const [state, setState] = useState<WallState>(controller.state);
  useEffect(() => {
    setState(controller.state);
    const off = controller.subscribe(setState);
    void controller.refreshView().then(() => controller.pump());
    return () => {
      off();
      controller.dispose();
    };
  }, [controller]);

  // ---- key capture ---------------------------------------------------------
  const idsKey = scannerIds.join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parser = useMemo(() => createFrameParser({ ...DEFAULT_PROTOCOL, scannerIds: idsKey.split(",") }), [idsKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target as Element | null) || isEditable(document.activeElement)) {
        parser.reset();
        setDevice((d) => (d.capturePaused ? d : { ...d, capturePaused: true }));
        return;
      }
      setDevice((d) => (d.capturePaused ? { ...d, capturePaused: false } : d));
      // Keep scanner keystrokes away from focused buttons (Enter would click them).
      if (e.key.length === 1 || e.key === "Enter") e.preventDefault();
      for (const ev of parser.key(e.key, performance.now())) {
        if (ev.kind === "frame") controller.onFrame(ev.scannerId, ev.payload);
        else controller.onProtocolError(ev.reason, ev.scannerId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    const t = window.setInterval(() => {
      for (const ev of parser.tick(performance.now())) {
        if (ev.kind === "error") controller.onProtocolError(ev.reason, ev.scannerId);
      }
    }, 50);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearInterval(t);
    };
  }, [parser, controller]);

  // ---- timers: expiry, delivery retry, heartbeat ---------------------------
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const expiry = window.setInterval(() => controller.tick(), 5_000);
    const retry = window.setInterval(() => controller.pump(), 5_000);
    const beat = async () => {
      const s = stateRef.current;
      await sendHeartbeat(client, {
        location,
        receiverId,
        label,
        lastScanAt: s.lastAcceptedAt ? new Date(s.lastAcceptedAt).toISOString() : null,
        queueCount: s.view?.waiting ?? 0,
        blockedCount: (s.view?.blocked ?? 0) + (s.view?.corrupt.length ?? 0),
      });
    };
    void beat();
    const hb = window.setInterval(() => void beat(), HEARTBEAT_EVERY_MS);
    return () => {
      window.clearInterval(expiry);
      window.clearInterval(retry);
      window.clearInterval(hb);
    };
  }, [controller, client, location, receiverId, label]);

  // ---- device status: online, focus, visibility, wake lock -----------------
  const wakeRef = useRef<WakeLockSentinelLike | null>(null);
  const wantWake = useRef(false);
  const acquireWake = useCallback(async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    try {
      const s = await wl.request("screen");
      wakeRef.current = s;
      s.addEventListener?.("release", () => setDevice((d) => ({ ...d, wakeLock: "off" })));
      setDevice((d) => ({ ...d, wakeLock: "on" }));
    } catch {
      setDevice((d) => ({ ...d, wakeLock: "failed" }));
    }
  }, []);

  useEffect(() => {
    const update = () =>
      setDevice((d) => ({ ...d, online: navigator.onLine, focused: document.hasFocus(), visible: document.visibilityState === "visible" }));
    const onOnline = () => {
      update();
      controller.pump();
    };
    const onVisible = () => {
      update();
      if (document.visibilityState === "visible" && wantWake.current) void acquireWake();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", onVisible);
    const poll = window.setInterval(update, 1_000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(poll);
      void wakeRef.current?.release().catch(() => undefined);
    };
  }, [controller, acquireWake]);

  /** The one operator gesture: enables sound and keeps the screen awake. */
  const start = useCallback(() => {
    if (typeof window !== "undefined" && "AudioContext" in window && !audioRef.current) {
      try {
        audioRef.current = new AudioContext();
        void audioRef.current.resume();
        setDevice((d) => ({ ...d, audio: "on" }));
      } catch {
        setDevice((d) => ({ ...d, audio: "unsupported" }));
      }
    }
    wantWake.current = true;
    void acquireWake();
    setDevice((d) => ({ ...d, started: true }));
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [acquireWake]);

  return {
    state,
    device,
    start,
    retry: (id: string) => void controller.retry(id),
    dismiss: (id: string) => void controller.dismiss(id),
    signOutAll: () => controller.resetAll("Signed out by the operator."),
  };
}
