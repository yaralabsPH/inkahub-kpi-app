import { useMemo } from "react";
import { forecast, type ForecastOptions, type ForecastResult } from "@/lib/forecasting";
import type { Product } from "@/lib/domain";
import { blanketForScenario, useAppStore } from "@/lib/state/appStore";
import { useDataset } from "./useDataset";

/**
 * One ForecastResult per SKU, keyed by product id. Recomputes only when the
 * dataset, scenario, or saved scenarios change.
 */
export function useForecasts(): {
  loading: boolean;
  byId: Record<string, ForecastResult>;
  list: ForecastResult[];
} {
  const { data, isLoading } = useDataset();
  const scenario = useAppStore((s) => s.scenario);
  const saved = useAppStore((s) => s.savedScenarios);

  return useMemo(() => {
    if (!data) return { loading: isLoading, byId: {}, list: [] };
    const blanket = blanketForScenario(scenario, saved);
    const baseOptions: Omit<ForecastOptions, "blanketDemandMultiplier"> = {
      useRestocks: true,
      useDemandChanges: true,
      scenarioStart: data.settings.manual_scenario_start_date ?? undefined,
    };
    const list: ForecastResult[] = data.products.map((p: Product) =>
      forecast({
        product: p,
        sales: data.sales,
        shipments: data.shipments,
        events: data.events,
        entries: data.entries,
        options: { ...baseOptions, blanketDemandMultiplier: blanket },
      }),
    );
    const byId: Record<string, ForecastResult> = {};
    for (const r of list) byId[r.productId] = r;
    return { loading: false, byId, list };
  }, [data, isLoading, scenario, saved]);
}
