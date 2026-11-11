import { useQuery } from "@tanstack/react-query";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { useAppStore } from "@/lib/state/appStore";
import type { CsCaseWithLines } from "@/lib/domain";

/**
 * Cache prefix for CS Cases queries. Kept separate from DATASET_KEY so
 * the CS Cases page only refetches when a case mutation invalidates,
 * not on every sales / shipment change.
 */
export const CS_CASES_KEY = ["cs-cases"] as const;

/**
 * Read all CS cases for the active location, with their lines pre-joined.
 * Volume is small (~50/month), so we don't paginate. The query key
 * includes location so switching locations gets its own cache slot
 * (mirrors the dataset pattern).
 */
export function useCsCases() {
  const repo = useRepo();
  const location = useAppStore((s) => s.location);
  return useQuery<CsCaseWithLines[]>({
    queryKey: [...CS_CASES_KEY, location],
    queryFn: () => repo.listCsCases(),
    staleTime: 15_000,
  });
}
