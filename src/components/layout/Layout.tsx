import { useCallback, useEffect, useRef, useState } from "react";
import { useDataset } from "@/lib/hooks/useDataset";
import { DatasetRefreshBanner } from "@/components/DatasetLoadState";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "@/components/CommandPalette";
import { UiPresentationProvider, useOverlayBehavior } from "@/components/ui/UiPresentation";

const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * App shell (redesign): grouped sidebar on the left (a drawer below 768px),
 * top bar, and the routed page. Everything inside `.ui-redesign-shell` uses
 * the redesign tokens; the standalone /production station is not mounted
 * here and keeps its own look.
 *
 * The command palette mounts here so it's available on every page; it keeps
 * itself hidden until the user presses "/" or Cmd/Ctrl+K.
 */
export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const drawerRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  // Same dataset query the sidebar already observes (no extra fetch).
  const dataset = useDataset();
  useOverlayBehavior(drawerOpen, drawerRef, closeDrawer);

  // Close the drawer after navigating.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Close the drawer when the window grows to desktop width. The saved
  // desktop collapse state is not touched.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => {
      if (mq.matches) setDrawerOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const focusMain = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById("main-content")?.focus();
  };

  return (
    <UiPresentationProvider>
      <div className="ui-redesign-shell flex h-full">
        <a
          href="#main-content"
          onClick={focusMain}
          className="fixed left-2 top-2 z-[100] -translate-y-16 rounded-hub bg-hub-text px-3 py-1.5 text-sm text-hub-panel focus:translate-y-0"
        >
          Skip to content
        </a>

        <Sidebar variant="rail" />

        {drawerOpen ? (
          <div className="fixed inset-0 z-50 md:hidden">
            <div aria-hidden="true" className="absolute inset-0 bg-hub-scrim" onClick={closeDrawer} />
            <div
              ref={drawerRef}
              role="dialog"
              aria-modal="true"
              aria-label="Main navigation"
              tabIndex={-1}
              className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] shadow-hub-pop"
            >
              <Sidebar variant="drawer" onClose={closeDrawer} />
            </div>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar onOpenMenu={() => setDrawerOpen(true)} menuOpen={drawerOpen} />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-y-auto bg-hub-page px-4 py-5 focus:outline-none md:px-8 md:py-7"
          >
            <DatasetRefreshBanner result={dataset} />
            <Outlet />
          </main>
        </div>
        <CommandPalette />
      </div>
    </UiPresentationProvider>
  );
}
