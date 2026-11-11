import { Bell, Check, CheckCheck, Moon, Sun } from "lucide-react";
import { useAppStore } from "@/lib/state/appStore";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useDataset } from "@/lib/hooks/useDataset";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { fmtShortDate } from "@/lib/utils/format";
import { alertKey, detectAlerts, notifyEmail, notifyWebhook, type AlertPayload } from "@/lib/alerts/notifier";

const SCENARIOS = ["Base", "+15%", "-15%"] as const;

export function Topbar() {
  const scenario = useAppStore((s) => s.scenario);
  const setScenario = useAppStore((s) => s.setScenario);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const saved = useAppStore((s) => s.savedScenarios);
  const department = useAppStore((s) => s.department);
  const setDepartment = useAppStore((s) => s.setDepartment);
  const readAlertIds = useAppStore((s) => s.readAlertIds);
  const alertFirstSeen = useAppStore((s) => s.alertFirstSeen);
  const markAlertRead = useAppStore((s) => s.markAlertRead);
  const markAllAlertsRead = useAppStore((s) => s.markAllAlertsRead);
  const recordAlertFirstSeen = useAppStore((s) => s.recordAlertFirstSeen);
  const { list } = useForecasts();
  const { data } = useDataset();
  const [showAlerts, setShowAlerts] = useState(false);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Apply theme to <html class="dark">.
  useEffect(() => {
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = theme === "dark" || (theme === "system" && prefersDark);
    root.classList.toggle("dark", isDark);
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

  return (
    <header className="sticky top-0 z-10 grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur px-4">
      <div className="flex items-center gap-3 justify-self-start">
        {/* Department toggle — splits Sales Entry, Order Builder, Dashboard
            and forecasting into two parallel views. Persisted to localStorage
            so it survives reloads. */}
        <div
          className="inline-flex rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden text-xs"
          role="tablist"
          aria-label="Department"
        >
          {(["framed", "unframed"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={department === d}
              onClick={() => setDepartment(d)}
              className={cn(
                "px-3 h-8 transition font-medium",
                department === d
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
              title={d === "framed" ? "Framed: CHINA-supplied SKUs" : "Unframed: A0–A4 prints"}
            >
              {d === "framed" ? "Framed" : "Unframed"}
            </button>
          ))}
        </div>

        <label className="text-xs text-slate-500 dark:text-slate-400" htmlFor="scenario">
          Scenario
        </label>
        <select
          id="scenario"
          value={scenario}
          onChange={(e) => setScenario(e.target.value)}
          className="h-8 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          {SCENARIOS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
          {saved.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
      </div>
      {/* Centered brand mark — pinned to the viewport's horizontal centre so it
          sits in the true middle of the screen regardless of the sidebar width. */}
      <div
        className="pointer-events-none fixed top-0 left-1/2 -translate-x-1/2 h-14 z-20 flex flex-col items-center justify-center leading-[1.02] tracking-[0.24em] font-serif text-slate-900 dark:text-slate-100 select-none"
        aria-label="Inka Arthouse"
      >
        <span className="text-[16px] font-normal">INKA</span>
        <span className="text-[16px] font-normal">ARTHOUSE</span>
      </div>
      {/* Spacer so the grid layout still has its middle column reserved
          (keeps the left/right groups from sliding into the centre). */}
      <div aria-hidden="true" className="w-0" />
      <div className="flex items-center gap-1 justify-self-end">
        <button
          type="button"
          aria-label={`Toggle theme (current: ${theme})`}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <div className="relative">
          <button
            type="button"
            aria-label={`Alerts: ${unreadCount} unread of ${alerts.length}`}
            onClick={() => setShowAlerts((v) => !v)}
            className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <Bell size={16} />
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ring-2 ring-white dark:ring-slate-950",
                unreadCount === 0
                  ? "bg-slate-300 text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                  : "bg-red-500 text-white",
              )}
              aria-hidden="true"
            >
              {unreadCount}
            </span>
          </button>
          {showAlerts ? (
            <div
              role="dialog"
              aria-label="Alerts"
              className="absolute right-0 top-9 w-96 max-h-[28rem] overflow-y-auto rounded-lg ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 shadow-xl z-20"
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-800">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Alerts · {unreadCount} unread / {alerts.length} total
                </div>
                {unreadCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => markAllAlertsRead(allAlertIds)}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/30"
                  >
                    <CheckCheck size={12} /> Mark all as read
                  </button>
                ) : null}
              </div>
              {alerts.length === 0 ? (
                <div className="p-4 text-sm text-slate-500">All quiet — no critical SKUs or slipped shipments.</div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {alertsAnnotated.map(({ a, id, firstSeen, read }) => (
                    <li
                      key={id}
                      className={cn(
                        "px-3 py-2 text-sm",
                        read && "bg-slate-50/60 dark:bg-slate-900/40",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-[10px] uppercase tracking-wide font-semibold",
                              read
                                ? "text-slate-400"
                                : a.kind === "oos" ? "text-red-600 dark:text-red-400"
                                  : a.kind === "critical" ? "text-amber-600 dark:text-amber-400"
                                    : "text-blue-600 dark:text-blue-400",
                            )}>
                              {a.kind === "oos" ? "Out of stock" : a.kind === "critical" ? "Critical" : "Shipment slipped"}
                            </span>
                            <span className="text-[10px] text-slate-400 tabular-nums">
                              first alerted {fmtShortDate(firstSeen.slice(0, 10))}
                            </span>
                          </div>
                          <div className={cn(
                            "mt-0.5",
                            read ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-slate-100",
                          )}>
                            {a.message}
                          </div>
                        </div>
                        {read ? (
                          <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0 mt-0.5">read</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => markAlertRead(id)}
                            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 shrink-0"
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
              <div className="px-3 py-2 text-[10px] text-slate-500 border-t border-slate-200 dark:border-slate-800">
                Read alerts stay listed but don't count toward the bell badge. Email/webhook stubs log to the console — wire them in <code>src/lib/alerts/notifier.ts</code>.
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
