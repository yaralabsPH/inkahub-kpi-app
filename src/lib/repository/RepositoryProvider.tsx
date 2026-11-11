import { createContext, useContext, useMemo, type ReactNode } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Repository } from "./Repository";
import { DexieRepo } from "./dexie/DexieRepo";
import { getDb } from "./dexie/db";
import { SupabaseRepo } from "./supabase/SupabaseRepo";
import { getBackendMode, getSupabase } from "./supabase/client";
import { useAppStore } from "@/lib/state/appStore";
import { DATASET_KEY } from "@/lib/hooks/useDataset";

const Ctx = createContext<Repository | null>(null);

/**
 * Inject a Repository keyed off the current location. Switching locations
 * swaps the underlying connection (Dexie DB or Supabase location filter)
 * and triggers a dataset refetch.
 *
 * Backend is selected via `VITE_BACKEND` env var:
 *   - "dexie" (default): local IndexedDB per location — original mode.
 *   - "supabase": cloud Postgres shared across team — requires login.
 *
 * Switching modes is reversible: change the env var, restart `npm run dev`.
 * Existing Dexie data is preserved during the entire migration period.
 */
export function RepositoryProvider({
  children,
  repo,
}: {
  children: ReactNode;
  repo?: Repository;
}) {
  const location = useAppStore((s) => s.location);
  const value = useMemo<Repository>(
    () => {
      if (repo) return repo;
      const backend = getBackendMode();
      if (backend === "supabase") {
        return new SupabaseRepo(getSupabase(), location);
      }
      return new DexieRepo(getDb(location));
    },
    [repo, location],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRepo(): Repository {
  const r = useContext(Ctx);
  if (!r) throw new Error("useRepo must be used inside <RepositoryProvider>");
  return r;
}

/** Helper used by the App shell to invalidate the cache when location changes. */
export function invalidateOnLocationChange(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: DATASET_KEY });
}
// silence the unused-import warning if TS is strict
void useQueryClient;
