/**
 * Task 13 activation-fence staging checks (pure parts). The runner
 * (`reporting-jobs.ts`) drives several real connections on STAGING after
 * migration 0038 is applied; this module holds the scenario list, the
 * expected outcomes and the report. Never logs claims or credentials.
 */
import type { LifecycleReport } from "./reportingCapture";

export const FENCE_SCENARIOS = [
  { id: "F1", what: "two compatible source writers at au (capture enabled) do not wait on each other" },
  { id: "F2", what: "enabling capture waits for an uncommitted disabled-period write; a READ COMMITTED writer queued behind the toggle then sees capture enabled" },
  { id: "F3", what: "a REPEATABLE READ writer whose snapshot predates the enable fails with a serialization error instead of writing untracked" },
  { id: "F4", what: "disable then re-enable advances the epoch by one each; a later write carries the new epoch" },
  { id: "F5", what: "a toggle blocked by an open writer times out after at most 3 s (or a stricter existing limit) and leaves control unchanged" },
  { id: "F6", what: "the capture role can lock the control row but cannot update it (WITH CHECK false; no capture_enabled privilege)" },
] as const;
export type FenceId = (typeof FENCE_SCENARIOS)[number]["id"];

/** Observed facts per scenario; every value is measured by the runner, never assumed. */
export interface FenceObservation {
  id: FenceId;
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
  stricterError?: string | null;
  stricterMs?: number;
  controlUnchanged?: boolean;
  /** F6: results as the capture role. */
  lockRows?: number | null;
  updateUpdatedAtError?: string | null;
  updateEnabledError?: string | null;
  error?: string | null;
}

export function checkFence(obs: readonly FenceObservation[]): string[] {
  const p: string[] = [];
  const by = new Map(obs.map((o) => [o.id, o]));
  for (const s of FENCE_SCENARIOS) {
    const o = by.get(s.id);
    if (!o) {
      p.push(`${s.id} did not run`);
      continue;
    }
    if (o.error) {
      p.push(`${s.id} failed: ${o.error}`);
      continue;
    }
    const want = (ok: boolean, msg: string) => void (ok || p.push(`${s.id}: ${msg}`));
    switch (s.id) {
      case "F1":
        want(!o.secondWriterError && typeof o.secondWriterMs === "number" && o.secondWriterMs < 3000, `second writer ${o.secondWriterError ?? `took ${o.secondWriterMs} ms`}`);
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
        want(o.timeoutError === "error 55P03" && typeof o.timeoutMs === "number" && o.timeoutMs >= 2500 && o.timeoutMs < 6000, `default limit gave ${o.timeoutError} after ${o.timeoutMs} ms (expected 55P03 near 3 s)`);
        want(o.stricterError === "error 55P03" && typeof o.stricterMs === "number" && o.stricterMs < 2500, `stricter 1 s limit gave ${o.stricterError} after ${o.stricterMs} ms`);
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
}

export function newFenceReport(revision: string, startedAt: string): FenceReport {
  return { revision, startedAt, finishedAt: "", settings: null, captureBefore: null, captureAfter: null, observations: [], problems: [], errors: [], restorationVerified: null, restoration: null, restorationProblems: [] };
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
    "- source writes are always rolled back; capture toggles are committed (they advance the epoch) and capture is returned to its starting on/off state",
    r.captureBefore ? `- capture before: ${r.captureBefore.enabled ? "enabled" : "disabled"} at epoch ${r.captureBefore.epoch}` : "",
    r.captureAfter ? `- capture after: ${r.captureAfter.enabled ? "enabled" : "disabled"} at epoch ${r.captureAfter.epoch}` : "",
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
