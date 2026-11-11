import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { CommandPalette } from "@/components/CommandPalette";

/**
 * App shell — sticky sidebar on the left, topbar at the top, route
 * `<Outlet />` fills the rest. Mounted by App.tsx as the layout route.
 *
 * The command palette mounts here so it's available on every page; it
 * keeps itself hidden until the user presses "/" or Cmd/Ctrl+K.
 */
export function Layout() {
  return (
    <div className="flex h-full">
      <Sidebar />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar />
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}
