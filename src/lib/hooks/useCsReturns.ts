import { useQuery } from "@tanstack/react-query";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { useAppStore } from "@/lib/state/appStore";
import type { CsReturnWithLines } from "@/lib/domain";

/**
 * Cache prefix for CS Returns queries. Kept separate from DATASET_KEY so
 * the Returns page only refetches when a return mutation invalidates, not
 * on every sales / shipment change.
 */
export const CS_RETURNS_KEY = ["cs-returns"] as const;

/**
 * Read all returns for the active location, with lines pre-joined. Volume
 * is expected to be modest (similar to or lower than CS Cases), so no
 * pagination. Query key includes location so switching locations gets
 * its own cache slot.
 */
export function useCsReturns() {
  const repo = useRepo();
  const location = useAppStore((s) => s.location);
  return useQuery<CsReturnWithLines[]>({
    queryKey: [...CS_RETURNS_KEY, location],
    queryFn: () => repo.listCsReturns(),
    staleTime: 15_000,
  });
}
