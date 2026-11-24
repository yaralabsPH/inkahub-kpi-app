import { NavLink } from "react-router-dom";
import { LayoutDashboard, Coins, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils/cn";

/**
 * Overview / Stock value switch shared by the two owner-only dashboard
 * pages. Plain links to the existing routes (both behind the `dashboard`
 * permission); no new route or state.
 */
export function DashboardTabs() {
  const tab = ({ isActive }: { isActive: boolean }) =>
    cn(
      "-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px]",
      isActive ? "border-hub-text font-medium text-hub-text" : "border-transparent text-hub-muted hover:text-hub-text",
    );
  return (
    <nav aria-label="Dashboard views" className="mb-4 flex items-end gap-0.5 border-b border-hub-line">
      <NavLink to="/dashboard" end className={tab}>
        <LayoutDashboard size={14} aria-hidden="true" /> Overview
      </NavLink>
      <NavLink to="/stock-value" className={tab}>
        <Coins size={14} aria-hidden="true" /> Stock value
      </NavLink>
    </nav>
  );
}

export function OwnerOnlyBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-hub-warn-bg px-2 py-0.5 text-[11.5px] font-medium text-hub-warn">
      <ShieldCheck size={12} aria-hidden="true" /> Owner only
    </span>
  );
}
