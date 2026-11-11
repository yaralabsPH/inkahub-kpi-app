import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LocationKey } from "@/lib/domain";

export type Scenario = "Base" | "+15%" | "-15%" | "Optimistic" | "Pessimistic" | string;
export type Theme = "light" | "dark" | "system";

/**
 * Department selector — splits the app into two parallel views:
 *   "framed"   : products supplied as CHINA (or anything that isn't UNFRAMED)
 *   "unframed" : products supplied as UNFRAMED (the A0–A4 print SKUs)
 *
 * Scoped data: weekly entries, forecasts, SKU columns, dashboards, order
 * builder. Cross-department concepts (warehouse storage, CS Cases, ledger
 * audit) ignore this — they show everything.
 */
export type Department = "framed" | "unframed";

interface AppState {
  scenario: Scenario;
  theme: Theme;
  location: LocationKey;
  /** Active department — persisted so it survives page reloads. */
  department: Department;
  savedScenarios: { name: string; blanketDemandMultiplier: number }[];
  /** When true the left nav collapses to an icons-only rail. Persisted. */
  sidebarCollapsed: boolean;
  /**
   * IDs of alerts the user has marked as read. Read alerts still appear in
   * the dropdown (visually muted) but do not contribute to the bell badge.
   * If an alert's underlying condition clears and later re-fires (same id),
   * it stays read — the user has explicitly acknowledged it. Reset by
   * clearing the persisted state.
   */
  readAlertIds: string[];
  /**
   * The first time each logical alert id surfaced (ISO datetime). Stays
   * pinned across daily re-detections so "first alerted on" is meaningful.
   */
  alertFirstSeen: Record<string, string>;
  setScenario: (s: Scenario) => void;
  setTheme: (t: Theme) => void;
  setLocation: (l: LocationKey) => void;
  setDepartment: (d: Department) => void;
  saveScenario: (name: string, blanketDemandMultiplier: number) => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  markAlertRead: (id: string) => void;
  markAllAlertsRead: (ids: string[]) => void;
  recordAlertFirstSeen: (id: string, isoDateTime: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      scenario: "Base",
      theme: "system",
      location: "default",
      department: "framed",
      savedScenarios: [],
      sidebarCollapsed: false,
      readAlertIds: [],
      alertFirstSeen: {},
      setScenario: (s) => set({ scenario: s }),
      setTheme: (t) => set({ theme: t }),
      setLocation: (l) => set({ location: l }),
      setDepartment: (d) => set({ department: d }),
      saveScenario: (name, blanketDemandMultiplier) =>
        set((st) => ({
          savedScenarios: [
            ...st.savedScenarios.filter((x) => x.name !== name),
            { name, blanketDemandMultiplier },
          ],
        })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebar: () => set((st) => ({ sidebarCollapsed: !st.sidebarCollapsed })),
      markAlertRead: (id) =>
        set((st) => (st.readAlertIds.includes(id) ? st : { readAlertIds: [...st.readAlertIds, id] })),
      markAllAlertsRead: (ids) =>
        set((st) => {
          const next = new Set(st.readAlertIds);
          for (const id of ids) next.add(id);
          return { readAlertIds: Array.from(next) };
        }),
      recordAlertFirstSeen: (id, isoDateTime) =>
        set((st) => (st.alertFirstSeen[id]
          ? st
          : { alertFirstSeen: { ...st.alertFirstSeen, [id]: isoDateTime } })),
    }),
    { name: "inkaar-app-state" },
  ),
);

export function blanketForScenario(
  scenario: Scenario,
  saved: { name: string; blanketDemandMultiplier: number }[],
): number {
  // Demand multipliers. "+15%" / "-15%" are the official names; the older
  // "Optimistic" / "Pessimistic" labels remain mapped for backward compat
  // with any persisted Zustand state from earlier versions.
  if (scenario === "-15%" || scenario === "Optimistic") return 0.85;
  if (scenario === "+15%" || scenario === "Pessimistic") return 1.15;
  if (scenario === "Base") return 1;
  const found = saved.find((x) => x.name === scenario);
  return found?.blanketDemandMultiplier ?? 1;
}
