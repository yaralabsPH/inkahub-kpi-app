/**
 * The `--policy-parity=cases` run lifecycle (review r2 R2-1), without files or
 * a database of its own so it can be tested:
 *
 *   1. Before anything that can fail (settings, sign-in, connection), the new
 *      attempt is written to the parity artifact as PENDING, replacing any
 *      earlier collection. A crash, kill or startup failure therefore leaves a
 *      failing artifact: an older success can never certify the next gate.
 *   2. While collecting, the report is rewritten after every progress line and
 *      on a heartbeat, always ending in FAILED (in progress).
 *   3. At the end, every final validation failure (claims, coverage, checker)
 *      is stored in the collection's own problems before it is published, so
 *      the stored artifact and the report can never disagree.
 *
 * History (`snapshots`, `comparisons`) is kept untouched.
 */
import type { ClaimsSource, ParityArtifact } from "./itemCountingPolicyParity";
import { baselineCatalog, retainedInstalledHash } from "./itemCountingPolicyParity";
import { CASE_CUTOFF, CASE_METHOD, caseParityMarkdown, caseParityProblems, type CaseCollection } from "./itemCountingParityCases";
import { collectCaseParity, type QueryClient } from "./policyParityRun";

export interface CasesModeIO {
  readArtifact(): ParityArtifact | null;
  /** Atomic write (temp file, then rename). */
  writeArtifact(art: ParityArtifact): void;
  writeReport(markdown: string): void;
  signIn(): Promise<{ text: Record<string, string>; sources: Record<string, ClaimsSource> }>;
  connect(): Promise<QueryClient & { end(): Promise<void> }>;
  collect?: typeof collectCaseParity;
  revision: string;
  project: string;
  now(): string;
  newId(): string;
  log(line: string): void;
  signal: AbortSignal;
  /** Heartbeat interval for the progress report (0 = off). */
  heartbeatMs?: number;
  redact?(s: string): string;
}

const PENDING = (id: string, at: string) => `four-case collection ${id} started at ${at} has not finished`;

/** A pending (always failing) collection that marks a new attempt. */
export function pendingCollection(id: string, at: string, revision: string): CaseCollection {
  return {
    collectionId: id, capturedAt: at, revision, method: CASE_METHOD, cutoff: CASE_CUTOFF, bounds: [], fixture: {}, fixtureHash: "",
    baselinePolicyHash: "", installedPolicyHash: "", startMemberships: {}, staffOtherWorkerRows: {}, cases: [], comparisons: [],
    restoration: null, problems: [PENDING(id, at)],
  };
}

export async function runCasesMode(io: CasesModeIO): Promise<{ code: number; status: string; collection: CaseCollection }> {
  const redact = io.redact ?? ((s: string) => s);
  const art: ParityArtifact = io.readArtifact() ?? { snapshots: [], comparisons: [] };
  const id = io.newId();
  const startedAt = io.now();
  let coll: CaseCollection = pendingCollection(id, startedAt, io.revision);
  // 1. Mark the attempt before anything fallible.
  art.cases = coll;
  io.writeArtifact(art);
  const lines: string[] = [];
  let sources: Record<string, ClaimsSource> = {};
  const progress = (note: string) =>
    io.writeReport(caseParityMarkdown({ coll: null, problems: [], lines, claimsSources: sources, revision: io.revision, project: io.project, finishedAt: io.now(), inProgress: note }).markdown);
  progress(PENDING(id, startedAt));
  const log = (l: string) => {
    lines.push(l);
    io.log(l);
    progress(PENDING(id, startedAt));
  };
  const heartbeat = io.heartbeatMs ? setInterval(() => progress(`${PENDING(id, startedAt)} (still running)`), io.heartbeatMs) : null;
  let client: (QueryClient & { end(): Promise<void> }) | null = null;
  try {
    const sessions = await io.signIn();
    sources = sessions.sources;
    client = await io.connect();
    coll = await (io.collect ?? collectCaseParity)(client, {
      revision: io.revision, claimsText: sessions.text, claimsSources: sessions.sources, baseline: baselineCatalog(art),
      expectedInstalledHash: retainedInstalledHash(art), log, signal: io.signal, newId: () => id, now: io.now,
    });
  } catch (e) {
    coll.problems.push(redact(e instanceof Error ? e.message : String(e)));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (client) await client.end().catch(() => {});
  }
  // 3. Store every final validation failure in the collection itself, then publish.
  const problems = caseParityProblems(baselineCatalog(art), coll).map(redact);
  for (const p of problems) if (!coll.problems.includes(p) && !p.startsWith(`parity case `)) coll.problems.push(p);
  if (!coll.finishedAt && !coll.problems.some((p) => p.startsWith("four-case collection"))) coll.problems.push(PENDING(id, startedAt));
  art.cases = coll;
  io.writeArtifact(art);
  const final = caseParityProblems(baselineCatalog(art), coll).map(redact);
  const { markdown, status } = caseParityMarkdown({ coll, problems: final, lines, claimsSources: sources, revision: io.revision, project: io.project, finishedAt: io.now() });
  io.writeReport(markdown);
  return { code: final.length ? 1 : 0, status, collection: coll };
}
