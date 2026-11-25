/**
 * scanner-wall-redesign: the wall's one read of today's production evidence.
 *
 * Delegates to the existing F1 loader and strict decoder (same RPC, same
 * caller client and RLS). The only addition is a row ceiling: a day with
 * more evidence rows than the wall should ever need is refused as
 * incomplete instead of being decoded on a tablet.
 */
import type { ProductionSnapshot } from "@/lib/domain/productionCounts";
import {
  loadProductionEvidence,
  ProductionReadError,
  type EvidenceRpcClient,
  type ProductionReadRequest,
} from "@/lib/repository/supabase/productionEvidence";

/** Largest evidence envelope the wall accepts for one site day. */
export const WALL_MAX_ROWS = 20_000;
/** Each read gives up after this long. */
export const WALL_READ_DEADLINE_MS = 10_000;

interface RpcCall extends PromiseLike<{ data: unknown; error: unknown }> {
  abortSignal?(signal: AbortSignal): RpcCall;
}

function checkCeiling(data: unknown): void {
  if (!data || typeof data !== "object") return; // the strict decoder reports the shape
  const env = data as { rows?: unknown; rowCount?: unknown };
  const sent = Array.isArray(env.rows) ? env.rows.length : 0;
  const counted = typeof env.rowCount === "number" ? env.rowCount : 0;
  if (sent > WALL_MAX_ROWS || counted > WALL_MAX_ROWS) {
    throw new ProductionReadError("incomplete", `Today's production has more than ${WALL_MAX_ROWS.toLocaleString("en")} records; the wall cannot show totals.`);
  }
}

function bounded(call: RpcCall): RpcCall {
  return {
    then(onFulfilled, onRejected) {
      return Promise.resolve(call)
        .then((res) => {
          if (!res.error) checkCeiling(res.data);
          return res;
        })
        .then(onFulfilled, onRejected);
    },
    abortSignal(signal: AbortSignal) {
      return bounded(typeof call.abortSignal === "function" ? call.abortSignal(signal) : call);
    },
  };
}

/** A view of the caller's client whose evidence calls enforce the wall's ceiling. */
export function wallRpcClient(client: EvidenceRpcClient): EvidenceRpcClient {
  return { rpc: (fn, args) => bounded(client.rpc(fn, args) as RpcCall) };
}

export function loadScannerWallEvidence(client: EvidenceRpcClient, request: ProductionReadRequest): Promise<ProductionSnapshot> {
  return loadProductionEvidence(wallRpcClient(client), request);
}
