import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRepo } from "@/lib/repository/RepositoryProvider";
import { DATASET_KEY } from "./useDataset";
import { LEDGER_KEY } from "./useLedger";
import { CS_CASES_KEY } from "./useCsCases";
import { CS_RETURNS_KEY } from "./useCsReturns";
import type {
  DemandChangeEvent,
  GlobalSettings,
  IncomingShipment,
  PaperUsageEntry,
  Product,
  StorageLayout,
  WeeklyEntry,
  WeeklySales,
  Backup,
  CsCase,
  CsCaseLine,
  CsReturn,
  CsReturnLine,
} from "@/lib/domain";

/** Mutation hooks. Each invalidates the dataset query so the UI re-renders. */
export function useMutations() {
  const repo = useRepo();
  const qc = useQueryClient();
  /**
   * Invalidate both the dataset cache (so UI re-renders with fresh on-hand
   * and sales numbers) and the ledger cache (so any open audit panel
   * refetches and shows the new row). Both keys prefix-match across all
   * location-scoped query keys.
   */
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: DATASET_KEY });
    qc.invalidateQueries({ queryKey: LEDGER_KEY });
    qc.invalidateQueries({ queryKey: CS_CASES_KEY });
    qc.invalidateQueries({ queryKey: CS_RETURNS_KEY });
  };

  const upsertProduct = useMutation({
    mutationFn: (p: Product) => repo.upsertProduct(p),
    onSuccess: invalidate,
  });
  const deleteProduct = useMutation({
    mutationFn: (id: string) => repo.deleteProduct(id),
    onSuccess: invalidate,
  });
  /** Atomic on-hand adjustment — see Repository.adjustOnHand. */
  const adjustOnHand = useMutation({
    mutationFn: (args: {
      productId: string;
      delta: number;
      context?: Parameters<typeof repo.adjustOnHand>[2];
    }) => repo.adjustOnHand(args.productId, args.delta, args.context),
    onSuccess: invalidate,
  });
  const upsertSale = useMutation({
    mutationFn: (s: WeeklySales) => repo.upsertSale(s),
    onSuccess: invalidate,
  });
  const bulkUpsertSales = useMutation({
    mutationFn: (rows: WeeklySales[]) => repo.bulkUpsertSales(rows),
    onSuccess: invalidate,
  });
  const deleteSale = useMutation({
    mutationFn: (args: { productId: string; isoWeekStart: string }) =>
      repo.deleteSale(args.productId, args.isoWeekStart),
    onSuccess: invalidate,
  });
  const upsertWeeklyEntry = useMutation({
    mutationFn: (e: WeeklyEntry) => repo.upsertWeeklyEntry(e),
    onSuccess: invalidate,
  });
  const deleteWeeklyEntry = useMutation({
    mutationFn: (args: { isoWeekStart: string; department: "framed" | "unframed" }) =>
      repo.deleteWeeklyEntry(args.isoWeekStart, args.department),
    onSuccess: invalidate,
  });
  const renameWeeklyEntry = useMutation({
    mutationFn: (args: { oldIso: string; newIso: string; department: "framed" | "unframed" }) =>
      repo.renameWeeklyEntry(args.oldIso, args.newIso, args.department),
    onSuccess: invalidate,
  });
  const bulkDeleteWeeklyEntries = useMutation({
    mutationFn: (weeks: Array<{ iso_week_start: string; department: "framed" | "unframed" }>) =>
      repo.bulkDeleteWeeklyEntries(weeks),
    onSuccess: invalidate,
  });
  const upsertShipment = useMutation({
    mutationFn: (s: IncomingShipment) => repo.upsertShipment(s),
    onSuccess: invalidate,
  });
  const deleteShipment = useMutation({
    mutationFn: (id: string) => repo.deleteShipment(id),
    onSuccess: invalidate,
  });
  const upsertEvent = useMutation({
    mutationFn: (e: DemandChangeEvent) => repo.upsertDemandEvent(e),
    onSuccess: invalidate,
  });
  const deleteEvent = useMutation({
    mutationFn: (id: string) => repo.deleteDemandEvent(id),
    onSuccess: invalidate,
  });
  const setStorage = useMutation({
    mutationFn: (s: StorageLayout) => repo.setStorage(s),
    onSuccess: invalidate,
  });
  const setSettings = useMutation({
    mutationFn: (s: GlobalSettings) => repo.setSettings(s),
    onSuccess: invalidate,
  });
  const importBackup = useMutation({
    mutationFn: (b: Backup) => repo.importBackup(b),
    onSuccess: invalidate,
  });
  const wipe = useMutation({
    mutationFn: () => repo.wipe(),
    onSuccess: invalidate,
  });
  const upsertPaperUsage = useMutation({
    mutationFn: (e: PaperUsageEntry) => repo.upsertPaperUsage(e),
    onSuccess: invalidate,
  });
  const deletePaperUsage = useMutation({
    mutationFn: (isoWeekStart: string) => repo.deletePaperUsage(isoWeekStart),
    onSuccess: invalidate,
  });
  const upsertCsCase = useMutation({
    mutationFn: (args: { case: CsCase; lines: CsCaseLine[] }) =>
      repo.upsertCsCase(args.case, args.lines),
    onSuccess: invalidate,
  });
  const deleteCsCase = useMutation({
    mutationFn: (id: string) => repo.deleteCsCase(id),
    onSuccess: invalidate,
  });
  const upsertCsReturn = useMutation({
    mutationFn: (args: { return: CsReturn; lines: CsReturnLine[] }) =>
      repo.upsertCsReturn(args.return, args.lines),
    onSuccess: invalidate,
  });
  const deleteCsReturn = useMutation({
    mutationFn: (id: string) => repo.deleteCsReturn(id),
    onSuccess: invalidate,
  });

  return {
    upsertProduct,
    deleteProduct,
    adjustOnHand,
    upsertSale,
    bulkUpsertSales,
    deleteSale,
    upsertWeeklyEntry,
    deleteWeeklyEntry,
    renameWeeklyEntry,
    bulkDeleteWeeklyEntries,
    upsertShipment,
    deleteShipment,
    upsertEvent,
    deleteEvent,
    setStorage,
    setSettings,
    importBackup,
    wipe,
    upsertPaperUsage,
    deletePaperUsage,
    upsertCsCase,
    deleteCsCase,
    upsertCsReturn,
    deleteCsReturn,
  };
}
