/**
 * The order of the item-counting staging gate, without I/O (injected), so it
 * can be tested:
 *
 *   1. run the SQL files (evidence, under the API role's real time limit);
 *   2. API timing starts ONLY when the SQL evidence has zero problems
 *      (including real-session claims and completed 0036 policy parity for
 *      the current policies) and a known v2/policy identity: a cancelled,
 *      errored or semantically wrong SQL result means no API measurement;
 *   3. measure as owner, then manager; an explicit --manager-phase must
 *      match the manager's real memberships;
 *   4. record the manager phase only when the SQL gate, the owner and the
 *      manager all passed, tagged with the v2 function/encoding/harness
 *      identity.
 */
import {
  checkManager,
  checkOwner,
  checkSqlRuns,
  inferManagerPhase,
  phaseMatchesMemberships,
  type GateMode,
  type ManagerPhase,
  type PhaseRecord,
} from "./itemCountingEvidence";
import type { MeasureResult } from "./measure-item-counting";
import type { GateState } from "./itemCountingReport";

export interface GateIO {
  /** Runs the SQL files, appending each FileRun to state.runs as it goes. */
  runSql(files: readonly string[]): Promise<void>;
  /** Times the loader as one test user; calls onUpdate with partial results. */
  measure(who: "owner" | "manager", onUpdate: (partial: MeasureResult) => void): Promise<MeasureResult>;
  save(): void;
  writePhases(records: PhaseRecord[]): void;
  now(): string;
  log(line: string): void;
}

export interface GateOptions {
  mode: GateMode;
  files: readonly string[];
  phaseArg?: ManagerPhase;
}

export async function runGate(state: GateState, io: GateIO, opts: GateOptions): Promise<void> {
  try {
    await io.runSql(opts.files);
  } catch (e) {
    state.fatal = e instanceof Error ? e.message : String(e);
    return;
  }

  const sql = checkSqlRuns(opts.mode, state.runs, { claimsSources: state.claimsSources, parity: state.parity });
  if (sql.problems.length || !sql.facts?.identity) {
    io.log(`\nSQL gate failed (${sql.problems[0] ?? "v2 function identity unknown"}); API measurements were not started.`);
    return;
  }
  const facts = sql.facts;

  for (const who of ["owner", "manager"] as const) {
    state.current = `measuring as ${who} · signing in`;
    state.lastProgress = null;
    io.save();
    try {
      state.measures[who] = await io.measure(who, (partial) => {
        state.measures[who] = partial;
        if (who === "manager") {
          if (opts.phaseArg && !phaseMatchesMemberships(opts.phaseArg, partial.sites)) {
            state.fatal = `--manager-phase=${opts.phaseArg} does not match the manager's memberships (${partial.sites.join(", ") || "none"})`;
            state.managerPhase = null;
          } else {
            state.managerPhase = opts.phaseArg ?? inferManagerPhase(partial.sites, state.phaseRecords, facts.identity);
          }
        }
        io.save();
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const partial = state.measures[who];
      if (partial && !("error" in partial) && partial.rows.length) state.fatal = `measurement as ${who} stopped: ${message}`;
      else state.measures[who] = { error: message };
    }
  }

  // Record the phase only when everything in this run passed.
  const phase = state.managerPhase;
  if (!phase || state.fatal || !facts.identity) return;
  const problems = [...checkOwner(state.measures.owner, facts), ...checkManager(state.measures.manager, phase, facts)];
  if (problems.length) {
    io.log(`\nManager phase ${phase} not recorded: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ""}`);
    return;
  }
  const record: PhaseRecord = {
    phase,
    finishedAt: io.now(),
    revision: state.revision,
    fnName: facts.identity.fnName,
    fnDefinitionMd5: facts.identity.fnDefinitionMd5,
    encodingVersion: facts.identity.encodingVersion,
    harnessVersion: facts.identity.harnessVersion,
    policyHash: facts.identity.policyHash,
    parityHash: facts.identity.parityHash,
    problems: [],
  };
  state.phaseRecords = [...state.phaseRecords, record];
  io.writePhases(state.phaseRecords);
  io.log(`\nManager phase ${phase} recorded.`);
}
