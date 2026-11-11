/**
 * Persisted production station config.
 *
 * Each physical tablet/computer running the /production page binds itself
 * to ONE department + an optional station label. Saved in localStorage so
 * the binding survives reloads. To change the binding, the operator clicks
 * the gear icon on the /production page.
 *
 * Why not URL params? The framing team would have to remember the URL
 * each shift. Why not server-stored stations? It's nice to keep this
 * client-only so a station can be reassigned without touching the DB.
 */

import type { ProductionDepartment } from "@/lib/domain";

const KEY = "inkaar.production.station";

export interface StationConfig {
  department: ProductionDepartment;
  /** Free-text station label, e.g. "Bench 3". Optional. */
  station_id: string | null;
}

export function loadStationConfig(): StationConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StationConfig;
    if (
      typeof parsed === "object"
      && parsed !== null
      && typeof parsed.department === "string"
      && ["a0_framed", "framed", "unframed", "dispatch"].includes(parsed.department)
    ) {
      return {
        department: parsed.department as ProductionDepartment,
        station_id: typeof parsed.station_id === "string" ? parsed.station_id : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveStationConfig(cfg: StationConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    // localStorage disabled (private mode etc.) — fail silently. The
    // page will keep prompting on each load, which is acceptable.
  }
}

export function clearStationConfig(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}
