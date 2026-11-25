import { useState } from "react";
import { Printer, Download } from "lucide-react";
import { TeamMembersCard, TeamHeader } from "@/components/TeamMembersCard";
import { DepartmentsCard } from "@/components/departments/DepartmentsCard";
import { useAppStore } from "@/lib/state/appStore";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { getBackendMode } from "@/lib/repository/supabase/client";
import { printAllTeamLanyards, downloadAllTeamLanyards } from "@/components/team/bulkLanyards";

/**
 * Team page - dedicated home for team-member administration. Owners get the
 * full members database (TeamMembersCard renders its own header, stats and
 * side panel). Everyone else who can open the page keeps the bulk lanyard
 * actions, as before. Departments (F5) stay below for owners.
 */
export function Team() {
  const auth = useAuthOptional();
  const ownerView = getBackendMode() === "supabase" && auth?.profile?.role === "owner";
  return (
    <div className="mx-auto max-w-hub px-2 pb-20 pt-6 text-hub-text sm:px-6 lg:px-10">
      {ownerView ? <TeamMembersCard /> : (
        <>
          <TeamHeader />
          <BulkLanyardActions />
        </>
      )}

      {/* F5: business departments and home assignments. Owner-only; renders
          nothing for other roles and a notice without Supabase. */}
      <div className="mt-10">
        <DepartmentsCard />
      </div>
    </div>
  );
}

function BulkLanyardActions() {
  const location = useAppStore((s) => s.location);
  const [busy, setBusy] = useState<"print" | "download" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (kind: "print" | "download") => {
    setMsg(null);
    setBusy(kind);
    setMsg(kind === "print" ? await printAllTeamLanyards(location) : await downloadAllTeamLanyards(location));
    setBusy(null);
  };
  const btn = "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] text-hub-text shadow-[0_0_0_1px_rgb(var(--hub-line-2))] hover:bg-hub-hover disabled:opacity-50";
  return (
    <div className="mt-7 space-y-2 border-t border-hub-line pt-5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy !== null} onClick={() => void run("print")}>
          <Printer size={14} strokeWidth={1.6} /> {busy === "print" ? "Loading..." : "Print all team lanyards (PDF)"}
        </button>
        <button type="button" className={btn} disabled={busy !== null} onClick={() => void run("download")}>
          <Download size={14} strokeWidth={1.6} /> {busy === "download" ? "Generating..." : "Download all as JPEGs (zip)"}
        </button>
      </div>
      {msg ? <div className="text-[13px] text-hub-muted">{msg}</div> : null}
    </div>
  );
}
