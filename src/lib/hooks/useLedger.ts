import { useQuery } from "@tanstack/react-query";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { useAppStore } from "@/lib/state/appStore";
import type { LedgerEntry } from "@/lib/domain";
import { DATASET_KEY } from "./useDataset";

/**
 * Ledger reads are split out from the main dataset because the ledger can
 * grow unbounded (one row per inventory movement, forever) and pulling it
 * into every page would bloat memory. Each call site asks for exactly what
 * it needs:
 *
 *   useLedger()                  — recent activity across all SKUs (audit feed)
 *   useLedger(productId)         — full history for one SKU (SKU Detail panel)
 *   useLedger(productId, 25)     — last 25 rows for that SKU
 *
 * Cache key includes location so each location gets its own slot, matching
 * the dataset query's behaviour. Mutations that touch inventory invalidate
 * `DATASET_KEY` which prefix-matches both `["dataset", ...]` and
 * `["ledger", ...]` only via the explicit overlap below (see useMutations).
 */
const LEDGER_KEY = ["ledger"] as const;

export function useLedger(productId?: string, limit?: number) {
  const repo = useRepo();
  const location = useAppStore((s) => s.location);
  return useQuery<LedgerEntry[]>({
    queryKey: [...LEDGER_KEY, location, productId ?? "*", limit ?? "all"],
    queryFn: () => repo.listLedger(productId, limit),
    staleTime: 10_000, // ledger churns more than the dataset; refetch sooner
  });
}

/** Exported so mutation hooks can invalidate both dataset and ledger prefix-keys. */
export { LEDGER_KEY };
// Silence unused-import warning when DATASET_KEY isn't referenced here.
void DATASET_KEY;
