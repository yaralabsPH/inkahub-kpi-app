import React, { useEffect, useState } from "react";
import { UserPlus, Users, Trash2, Printer, RefreshCw } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Field, Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/lib/auth/AuthProvider";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import {
  LOCATIONS, LOCATION_LABELS,
  NAV_KEYS, DEFAULT_NAV_LABELS,
  type NavKey,
} from "@/lib/domain";
import { effectiveNavAccess } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils/cn";
import { generateBarcodeToken, printLanyard } from "@/lib/utils/lanyard";

type Role = "owner" | "manager" | "staff" | "kiosk" | "cs";

interface MemberRow {
  user_id: string;
  display_name: string;
  role: Role;
  locations: string[];
  /** NULL = use role defaults. Specific array = explicit override. */
  allowed_nav: string[] | null;
  /** Current ACTIVE lanyard token for this user (any location — they
   *  share the same value across locations). Null if not yet issued. */
  barcode: string | null;
  /** Hourly rate for cost-per-frame calculations. Null = not set. */
  hourly_rate: number | null;
}

const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
  kiosk: "Kiosk",
  cs: "CS",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full access. Only role that can manage users.",
  manager: "Full operational access for their granted locations. Cannot manage users.",
  staff: "Read access for granted locations. Write access is limited to staff-owned modules (returns / production runs — coming soon).",
  kiosk: "Shared station login. Can record production events on behalf of scanned staff and nothing else. Cannot edit stock, sales, or correct events.",
  cs: "Customer Service. Can log returns and create replacement cases on /cs-returns and /cs-cases. No access to stock editing, shipments, or reports.",
};

/**
 * Public entry point. Hides the card entirely outside of Supabase mode
 * (Dexie mode has no auth) so we can safely use hooks below without
 * worrying about AuthProvider not being mounted.
 */
export function TeamMembersCard() {
  if (getBackendMode() !== "supabase") return null;
  return <TeamMembersCardInner />;
}

function TeamMembersCardInner() {
  const { profile } = useAuth();
  const supabase = getSupabase();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  // Invite form state
  const [newUid, setNewUid] = useState("");
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<Role>("manager");
  const [newLocs, setNewLocs] = useState<Set<string>>(new Set([LOCATIONS[0]]));
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  // Only owners see this card. Other roles get nothing.
  if (profile?.role !== "owner") return null;

  const loadMembers = async () => {
    setLoading(true);
    setGlobalError(null);
    try {
      const [profilesRes, locsRes, barcodesRes, ratesRes] = await Promise.all([
        supabase.from("profiles").select("user_id, display_name, role, allowed_nav"),
        supabase.from("user_locations").select("user_id, location"),
        // Active barcodes only — revoked rows are kept for historical
        // event lookup but don't drive the UI.
        supabase.from("staff_barcodes").select("user_id, barcode, active").eq("active", true),
        supabase.from("staff_rates").select("user_id, hourly_rate"),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (locsRes.error) throw locsRes.error;
      if (barcodesRes.error) throw barcodesRes.error;
      if (ratesRes.error) throw ratesRes.error;

      const locsByUser = new Map<string, string[]>();
      for (const r of locsRes.data ?? []) {
        const arr = locsByUser.get(r.user_id) ?? [];
        arr.push(r.location);
        locsByUser.set(r.user_id, arr);
      }
      // One user can have N rows in staff_barcodes (one per location) but
      // they all share the same barcode value when issued together. We
      // pluck the first one.
      const barcodeByUser = new Map<string, string>();
      for (const r of barcodesRes.data ?? []) {
        if (!barcodeByUser.has(r.user_id)) barcodeByUser.set(r.user_id, r.barcode);
      }
      // staff_rates is one row per user (PK is user_id alone on the
      // location-scoped table — picking any row is fine).
      const rateByUser = new Map<string, number>();
      for (const r of ratesRes.data ?? []) {
        if (!rateByUser.has(r.user_id)) rateByUser.set(r.user_id, Number(r.hourly_rate));
      }

      const rows: MemberRow[] = (profilesRes.data ?? []).map((p) => ({
        user_id: p.user_id,
        display_name: p.display_name,
        role: p.role as Role,
        locations: locsByUser.get(p.user_id) ?? [],
        allowed_nav: (p.allowed_nav as string[] | null) ?? null,
        barcode: barcodeByUser.get(p.user_id) ?? null,
        hourly_rate: rateByUser.get(p.user_id) ?? null,
      }));

      // Sort owner first, then manager, then staff; within each role
      // alphabetical by display name.
      const roleRank: Record<Role, number> = { owner: 0, manager: 1, staff: 2, kiosk: 3, cs: 4 };
      rows.sort((a, b) =>
        roleRank[a.role] - roleRank[b.role]
        || a.display_name.localeCompare(b.display_name),
      );
      setMembers(rows);
    } catch (e) {
      setGlobalError(`Couldn't load team: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Update one field of one user's profile row. */
  const updateRole = async (userId: string, role: Role) => {
    setBusyUserId(userId);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ role })
        .eq("user_id", userId);
      if (error) throw error;
      setMembers((prev) => prev.map((m) => m.user_id === userId ? { ...m, role } : m));
    } catch (e) {
      setGlobalError(`Role update failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  const updateDisplayName = async (userId: string, name: string) => {
    if (!name.trim()) return;
    setBusyUserId(userId);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ display_name: name.trim() })
        .eq("user_id", userId);
      if (error) throw error;
      setMembers((prev) => prev.map((m) => m.user_id === userId ? { ...m, display_name: name.trim() } : m));
    } catch (e) {
      setGlobalError(`Name update failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  /** Toggle a location grant on/off for a user. */
  const toggleLocation = async (userId: string, location: string, checked: boolean) => {
    setBusyUserId(userId);
    try {
      if (checked) {
        const { error } = await supabase
          .from("user_locations")
          .upsert({ user_id: userId, location }, { onConflict: "user_id,location" });
        if (error) throw error;
        setMembers((prev) => prev.map((m) =>
          m.user_id === userId
            ? { ...m, locations: Array.from(new Set([...m.locations, location])) }
            : m));
      } else {
        const { error } = await supabase
          .from("user_locations")
          .delete()
          .eq("user_id", userId)
          .eq("location", location);
        if (error) throw error;
        setMembers((prev) => prev.map((m) =>
          m.user_id === userId
            ? { ...m, locations: m.locations.filter((l) => l !== location) }
            : m));
      }
    } catch (e) {
      setGlobalError(`Location toggle failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  /**
   * Replace a user's allowed_nav. Pass `null` to reset to role defaults,
   * or an array of NavKeys for an explicit override.
   */
  const updateAllowedNav = async (userId: string, next: string[] | null) => {
    setBusyUserId(userId);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ allowed_nav: next })
        .eq("user_id", userId);
      if (error) throw error;
      setMembers((prev) => prev.map((m) =>
        m.user_id === userId ? { ...m, allowed_nav: next } : m));
    } catch (e) {
      setGlobalError(`Page access update failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  /**
   * Remove a user's profile (and their location grants, via cascade). Does
   * NOT delete the auth.users row — that has to be done from the Supabase
   * dashboard. The effect on the user: they can still authenticate, but
   * the AuthGate will reject them with "Profile not found".
   */
  const removeMember = async (userId: string, name: string) => {
    if (userId === profile?.user_id) {
      setGlobalError("You can't remove your own profile from here.");
      return;
    }
    if (!window.confirm(
      `Remove ${name} from the team?\n\n` +
      `This deletes their profile and all location grants. They won't be able to access the app anymore.\n\n` +
      `To completely delete their account, also remove them from Supabase → Authentication → Users.`,
    )) return;
    setBusyUserId(userId);
    try {
      const { error } = await supabase.from("profiles").delete().eq("user_id", userId);
      if (error) throw error;
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
    } catch (e) {
      setGlobalError(`Remove failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  /**
   * Issue a new lanyard barcode for a user. If they already have one
   * active, revoke it first so we don't end up with two valid tokens.
   * Writes one row per location the user has access to (all sharing the
   * same token value) so the scanner can find them at any of their
   * granted locations.
   */
  const issueBarcode = async (member: MemberRow) => {
    if (member.locations.length === 0) {
      setGlobalError(`${member.display_name} has no locations granted yet. Tick at least one location first.`);
      return;
    }
    if (member.barcode && !window.confirm(
      `${member.display_name} already has a lanyard barcode. Issue a new one?\n\n` +
      `The old barcode will stop working immediately — make sure to dispose of the old lanyard.`,
    )) return;
    setBusyUserId(member.user_id);
    try {
      // Revoke any existing active barcode rows.
      if (member.barcode) {
        const { error: revokeErr } = await supabase
          .from("staff_barcodes")
          .update({ active: false, revoked_at: new Date().toISOString() })
          .eq("user_id", member.user_id)
          .eq("active", true);
        if (revokeErr) throw revokeErr;
      }
      // Generate a fresh token. Retry once on the (extremely unlikely)
      // case of a collision with an existing barcode in the same location.
      let token = generateBarcodeToken();
      const now = new Date().toISOString();
      const rows = member.locations.map((loc) => ({
        location: loc,
        barcode: token,
        user_id: member.user_id,
        display_name: member.display_name,
        active: true,
        created_at: now,
      }));
      let { error: insErr } = await supabase.from("staff_barcodes").insert(rows);
      if (insErr) {
        // 23505 = unique_violation. Retry with a fresh token.
        if ((insErr as { code?: string }).code === "23505") {
          token = generateBarcodeToken();
          const retry = await supabase.from("staff_barcodes").insert(
            member.locations.map((loc) => ({ ...rows[0], location: loc, barcode: token })),
          );
          if (retry.error) throw retry.error;
        } else {
          throw insErr;
        }
      }
      setMembers((prev) => prev.map((m) =>
        m.user_id === member.user_id ? { ...m, barcode: token } : m,
      ));
    } catch (e) {
      setGlobalError(`Couldn't issue barcode: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  /**
   * Open the print window for an existing barcode. Pure client-side —
   * doesn't talk to Supabase.
   */
  const printBarcode = (member: MemberRow) => {
    if (!member.barcode) return;
    printLanyard({
      name: member.display_name,
      barcode: member.barcode,
      subtitle: ROLE_LABELS[member.role],
    });
  };

  /**
   * Upsert the hourly rate. We deliberately insert with the FIRST granted
   * location (staff_rates is per-location to match the RLS pattern, but
   * each user has one logical rate). If the user has no locations yet,
   * we bail with a clear error.
   */
  const updateRate = async (member: MemberRow, rate: number | null) => {
    if (member.locations.length === 0) {
      setGlobalError(`${member.display_name} has no locations granted — grant a location first.`);
      return;
    }
    setBusyUserId(member.user_id);
    try {
      const loc = member.locations[0];
      if (rate === null || Number.isNaN(rate)) {
        // Clear the rate — delete the row(s).
        const { error } = await supabase
          .from("staff_rates")
          .delete()
          .eq("user_id", member.user_id);
        if (error) throw error;
        setMembers((prev) => prev.map((m) =>
          m.user_id === member.user_id ? { ...m, hourly_rate: null } : m,
        ));
        return;
      }
      const { error } = await supabase
        .from("staff_rates")
        .upsert({
          location: loc,
          user_id: member.user_id,
          hourly_rate: rate,
          updated_at: new Date().toISOString(),
          updated_by: profile?.user_id ?? null,
        }, { onConflict: "location,user_id" });
      if (error) throw error;
      setMembers((prev) => prev.map((m) =>
        m.user_id === member.user_id ? { ...m, hourly_rate: rate } : m,
      ));
    } catch (e) {
      setGlobalError(`Rate update failed: ${(e as Error).message}`);
    } finally {
      setBusyUserId(null);
    }
  };

  const submitInvite = async () => {
    setInviteMsg(null);
    setGlobalError(null);
    const uid = newUid.trim();
    const name = newName.trim();
    if (!uid) { setInviteMsg("Paste the UID from Supabase → Authentication → Users."); return; }
    if (!name) { setInviteMsg("Enter a display name."); return; }
    if (newLocs.size === 0) { setInviteMsg("Tick at least one location."); return; }
    setInviteBusy(true);
    try {
      // Two inserts: profile + one user_locations row per ticked location.
      const { error: profErr } = await supabase
        .from("profiles")
        .insert({ user_id: uid, display_name: name, role: newRole });
      if (profErr) throw profErr;

      const locRows = Array.from(newLocs).map((loc) => ({ user_id: uid, location: loc }));
      const { error: locErr } = await supabase
        .from("user_locations")
        .insert(locRows);
      if (locErr) {
        // Roll back the profile insert if location grants failed, so we
        // don't end up with a profile-but-no-locations stranded user.
        await supabase.from("profiles").delete().eq("user_id", uid);
        throw locErr;
      }

      setInviteMsg(`Added ${name} as ${ROLE_LABELS[newRole]}.`);
      setNewUid("");
      setNewName("");
      setNewRole("manager");
      setNewLocs(new Set([LOCATIONS[0]]));
      await loadMembers();
    } catch (e) {
      setInviteMsg(`Invite failed: ${(e as Error).message}`);
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <Users size={16} /> Team members
        </CardTitle>
        <span className="text-xs text-slate-500">
          Manage who has access to the Inka Arthouse Hub. Only owners can change these settings.
        </span>
      </CardHeader>
      <CardBody className="space-y-4">
        {globalError ? (
          <div className="text-sm text-red-600 dark:text-red-400 rounded-md ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2">
            {globalError}
          </div>
        ) : null}

        {/* ----- Existing members table ----- */}
        {loading ? (
          <div className="text-sm text-slate-500">Loading team…</div>
        ) : members.length === 0 ? (
          <div className="text-sm text-slate-500">No members yet.</div>
        ) : (
          <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-600 dark:text-slate-400 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Name</th>
                  <th className="text-left font-medium px-2 py-2">Role</th>
                  <th className="text-left font-medium px-2 py-2">Locations</th>
                  <th className="text-right font-medium px-2 py-2 w-px">Remove</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {members.map((m) => {
                  const isSelf = m.user_id === profile?.user_id;
                  return (
                    <React.Fragment key={m.user_id}>
                    <tr className={cn(busyUserId === m.user_id ? "opacity-60" : "")}>
                      <td className="px-3 py-1.5 align-top">
                        <Input
                          defaultValue={m.display_name}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== m.display_name) void updateDisplayName(m.user_id, v);
                          }}
                          className="h-7 text-sm"
                        />
                        <div className="font-mono text-[10px] text-slate-400 mt-1 truncate max-w-[24ch]" title={m.user_id}>
                          {m.user_id}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <Select
                          value={m.role}
                          disabled={isSelf}
                          onChange={(e) => void updateRole(m.user_id, e.target.value as Role)}
                          title={isSelf ? "You can't change your own role here." : ROLE_DESCRIPTIONS[m.role]}
                          className="h-7 text-sm w-32"
                        >
                          <option value="owner">Owner</option>
                          <option value="manager">Manager</option>
                          <option value="kiosk">Kiosk</option>
                          <option value="cs">CS</option>
                          <option value="staff">Staff</option>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <div className="flex flex-wrap gap-1.5">
                          {LOCATIONS.map((loc) => {
                            const checked = m.locations.includes(loc);
                            return (
                              <label key={loc} className={cn(
                                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ring-1 cursor-pointer",
                                checked
                                  ? "ring-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
                                  : "ring-slate-200 dark:ring-slate-700 text-slate-500",
                              )}>
                                <input
                                  type="checkbox"
                                  className="sr-only"
                                  checked={checked}
                                  onChange={(e) => void toggleLocation(m.user_id, loc, e.target.checked)}
                                />
                                {LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}
                              </label>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right align-top">
                        <button
                          type="button"
                          disabled={isSelf || busyUserId === m.user_id}
                          onClick={() => void removeMember(m.user_id, m.display_name)}
                          className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded",
                            isSelf
                              ? "text-slate-300 dark:text-slate-700 cursor-not-allowed"
                              : "text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30",
                          )}
                          title={isSelf ? "You can't remove yourself" : "Remove member"}
                          aria-label={`Remove ${m.display_name}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                    {/* Page-access editor for THIS member. <tr> spans the
                        full row beneath the main row to keep the table
                        aligned. Collapsed by default — click to expand. */}
                    <tr key={`${m.user_id}-pages`}>
                      <td
                        colSpan={4}
                        className="px-3 pb-2"
                        style={{ isolation: "isolate", contain: "layout paint" }}
                      >
                        <details className="text-xs" style={{ isolation: "isolate", contain: "layout paint" }}>
                          <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">
                            Page access ({(() => {
                              const eff = effectiveNavAccess({
                                user_id: m.user_id,
                                display_name: m.display_name,
                                role: m.role,
                                allowed_nav: m.allowed_nav,
                              });
                              return `${eff.size} of ${NAV_KEYS.length} pages${m.allowed_nav === null ? " — using role defaults" : " — custom"}`;
                            })()})
                          </summary>
                          <div className="mt-2 space-y-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/40 dark:bg-slate-900/20">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              Tick the pages this user can see in the sidebar and access via URL. Dashboard is always available. Untick all to fall back to role defaults.
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {NAV_KEYS.map((key: NavKey) => {
                                // Compute "is this page accessible" based on current allowed_nav.
                                // For display checkbox: if allowed_nav is null, use role defaults.
                                const eff = effectiveNavAccess({
                                  user_id: m.user_id,
                                  display_name: m.display_name,
                                  role: m.role,
                                  allowed_nav: m.allowed_nav,
                                });
                                const checked = eff.has(key);
                                // Dashboard is always-on; show as locked.
                                const locked = key === "dashboard";
                                return (
                                  <label key={key} className={cn(
                                    "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] ring-1",
                                    locked
                                      ? "ring-slate-300 bg-slate-100 text-slate-500 cursor-not-allowed dark:ring-slate-700 dark:bg-slate-800"
                                      : checked
                                        ? "ring-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200 cursor-pointer"
                                        : "ring-slate-200 text-slate-500 dark:ring-slate-700 cursor-pointer",
                                  )}>
                                    <input
                                      type="checkbox"
                                      className="sr-only"
                                      disabled={locked}
                                      checked={checked}
                                      onChange={(e) => {
                                        // Toggling switches us to explicit-override mode.
                                        // Start from current effective set, mutate, save.
                                        const next = new Set<string>(eff);
                                        if (e.target.checked) next.add(key);
                                        else next.delete(key);
                                        next.add("dashboard"); // always on
                                        void updateAllowedNav(m.user_id, Array.from(next));
                                      }}
                                    />
                                    {DEFAULT_NAV_LABELS[key]}
                                  </label>
                                );
                              })}
                            </div>
                            {m.allowed_nav !== null ? (
                              <button
                                type="button"
                                onClick={() => void updateAllowedNav(m.user_id, null)}
                                className="text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline"
                              >
                                Reset to {m.role} defaults
                              </button>
                            ) : null}
                          </div>
                        </details>

                        {/* Production tools — barcode lanyard + hourly rate.
                            Only relevant to staff who do production work, but
                            we leave it visible for all roles so the owner can
                            issue a barcode to a manager who steps in to help
                            on the floor. */}
                        <details className="text-xs mt-1">
                          <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 select-none">
                            Production tools ({m.barcode ? "barcode issued" : "no barcode yet"}
                            {m.hourly_rate !== null ? ` · $${m.hourly_rate.toFixed(2)}/hr` : " · no rate set"})
                          </summary>
                          <div className="mt-2 space-y-2 rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-3 py-2 bg-slate-50/40 dark:bg-slate-900/20">
                            {/* Barcode row */}
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-slate-500 dark:text-slate-400 w-24">Lanyard barcode</span>
                              {m.barcode ? (
                                <>
                                  <code className="font-mono text-[12px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 tracking-widest">
                                    {m.barcode}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() => printBarcode(m)}
                                    className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
                                    title="Open a print window with this user's lanyard card"
                                  >
                                    <Printer size={12} /> Print lanyard
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void issueBarcode(m)}
                                    disabled={busyUserId === m.user_id}
                                    className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800"
                                    title="Generate a new barcode — invalidates the old lanyard"
                                  >
                                    <RefreshCw size={12} /> Regenerate
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void issueBarcode(m)}
                                  disabled={busyUserId === m.user_id || m.locations.length === 0}
                                  className="inline-flex items-center gap-1 text-[11px] px-2 h-7 rounded-md ring-1 ring-emerald-300 dark:ring-emerald-700 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 disabled:opacity-50 disabled:cursor-not-allowed"
                                  title={m.locations.length === 0 ? "Grant a location first" : "Generate a new barcode token"}
                                >
                                  Issue lanyard barcode
                                </button>
                              )}
                            </div>
                            {/* Hourly rate row */}
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-slate-500 dark:text-slate-400 w-24">Hourly rate</span>
                              <span className="text-[11px] text-slate-500">$</span>
                              <Input
                                type="number"
                                min={0}
                                step={0.01}
                                defaultValue={m.hourly_rate ?? ""}
                                placeholder="0.00"
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v === "") {
                                    if (m.hourly_rate !== null) void updateRate(m, null);
                                    return;
                                  }
                                  const n = Number(v);
                                  if (!Number.isFinite(n) || n < 0) return;
                                  if (n !== m.hourly_rate) void updateRate(m, n);
                                }}
                                className="h-7 text-sm w-24"
                              />
                              <span className="text-[11px] text-slate-400">
                                used for labour cost in production reports
                              </span>
                            </div>
                          </div>
                        </details>
                      </td>
                    </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ----- Invite form ----- */}
        <div className="rounded-md ring-1 ring-slate-200 dark:ring-slate-800 px-4 py-3 space-y-3">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <UserPlus size={14} /> Add a new member
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
            <div>
              <strong>Step 1 (Supabase dashboard):</strong> Go to Authentication → Users → Add user. Create their email + password. Tick Auto Confirm User. Copy their UID.
            </div>
            <div>
              <strong>Step 2 (here):</strong> Paste the UID below, set their role + locations, click Add.
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Supabase UID" hint="From Authentication → Users → click the user → top of their detail panel.">
              <Input value={newUid} onChange={(e) => setNewUid(e.target.value)} placeholder="a1b2c3d4-..." />
            </Field>
            <Field label="Display name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Jane Smith" />
            </Field>
            <Field label="Role" hint={ROLE_DESCRIPTIONS[newRole]}>
              <Select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                <option value="owner">Owner</option>
                <option value="manager">Manager</option>
                <option value="kiosk">Kiosk</option>
                <option value="cs">CS</option>
                <option value="staff">Staff</option>
              </Select>
            </Field>
            <Field label="Locations they can access">
              <div className="flex flex-wrap gap-1.5">
                {LOCATIONS.map((loc) => {
                  const checked = newLocs.has(loc);
                  return (
                    <label key={loc} className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] ring-1 cursor-pointer",
                      checked
                        ? "ring-emerald-400 bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200"
                        : "ring-slate-200 dark:ring-slate-700 text-slate-500",
                    )}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={(e) => setNewLocs((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(loc);
                          else next.delete(loc);
                          return next;
                        })}
                      />
                      {LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}
                    </label>
                  );
                })}
              </div>
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={submitInvite} disabled={inviteBusy}>
              {inviteBusy ? "Adding…" : "Add member"}
            </Button>
            {inviteMsg ? (
              <span className={cn(
                "text-xs",
                inviteMsg.startsWith("Invite failed") ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400",
              )}>
                {inviteMsg}
              </span>
            ) : null}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
