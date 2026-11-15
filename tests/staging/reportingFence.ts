/**
 * Task 13 activation-fence staging checks (pure parts). The runner
 * (`reporting-jobs.ts`) drives several real connections on STAGING after
 * migration 0038 is applied; this module holds the scenario list, the
 * expected outcomes and the report. Never logs claims or credentials.
 */
import type { LifecycleReport } from "./reportingCapture";
import type { CaptureTransition } from "./reportingCommitted";

export const FENCE_SCENARIOS = [
  { id: "F1", what: "two compatible source writers at au (capture enabled) do not wait on each other" },
  { id: "F2", what: "enabling capture waits for an uncommitted disabled-period write; a READ COMMITTED writer queued behind the toggle then sees capture enabled" },
  { id: "F3", what: "a REPEATABLE READ writer whose snapshot predates the enable fails with a serialization error instead of writing untracked" },
  { id: "F4", what: "disable then re-enable advances the epoch by one each; a later write carries the new epoch" },
  { id: "F5", what: "a toggle blocked by an open writer times out after at most 3 s (or a stricter existing limit, kept as is) and leaves control unchanged" },
  { id: "F6", what: "the capture role can lock the control row but cannot update it (WITH CHECK false; no capture_enabled privilege)" },
] as const;
export type FenceId = (typeof FENCE_SCENARIOS)[number]["id"];

/** Observed facts per scenario; every value is measured by the runner, never assumed. */
export interface FenceObservation {
  id: FenceId;
  /** Effective session lock_timeout on the scenario connection, ms (0 = no limit). */
  existingLockMs?: number;
  /** F1: the scenario-local limit actually used (min of 3 s and the existing limit). */
  writerLimitMs?: number;
  /** F1: second writer finished; ms. */
  secondWriterMs?: number | null;
  secondWriterError?: string | null;
  /** F2: toggle was seen waiting on a lock while the disabled-period write was open. */
  toggleWaited?: boolean;
  /** F2: the queued READ COMMITTED writer was seen waiting while the toggle was uncommitted. */
  queuedWriterWaited?: boolean;
  /** F2/F4: journal rows (and their epoch) written by the observed writer. */
  journalRows?: number;
  journalEpoch?: number | null;
  epochBefore?: number;
  epochAfter?: number;
  /** F3: the old-snapshot writer's error code. */
  oldSnapshotError?: string | null;
  /** F4: epochs after disable and after re-enable. */
  epochAfterDisable?: number;
  epochAfterEnable?: number;
  /** F5: default and stricter-limit toggle attempts. */
  timeoutError?: string | null;
  timeoutMs?: number;
  /** F5: the limit set_reporting_capture applies (min of 3 s and the existing limit). */
  defaultLimitMs?: number;
  stricterError?: string | null;
  stricterMs?: number;
  /** F5: the stricter scenario-local limit used (min of 1 s and the existing limit). */
  stricterLimitMs?: number;
  controlUnchanged?: boolean;
  /** F6: results as the capture role. */
  lockRows?: number | null;
  updateUpdatedAtError?: string | null;
  updateEnabledError?: string | null;
  error?: string | null;
}

/** A scenario-local limit never loosens an existing one (0 = no existing limit). */
export function capLimit(wantMs: number, existingMs: number | undefined): number {
  if (existingMs === undefined || !Number.isFinite(existingMs) || existingMs < 0) return Number.NaN;
  return existingMs > 0 && existingMs < wantMs ? existingMs : wantMs;
}

/** A lock timeout fired close to its limit: not early, and not long after. */
export function near(ms: number | undefined, limitMs: number | undefined): boolean {
  if (typeof ms !== "number" || typeof limitMs !== "number" || !Number.isFinite(limitMs)) return false;
  return ms >= limitMs * 0.8 && ms < limitMs * 1.5 + 500;
}

/** Observe a launched query at once (no unhandled rejection), and inspect or rethrow it later. */
export interface Launched<T> {
  /** Resolves with the value or rejects with the original error, when awaited. */
  result(): Promise<T>;
  /** True once the promise has settled (either way). */
  settled(): boolean;
}
export function launch<T>(p: PromiseLike<T>): Launched<T> {
  let done = false;
  const outcome: Promise<{ ok: true; v: T } | { ok: false; e: unknown }> = Promise.resolve(p).then(
    (v) => ((done = true), { ok: true as const, v }),
    (e) => ((done = true), { ok: false as const, e }),
  );
  return {
    settled: () => done,
    result: async () => {
      const o = await outcome;
      if (o.ok) return o.v;
      throw o.e;
    },
  };
}

export function checkFence(obs: readonly FenceObservation[]): string[] {
  const p: string[] = [];
  const by = new Map(obs.map((o) => [o.id, o]));
  for (const s of FENCE_SCENARIOS) {
    const o = by.get(s.id);
    if (!o) p.push(`${s.id} did not run`);
    else p.push(...checkFenceObservation(o));
  }
  return p;
}

/**
 * T13B2b-17: one observation against its scenario's expectations, checked as
 * soon as it is made (the runner stops at the first problem). A refusal that
 * the scenario EXPECTS (e.g. F3's 40001, F5's 55P03) is a pass, not a problem.
 */
export function checkFenceObservation(o: FenceObservation): string[] {
  const p: string[] = [];
  const s = FENCE_SCENARIOS.find((x) => x.id === o.id);
  if (!s) return [`unknown fence scenario ${String(o.id)}`];
  if (o.error) return [`${s.id} failed: ${o.error}`];
  {
    const want = (ok: boolean, msg: string) => void (ok || p.push(`${s.id}: ${msg}`));
    switch (s.id) {
      case "F1":
        want(typeof o.writerLimitMs === "number" && o.writerLimitMs > 0 && o.writerLimitMs <= 3000 && o.writerLimitMs === capLimit(3000, o.existingLockMs), `writer limit ${o.writerLimitMs} ms does not respect the existing ${o.existingLockMs} ms`);
        want(!o.secondWriterError && typeof o.secondWriterMs === "number" && o.secondWriterMs < (o.writerLimitMs ?? 0), `second writer ${o.secondWriterError ?? `took ${o.secondWriterMs} ms`} (limit ${o.writerLimitMs} ms)`);
        break;
      case "F2":
        want(o.toggleWaited === true, "the enable did not wait for the open disabled-period write");
        want(o.queuedWriterWaited === true, "the READ COMMITTED writer did not queue behind the uncommitted toggle");
        want(o.journalRows === 1, `queued writer journal rows ${o.journalRows}, expected 1`);
        want(o.epochBefore !== undefined && o.epochAfter === o.epochBefore + 1 && o.journalEpoch === o.epochAfter, `epochs before/after/journal ${o.epochBefore}/${o.epochAfter}/${o.journalEpoch}`);
        break;
      case "F3":
        want(o.oldSnapshotError === "error 40001", `old-snapshot writer gave ${o.oldSnapshotError ?? "no error"}, expected error 40001`);
        break;
      case "F4":
        want(o.epochBefore !== undefined && o.epochAfterDisable === o.epochBefore + 1 && o.epochAfterEnable === o.epochBefore + 2, `epochs ${o.epochBefore}→${o.epochAfterDisable}→${o.epochAfterEnable}`);
        want(o.journalRows === 1 && o.journalEpoch === o.epochAfterEnable, `journal rows ${o.journalRows} at epoch ${o.journalEpoch}`);
        break;
      case "F5":
        want(o.defaultLimitMs === capLimit(3000, o.existingLockMs), `function limit ${o.defaultLimitMs} ms, expected ${capLimit(3000, o.existingLockMs)} ms for an existing ${o.existingLockMs} ms`);
        want(o.timeoutError === "error 55P03" && near(o.timeoutMs, o.defaultLimitMs), `toggle gave ${o.timeoutError} after ${o.timeoutMs} ms (expected 55P03 near ${o.defaultLimitMs} ms)`);
        want(o.stricterLimitMs === capLimit(1000, o.existingLockMs), `stricter limit ${o.stricterLimitMs} ms, expected ${capLimit(1000, o.existingLockMs)} ms`);
        want(o.stricterError === "error 55P03" && near(o.stricterMs, o.stricterLimitMs), `stricter toggle gave ${o.stricterError} after ${o.stricterMs} ms (expected 55P03 near ${o.stricterLimitMs} ms)`);
        want(o.controlUnchanged === true, "control changed after a timed-out toggle");
        break;
      case "F6":
        want(o.lockRows === 1, `capture role FOR SHARE returned ${o.lockRows} rows`);
        want(o.updateUpdatedAtError === "error 42501", `UPDATE(updated_at) as capture role gave ${o.updateUpdatedAtError ?? "no error"}`);
        want(o.updateEnabledError === "error 42501", `UPDATE(capture_enabled) as capture role gave ${o.updateEnabledError ?? "no error"}`);
        break;
    }
  }
  return p;
}

export interface FenceReport extends LifecycleReport {
  revision: string;
  startedAt: string;
  settings: string | null;
  captureBefore: { epoch: number; enabled: boolean } | null;
  captureAfter: { epoch: number; enabled: boolean } | null;
  observations: FenceObservation[];
  problems: string[];
  /**
   * T13B2b-18: this run's OWN capture transitions. Each receipt is persisted
   * before its COMMIT; only CONFIRMED ones count toward the audit's expected
   * epoch increment (an uncertain one adds nothing and fails the run).
   */
  captureTransitions: CaptureTransition[];
}

export function newFenceReport(revision: string, startedAt: string): FenceReport {
  return { revision, startedAt, finishedAt: "", settings: null, captureBefore: null, captureAfter: null, observations: [], problems: [], captureTransitions: [], errors: [], restorationVerified: null, restoration: null, restorationProblems: [] };
}

export function fenceStatus(r: FenceReport): string {
  const all = [...r.errors, ...r.problems, ...r.restorationProblems];
  if (!r.finishedAt) all.unshift("run not finished");
  if (r.restorationVerified !== true && !all.some((x) => x.startsWith("restoration not verified"))) all.push("restoration not verified");
  return all.length ? `STATUS: FAILED – ${all[0]}${all.length > 1 ? ` (+${all.length - 1} more)` : ""}` : "STATUS: COMPLETE";
}

export function fenceMarkdown(r: FenceReport): string {
  const lines = [
    "# Reporting activation fence checks (Task 13)",
    "",
    `- project: ybrzhrgfrnvtcwymjdrq (staging) · code revision: ${r.revision}`,
    `- started: ${r.startedAt} · finished: ${r.finishedAt || "(not finished)"}`,
    r.settings ? `- session settings (unchanged by the runner): ${r.settings}` : "",
    "- source writes are always rolled back; capture toggles are committed (they advance the epoch), each with a receipt saved before COMMIT; capture is always returned to its starting on/off state; the run stops at the first failed scenario",
    r.captureBefore ? `- capture before: ${r.captureBefore.enabled ? "enabled" : "disabled"} at epoch ${r.captureBefore.epoch}` : "",
    r.captureAfter ? `- capture after: ${r.captureAfter.enabled ? "enabled" : "disabled"} at epoch ${r.captureAfter.epoch}` : "",
    r.captureTransitions.length ? `- own capture transitions: ${r.captureTransitions.map((t) => `${t.enable ? "on" : "off"} ${t.before}->${t.after} (${t.state})`).join(", ")}` : "",
    "",
    "## Scenarios",
    "",
    "| id | scenario | observed |",
    "|---|---|---|",
    ...FENCE_SCENARIOS.map((s) => {
      const o = r.observations.find((x) => x.id === s.id);
      const { id: _id, ...rest } = o ?? ({} as FenceObservation);
      return `| ${s.id} | ${s.what} | ${o ? JSON.stringify(rest).replace(/\|/g, "\\|") : "not run"} |`;
    }),
    ...r.problems.map((x) => `- PROBLEM: ${x}`),
    "",
    "## Restoration",
    "",
    r.restorationVerified === true ? `- ${r.restoration}` : r.restorationVerified === false ? "- NOT verified: something may have been kept or could not be checked" : "- not yet verified",
    ...r.restorationProblems.map((x) => `- PROBLEM: ${x}`),
    ...r.errors.map((x) => `- ERROR: ${x}`),
    "",
    fenceStatus(r),
    "",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
