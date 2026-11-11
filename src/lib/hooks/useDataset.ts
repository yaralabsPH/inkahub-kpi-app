import { useQuery } from "@tanstack/react-query";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { useAppStore } from "@/lib/state/appStore";
import type {
  DemandChangeEvent,
  GlobalSettings,
  IncomingShipment,
  PaperUsageEntry,
  Product,
  StorageLayout,
  WeeklyEntry,
  WeeklySales,
} from "@/lib/domain";

/** The whole dataset that the UI ever reads. */
export interface Dataset {
  products: Product[];
  sales: WeeklySales[];
  entries: WeeklyEntry[];
  shipments: IncomingShipment[];
  events: DemandChangeEvent[];
  storage: StorageLayout;
  settings: GlobalSettings;
  paperUsage: PaperUsageEntry[];
}

/**
 * Cache-key prefix used by every dataset query. The actual queryKey for
 * `useDataset()` is `[...DATASET_KEY, location]` so each location gets its
 * own cache slot — switching between locations no longer flashes the
 * previous location's data while the refetch is in flight. Mutation
 * invalidations still use `DATASET_KEY` alone because TanStack Query does
 * prefix matching by default.
 */
export const DATASET_KEY = ["dataset"] as const;

export function useDataset() {
  const repo = useRepo();
  const location = useAppStore((s) => s.location);
  return useQuery<Dataset>({
    queryKey: [...DATASET_KEY, location],
    queryFn: async () => {
      const [products, sales, entries, shipments, events, storage, settings, paperUsage] =
        await Promise.all([
          repo.listProducts(),
          repo.listSales(),
          repo.listWeeklyEntries(),
          repo.listShipments(),
          repo.listDemandEvents(),
          repo.getStorage(),
          repo.getSettings(),
          repo.listPaperUsage(),
        ]);
      return { products, sales, entries, shipments, events, storage, settings, paperUsage };
    },
  });
}
