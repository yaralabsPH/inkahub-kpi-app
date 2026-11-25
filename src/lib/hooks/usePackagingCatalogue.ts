import { useEffect, useState } from "react";
import { catalogueProducts } from "@/lib/domain/packaging/usage";
import { getSupabase } from "@/lib/repository/supabase/client";
import { listRuleSets } from "@/lib/repository/supabase/orderPackaging";
import { useAppStore } from "@/lib/state/appStore";

const EMPTY: Map<string, string> = new Map();

/**
 * F4 box-auto-pick: product id -> label for every packaging item in the
 * site's rule sets (any version, so history keeps its names). Empty when the
 * site has no rule sets or the packaging tables are not there yet, in which
 * case reports fall back to the hard-coded box list as before.
 */
export function usePackagingCatalogue(): Map<string, string> {
  const location = useAppStore((s) => s.location);
  const [catalogue, setCatalogue] = useState<Map<string, string>>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    setCatalogue(EMPTY);
    void listRuleSets(getSupabase(), location).then((res) => {
      if (cancelled || res.outcome !== "ok") return;
      setCatalogue(catalogueProducts(res.value.map((r) => r.body)));
    });
    return () => {
      cancelled = true;
    };
  }, [location]);

  return catalogue;
}
