/**
 * Atomic reporting publication (item-counting amendment, Task 13 Part B2b).
 * SERVER ONLY; service-role client from api/.
 *
 * publish_reporting_batch (0038) publishes one sealed, fully staged batch in
 * ONE transaction, or returns the generation it already produced when a lost
 * response is retried with the same batch and fence (replay = true; nothing
 * is written again). This module only validates arguments and the returned
 * row, and models the reconciliation fingerprint byte-for-byte.
 */
import { sha256Hex } from "../../src/lib/domain/productionReporting.js";
import { instantMicros } from "../../src/lib/domain/productionInstant.js";
import { ReportingJobError, type RpcClient } from "./reporting-jobs.js";
import { sortDescriptors, type WorkDescriptor } from "./reporting-stage.js";

const UUIDI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const SEQ = /^[1-9][0-9]{0,18}$/;
const SITES = ["au", "uk", "us"] as const;

export interface PublishedBatch {
  batchId: string;
  generationId: string;
  /** generations.generation_seq as a decimal string (never a lossy number). */
  generationSeq: string;
  site: (typeof SITES)[number];
  kind: "refresh" | "rebuild";
  sourceCutoff: string;
  workCount: number;
  /** batch_changes of this batch: its per-site receipts. */
  receipts: number;
  /** Changes globally acknowledged by this call's pass (0 on replay). */
  acknowledged: number;
  /** True when this call returned an earlier successful publication of the same batch/fence. */
  replay: boolean;
}

const count = (v: unknown, what: string): number => {
  const n = typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ReportingJobError(`${what} is not a non-negative integer`);
  return n;
};

export async function publishReportingBatch(client: RpcClient, batchId: string, fence: number): Promise<PublishedBatch> {
  if (typeof batchId !== "string" || !UUIDI.test(batchId)) throw new ReportingJobError("batchId must be a uuid");
  if (typeof fence !== "number" || !Number.isSafeInteger(fence) || fence < 1) throw new ReportingJobError("fence must be a positive safe integer");
  const { data, error } = await client.rpc("publish_reporting_batch", { p_batch: batchId, p_fence: fence });
  if (error) throw new ReportingJobError(`publish_reporting_batch failed: ${error.message}`, error.code ?? null);
  if (!Array.isArray(data) || data.length !== 1 || typeof data[0] !== "object" || data[0] === null) throw new ReportingJobError("publish_reporting_batch returned an unexpected shape");
  const r = data[0] as Record<string, unknown>;
  if (r.batch_id !== batchId) throw new ReportingJobError("publish_reporting_batch returned another batch");
  if (typeof r.generation_id !== "string" || !UUIDI.test(r.generation_id)) throw new ReportingJobError("generation_id must be a uuid");
  if (typeof r.generation_seq !== "string" || !SEQ.test(r.generation_seq)) throw new ReportingJobError("generation_seq must be a positive decimal string");
  if (!(SITES as readonly unknown[]).includes(r.site)) throw new ReportingJobError("site is not a supported site");
  if (r.kind !== "refresh" && r.kind !== "rebuild") throw new ReportingJobError("kind must be refresh or rebuild");
  if (typeof r.source_cutoff !== "string" || instantMicros(r.source_cutoff) === null) throw new ReportingJobError("source_cutoff must be an exact instant");
  if (typeof r.replay !== "boolean") throw new ReportingJobError("replay must be a boolean");
  return {
    batchId,
    generationId: r.generation_id,
    generationSeq: r.generation_seq,
    site: r.site as PublishedBatch["site"],
    kind: r.kind,
    sourceCutoff: r.source_cutoff,
    workCount: count(r.work_count, "work_count"),
    receipts: count(r.receipts, "receipts"),
    acknowledged: count(r.acknowledged, "acknowledged"),
    replay: r.replay,
  };
}

export interface FingerprintInput {
  site: string;
  kind: "refresh" | "rebuild";
  ruleVersion: string;
  captureEpoch: number;
  sourceCutoffUtc: string;
  sealedManifestHash: string;
  works: ReadonlyArray<WorkDescriptor & { resultDigest: string }>;
}

/**
 * reporting_private.publication_fingerprint(batch): SHA-256 hex of the UTF-8
 * lines "item-counting-publication-v1", site, kind, rule version, capture
 * epoch, source cutoff in integer microseconds since the Unix epoch, sealed
 * manifest hash, then each work's result digest in manifest order; "\n"
 * joined, no trailing newline.
 */
export function publicationFingerprint(f: FingerprintInput): string {
  const micros = instantMicros(f.sourceCutoffUtc);
  if (micros === null) throw new ReportingJobError("sourceCutoffUtc must be an exact instant");
  if (!HEX64.test(f.sealedManifestHash)) throw new ReportingJobError("sealedManifestHash must be SHA-256 hex");
  if (!Number.isSafeInteger(f.captureEpoch) || f.captureEpoch < 1) throw new ReportingJobError("captureEpoch must be a positive integer");
  const ordered = sortDescriptors(f.works) as Array<WorkDescriptor & { resultDigest: string }>;
  for (const w of ordered) if (!HEX64.test(w.resultDigest)) throw new ReportingJobError("resultDigest must be SHA-256 hex");
  const lines = ["item-counting-publication-v1", f.site, f.kind, f.ruleVersion, String(f.captureEpoch), micros.toString(), f.sealedManifestHash, ...ordered.map((w) => w.resultDigest)];
  return sha256Hex(lines.join("\n"));
}
