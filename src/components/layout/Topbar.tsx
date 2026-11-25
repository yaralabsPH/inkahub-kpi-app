import { Bell, Check, CheckCheck, Database, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, SlidersHorizontal, Sun } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useAppStore, type Theme } from "@/lib/state/appStore";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useDataset } from "@/lib/hooks/useDataset";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { fmtShortDate } from "@/lib/utils/format";
import { alertKey, detectAlerts, notifyEmail, notifyWebhook, type AlertPayload } from "@/lib/alerts/notifier";
import { LOCATIONS, LOCATION_LABELS, navLabel } from "@/lib/domain";
import { getBackendMode } from "@/lib/repository/supabase/client";
import { environmentLabel, resolveTheme } from "@/lib/ui/appearance";
import { NAV_GROUPS } from "./navigation";

const SCENARIOS = ["Base", "+15%", "-15%"] as const;

const THEMES: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "dark", label: "Dark theme", Icon: Moon },
];

/** Page title for the top bar, from the nav item whose route matches. */
function usePageTitle(): string {
  const { pathname } = useLocation();
  const { data } = useDataset();
  let best: { key: Parameters<typeof navLabel>[0]; len: number } | null = null;
  for (const g of NAV_GROUPS) {
    for (const item of g.items) {
      const match = item.to === "/" ? pathname === "/" : pathname === item.to || pathname.startsWith(item.to + "/");
      if (match && (!best || item.to.length > best.len)) best = { key: item.key, len: item.to.length };
    }
  }
  if (best) return navLabel(best.key, data?.settings);
  if (pathname.startsWith("/stock-value")) return "Stock value";
  return "";
}

const iconBtn =
  "relative inline-grid h-8 w-8 shrink-0 place-items-center rounded-hub text-hub-muted hover:bg-hub-fill hover:text-hub-text";

export function Topbar({ onOpenMenu, menuOpen }: { onOpenMenu: () => void; menuOpen: boolean }) {
  const scenario = useAppStore((s) => s.scenario);
  const setScenario = useAppStore((s) => s.setScenario);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const saved = useAppStore((s) => s.savedScenarios);
  const department = useAppStore((s) => s.department);
  const setDepartment = useAppStore((s) => s.setDepartment);
  const location = useAppStore((s) => s.location);
  const setLocation = useAppStore((s) => s.setLocation);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const readAlertIds = useAppStore((s) => s.readAlertIds);
  const alertFirstSeen = useAppStore((s) => s.alertFirstSeen);
  const markAlertRead = useAppStore((s) => s.markAlertRead);
  const markAllAlertsRead = useAppStore((s) => s.markAllAlertsRead);
  const recordAlertFirstSeen = useAppStore((s) => s.recordAlertFirstSeen);
  const { list } = useForecasts();
  const { data } = useDataset();
  const [showAlerts, setShowAlerts] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const alertsRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const pageTitle = usePageTitle();
  const backend = getBackendMode();
  const envLabel = environmentLabel(import.meta.env.VITE_APP_ENV as string | undefined, import.meta.env.DEV);

  // Apply theme to <html class="dark">, following OS changes while "system".
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => root.classList.toggle("dark", resolveTheme(theme, !!mq?.matches) === "dark");
    apply();
    if (theme !== "system" || !mq) return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // Compute alerts and fire notifier stubs once per new alert.
  const alerts: AlertPayload[] = useMemo(() => {
    if (!data) return [];
    return detectAlerts(data.products, list, data.shipments);
  }, [data, list]);

  // Persist a stable first-seen timestamp + de-dupe stub notifier calls per
  // logical alert id (so they don't refire on every render).
  useEffect(() => {
    const now = new Date().toISOString();
    for (const a of alerts) {
      const id = alertKey(a);
      recordAlertFirstSeen(id, now);
      if (seenIdsRef.current.has(id)) continue;
      seenIdsRef.current.add(id);
      notifyEmail(a);
      notifyWebhook(a);
    }
  }, [alerts, recordAlertFirstSeen]);

  const readSet = useMemo(() => new Set(readAlertIds), [readAlertIds]);
  const alertsAnnotated = useMemo(
    () => alerts.map((a) => {
      const id = alertKey(a);
      return {
        a,
        id,
        firstSeen: alertFirstSeen[id] ?? a.emittedAt,
        read: readSet.has(id),
      };
    }),
    [alerts, alertFirstSeen, readSet],
  );
  const unreadCount = alertsAnnotated.filter((x) => !x.read).length;
  const allAlertIds = alertsAnnotated.map((x) => x.id);

  // Close popovers on outside click / Escape.
  useEffect(() => {
    if (!showAlerts && !showOptions) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (showAlerts && alertsRef.current && !alertsRef.current.contains(t)) setShowAlerts(false);
      if (showOptions && optionsRef.current && !optionsRef.current.contains(t)) setShowOptions(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowAlerts(false);
        setShowOptions(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showAlerts, showOptions]);

  const onLocationChange = (next: typeof location) => {
    if (next === location) return;
    // Persist the new location to Zustand (writes to localStorage) and then
    // do a full page reload. The reload wipes every piece of in-memory state
    // (React Query cache, mutation closures, open modals, Dexie connection
    // handles), guaranteeing the new location starts from a clean slate.
    setLocation(next);
    window.location.reload();
  };

  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b border-hub-line bg-hub-panel px-3 md:px-4">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        aria-expanded={menuOpen}
        className={cn(iconBtn, "md:hidden")}
      >
        <Menu size={18} />
      </button>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-pressed={collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className={cn(iconBtn, "hidden md:inline-grid")}
      >
        {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
      </button>
      <div className="min-w-0 truncate text-[13px] text-hub-muted">
        <span className="hidden sm:inline">Inka Arthouse&nbsp;&nbsp;/&nbsp;&nbsp;</span>
        <span className="font-medium text-hub-text">{pageTitle}</span>
      </div>

      <div className="flex-1" />

      {/* Wide screens: controls inline */}
      <div className="hidden items-center gap-2 lg:flex">
        <DisplayControls
          department={department}
          setDepartment={setDepartment}
          scenario={scenario}
          setScenario={setScenario}
          saved={saved}
          location={location}
          onLocationChange={onLocationChange}
          layout="inline"
        />
      </div>

      {/* Real backend always; the environment label only outside production. */}
      <span
        className="hidden items-center gap-1 whitespace-nowrap rounded-full border border-hub-accent bg-hub-accent-bg px-2 py-0.5 text-[11.5px] text-hub-accent-text sm:inline-flex"
        title={backend === "supabase" ? "Data is stored in Supabase" : "Data is stored in this browser"}
      >
        <Database size={12} aria-hidden="true" />
        {backend === "supabase" ? "Supabase" : "Local"}
        {envLabel ? <> · {envLabel}</> : null}
      </span>

      <div className="hidden sm:block">
        <ThemeSwitch theme={theme} setTheme={setTheme} />
      </div>

      {/* Narrow screens: the same controls in a labelled panel */}
      <div ref={optionsRef} className="relative lg:hidden">
        <button
          type="button"
          onClick={() => setShowOptions((v) => !v)}
          aria-label="Display options: department, scenario, location and theme"
          aria-expanded={showOptions}
          aria-haspopup="dialog"
          className={iconBtn}
        >
          <SlidersHorizontal size={15} />
        </button>
        {showOptions ? (
          <div
            role="dialog"
            aria-label="Display options"
            className="absolute right-0 top-10 z-30 w-[min(20rem,calc(100vw-1.5rem))] space-y-3 rounded-[10px] border border-hub-line bg-hub-panel p-3 shadow-hub-pop"
          >
            <DisplayControls
              department={department}
              setDepartment={setDepartment}
              scenario={scenario}
              setScenario={setScenario}
              saved={saved}
              location={location}
              onLocationChange={onLocationChange}
              layout="stacked"
            />
            <div className="flex items-center justify-between sm:hidden">
              <span className="text-xs text-hub-muted">Theme</span>
              <ThemeSwitch theme={theme} setTheme={setTheme} />
            </div>
            <div className="text-xs text-hub-muted sm:hidden">
              Data: {backend === "supabase" ? "Supabase" : "Local"}
              {envLabel ? ` · ${envLabel}` : ""}
            </div>
          </div>
        ) : null}
      </div>

      <div ref={alertsRef} className="relative">
        <button
          type="button"
          aria-label={`Alerts: ${unreadCount} unread of ${alerts.length}`}
          aria-expanded={showAlerts}
          aria-haspopup="dialog"
          onClick={() => setShowAlerts((v) => !v)}
          className={iconBtn}
        >
          <Bell size={15} />
          {unreadCount > 0 ? (
            <span
              className="absolute -right-0.5 -top-0.5 grid h-4 min-w-[16px] place-items-center rounded-full bg-hub-bad px-1 text-[10px] font-bold text-white"
              aria-hidden="true"
            >
              {unreadCount}
            </span>
          ) : null}
        </button>
        {showAlerts ? (
          <div
            role="dialog"
            aria-label="Alerts"
            className="absolute right-0 top-10 z-30 max-h-[28rem] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-[10px] border border-hub-line bg-hub-panel shadow-hub-pop"
          >
            <div className="flex items-center justify-between border-b border-hub-line px-3.5 py-2.5">
              <div className="text-[13px] font-semibold text-hub-text">
                Alerts <span className="font-normal text-hub-muted">· {unreadCount} unread / {alerts.length} total</span>
              </div>
              {unreadCount > 0 ? (
                <button
                  type="button"
                  onClick={() => markAllAlertsRead(allAlertIds)}
                  className="inline-flex h-7 items-center gap-1 rounded-hub px-2 text-xs text-hub-muted hover:bg-hub-fill hover:text-hub-text"
                >
                  <CheckCheck size={13} /> Mark all read
                </button>
              ) : null}
            </div>
            {alerts.length === 0 ? (
              <div className="p-4 text-[13px] text-hub-muted">All quiet — no critical SKUs or slipped shipments.</div>
            ) : (
              <ul className="divide-y divide-hub-line">
                {alertsAnnotated.map(({ a, id, firstSeen, read }) => (
                  <li key={id} className={cn("px-3.5 py-2.5 text-[13px]", read && "opacity-60")}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[10.5px] font-semibold uppercase tracking-wide",
                            read
                              ? "text-hub-faint"
                              : a.kind === "oos" ? "text-hub-bad"
                                : a.kind === "critical" ? "text-hub-warn"
                                  : "text-hub-info",
                          )}>
                            {a.kind === "oos" ? "Out of stock" : a.kind === "critical" ? "Critical" : "Shipment slipped"}
                          </span>
                          <span className="text-[10.5px] tabular-nums text-hub-faint">
                            first alerted {fmtShortDate(firstSeen.slice(0, 10))}
                          </span>
                        </div>
                        <div className="mt-0.5 text-hub-text">{a.message}</div>
                      </div>
                      {read ? (
                        <span className="mt-0.5 shrink-0 text-[10.5px] uppercase tracking-wide text-hub-faint">read</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => markAlertRead(id)}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] text-hub-muted hover:bg-hub-fill hover:text-hub-text"
                          aria-label="Mark as read"
                          title="Mark as read"
                        >
                          <Check size={12} /> Mark read
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-hub-line px-3.5 py-2 text-[10.5px] text-hub-muted">
              Read alerts stay listed but don't count toward the bell badge. Email/webhook stubs log to the console — wire them in <code>src/lib/alerts/notifier.ts</code>.
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function ThemeSwitch({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <span role="group" aria-label="Theme" className="inline-flex items-center gap-0.5 rounded-full border border-hub-line-2 p-0.5">
      {THEMES.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => setTheme(value)}
          aria-label={label}
          aria-pressed={theme === value}
          title={label}
          className={cn(
            "inline-grid h-[22px] w-6 place-items-center rounded-full",
            theme === value ? "bg-hub-fill-2 text-hub-text" : "text-hub-muted hover:text-hub-text",
          )}
        >
          <Icon size={13} />
        </button>
      ))}
    </span>
  );
}

type Dept = "framed" | "unframed";

function DisplayControls({
  department,
  setDepartment,
  scenario,
  setScenario,
  saved,
  location,
  onLocationChange,
  layout,
}: {
  department: Dept;
  setDepartment: (d: Dept) => void;
  scenario: string;
  setScenario: (s: string) => void;
  saved: { name: string }[];
  location: (typeof LOCATIONS)[number];
  onLocationChange: (next: (typeof LOCATIONS)[number]) => void;
  layout: "inline" | "stacked";
}) {
  const scenarioId = useId();
  const locationId = useId();
  const stacked = layout === "stacked";
  const selectCls =
    "h-7 rounded-hub border border-hub-line-2 bg-hub-panel px-1.5 text-[12.5px] text-hub-text";
  return (
    <>
      {/* Department toggle — splits Sales Entry, Order Builder, Dashboard
          and forecasting into two parallel views. Persisted to localStorage
          so it survives reloads. */}
      <div className={cn(stacked && "flex items-center justify-between gap-3")}>
        {stacked ? <span className="text-xs text-hub-muted">Department</span> : null}
        <div
          className="inline-flex overflow-hidden rounded-hub border border-hub-line-2 text-[12.5px]"
          role="group"
          aria-label="Department"
          title="Filters Sales entry, Dashboard, Order builder and forecasts"
        >
          {(["framed", "unframed"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={department === d}
              onClick={() => setDepartment(d)}
              className={cn(
                "h-7 px-2.5",
                department === d ? "bg-hub-text text-hub-panel" : "bg-hub-panel text-hub-muted hover:text-hub-text",
              )}
              title={d === "framed" ? "Framed: CHINA-supplied SKUs" : "Unframed: A0–A4 prints"}
            >
              {d === "framed" ? "Framed" : "Unframed"}
            </button>
          ))}
        </div>
      </div>

      <div className={cn("flex items-center gap-1.5", stacked && "justify-between gap-3")}>
        <label className="text-xs text-hub-muted" htmlFor={scenarioId}>
          Scenario
        </label>
        <select
          id={scenarioId}
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          className={selectCls}
        >
          {SCENARIOS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
          {saved.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
      </div>

      <div className={cn("flex items-center gap-1.5", stacked && "justify-between gap-3")}>
        <label className={cn("text-xs text-hub-muted", !stacked && "sr-only")} htmlFor={locationId}>
          Location
        </label>
        <select
          id={locationId}
          value={location}
          onChange={(e) => onLocationChange(e.target.value as (typeof LOCATIONS)[number])}
          aria-label="Switch location (reloads the app)"
          title="Switching location reloads the app"
          className={selectCls}
        >
          {LOCATIONS.map((l) => (
            <option key={l} value={l}>{LOCATION_LABELS[l]}</option>
          ))}
        </select>
      </div>
    </>
  );
}
