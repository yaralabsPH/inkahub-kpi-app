/**
 * Task 17: the published management view for one page (Reports or Welcome).
 *
 * The identity is the AUTHENTICATED user, the site, the view, the production
 * dates and the selected staff/work type; the bearer token is read from the
 * signed-in Supabase client at call time (never cached here). The server
 * re-authorizes every request and derives the audience itself.
 */
import { useMemo } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkType } from "@/lib/domain/productionCounts";
import { isReportSite, type ProductionRange } from "@/lib/domain/productionPeriods";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { usePublishedProduction, type ControllerDeps, type PublishedIdentity } from "./usePublishedProduction";

export interface PublishedManagementOptions {
  supabase: SupabaseClient;
  view: "reports" | "welcome";
  site: string;
  range: Pick<ProductionRange, "firstDate" | "lastDate"> | null;
  staffId?: string | null;
  workType?: WorkType | null;
  refreshKey: number;
}

export function usePublishedManagement(o: PublishedManagementOptions) {
  const auth = useAuthOptional();
  const userId = auth?.user?.id ?? null;
  const { supabase } = o;
  const deps = useMemo<ControllerDeps>(
    () => ({
      fetch: (url, init) => window.fetch(url, init),
      token: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    }),
    [supabase],
  );
  const firstDate = o.range?.firstDate ?? null;
  const lastDate = o.range?.lastDate ?? null;
  const identity = useMemo<PublishedIdentity | null>(
    () =>
      userId && isReportSite(o.site) && firstDate && lastDate
        ? { userId, site: o.site, view: o.view, firstDate, lastDate, ...(o.staffId ? { staffId: o.staffId } : {}), ...(o.workType ? { workType: o.workType } : {}) }
        : null,
    [userId, o.site, o.view, firstDate, lastDate, o.staffId, o.workType],
  );
  return usePublishedProduction(identity, deps, o.refreshKey);
}
