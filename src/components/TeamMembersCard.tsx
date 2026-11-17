import { useEffect, useState, type ReactNode } from "react";
import { UserPlus, Trash2, Printer, RefreshCw, Search, ChevronRight, Lock, Check, X, Eye, EyeOff, Wand2 } from "lucide-react";
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

const ROLE_ORDER: Role[] = ["owner", "manager", "staff", "kiosk", "cs"];

/** Badge + avatar colours per role (light and dark). */
const ROLE_STYLE: Record<Role, { badge: string; avatar: string; dot: string }> = {
  owner: {
    badge: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/30",
    avatar: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
    dot: "bg-amber-500 dark:bg-amber-300",
  },
  manager: {
    badge: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-400/10 dark:text-indigo-300 dark:ring-indigo-400/30",
    avatar: "bg-indigo-100 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
    dot: "bg-indigo-500 dark:bg-indigo-300",
  },
  staff: {
    badge: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-400/10 dark:text-sky-300 dark:ring-sky-400/30",
    avatar: "bg-sky-100 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    dot: "bg-sky-500 dark:bg-sky-300",
  },
  kiosk: {
    badge: "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-400/10 dark:text-pink-300 dark:ring-pink-400/30",
    avatar: "bg-pink-100 text-pink-700 dark:bg-pink-400/15 dark:text-pink-300",
    dot: "bg-pink-500 dark:bg-pink-300",
  },
  cs: {
    badge: "bg-lime-50 text-lime-700 ring-lime-200 dark:bg-lime-400/10 dark:text-lime-300 dark:ring-lime-400/30",
    avatar: "bg-lime-100 text-lime-700 dark:bg-lime-400/15 dark:text-lime-300",
    dot: "bg-lime-500 dark:bg-lime-300",
  },
};

const LOCATION_SHORT: Record<string, string> = { default: "Default", uk: "UK", us: "US", au: "AU" };

/** Sidebar pages grouped for the access editor. Covers every NavKey. */
const NAV_GROUPS: Array<{ label: string; keys: NavKey[] }> = [
  { label: "Core", keys: ["welcome", "dashboard", "reports"] },
  { label: "Catalogue & sales", keys: ["skus", "sales", "events", "order_submission"] },
  { label: "Operations", keys: ["shipments", "warehouse", "orders", "paper", "movements"] },
  { label: "Customer service", keys: ["cs_cases", "cs_returns"] },
  { label: "Admin", keys: ["team", "settings"] },
];
const GROUPED_KEYS = new Set<NavKey>(NAV_GROUPS.flatMap((g) => g.keys));
const UNGROUPED_KEYS = NAV_KEYS.filter((k) => !GROUPED_KEYS.has(k));
const ALL_NAV_GROUPS = UNGROUPED_KEYS.length
  ? [...NAV_GROUPS, { label: "Other", keys: [...UNGROUPED_KEYS] }]
  : NAV_GROUPS;

type PanelTab = "access" | "locations" | "production";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
}

function effectiveFor(m: MemberRow) {
  return effectiveNavAccess({
    user_id: m.user_id,
    display_name: m.display_name,
    role: m.role,
    allowed_nav: m.allowed_nav,
  });
}

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
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [addedNotice, setAddedNotice] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<Role>("manager");
  const [newLocs, setNewLocs] = useState<Set<string>>(new Set([LOCATIONS[0]]));
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  // List + side panel UI state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<"member" | "add">("member");
  const [tab, setTab] = useState<PanelTab>("access");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<Role | "all">("all");

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
    const name = newName.trim();
    const email = newEmail.trim().toLowerCase();
    if (!name) { setInviteMsg("Invite failed: enter a display name."); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setInviteMsg("Invite failed: enter a valid email address."); return; }
    if (newPassword.length < 8) { setInviteMsg("Invite failed: password must be at least 8 characters."); return; }
    if (newLocs.size === 0) { setInviteMsg("Invite failed: tick at least one location."); return; }
    setInviteBusy(true);
    try {
      // The server creates the login (service-role key), the profile and the
      // location grants in one go, after checking we're an owner.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("your session has expired. Sign in again.");
      const res = await fetch("/api/team/add-member", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email,
          password: newPassword,
          display_name: name,
          role: newRole,
          locations: Array.from(newLocs),
        }),
      });
      if (res.status === 404) {
        throw new Error(
          "the add-member service isn't running on this server. It runs on Vercel (a deploy, or `vercel dev` locally), not on the plain Vite dev server.",
        );
      }
      const body = (await res.json().catch(() => ({}))) as { user_id?: string; error?: string };
      if (!res.ok || !body.user_id) {
        throw new Error(body.error ?? `server returned ${res.status}`);
      }

      setAddedNotice(`Added ${name} as ${ROLE_LABELS[newRole]}. They sign in with ${email} and the password you set.`);
      setNewName("");
      setNewEmail("");
      setNewPassword("");
      setNewRole("manager");
      setNewLocs(new Set([LOCATIONS[0]]));
      await loadMembers();
      setSelectedId(body.user_id);
      setPanelMode("member");
    } catch (e) {
      setInviteMsg(`Invite failed: ${(e as Error).message}`);
    } finally {
      setInviteBusy(false);
    }
  };

  const visible = members.filter((m) =>
    (roleFilter === "all" || m.role === roleFilter)
    && `${m.display_name} ${ROLE_LABELS[m.role]}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = members.find((m) => m.user_id === selectedId) ?? members[0] ?? null;
  const showAdd = panelMode === "add" || selected === null;

  const selectMember = (userId: string) => {
    setSelectedId(userId);
    setPanelMode("member");
  };

  return (
    <section className="space-y-4 p-1">
      {globalError ? (
        <div className="flex items-start justify-between gap-3 text-sm text-red-600 dark:text-red-400 ring-1 ring-red-200 dark:ring-red-900/40 bg-red-50/40 dark:bg-red-900/10 px-3 py-2">
          <span>{globalError}</span>
          <button
            type="button"
            onClick={() => setGlobalError(null)}
            className="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-300"
            aria-label="Dismiss error"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {addedNotice ? (
        <div className="flex items-start justify-between gap-3 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-300 dark:ring-emerald-400/30">
          <span>{addedNotice}</span>
          <button
            type="button"
            onClick={() => setAddedNotice(null)}
            className="shrink-0 opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* ----- Toolbar ----- */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-md bg-white px-3 ring-1 ring-slate-200 focus-within:ring-emerald-400 dark:bg-slate-900 dark:ring-slate-700">
          <Search size={15} className="text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or role…"
            className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
        </label>
        <div className="flex flex-wrap rounded-md bg-white p-1 ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700" role="group" aria-label="Filter by role">
          {(["all", ...ROLE_ORDER] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRoleFilter(r)}
              aria-pressed={roleFilter === r}
              className={cn(
                "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                roleFilter === r
                  ? "bg-slate-100 text-slate-900 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
                  : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
              )}
            >
              {r === "all" ? "All" : ROLE_LABELS[r]}
            </button>
          ))}
        </div>
        <Button
          onClick={() => { setPanelMode("add"); setInviteMsg(null); }}
          className="h-10 rounded-full px-5"
        >
          <UserPlus size={15} /> Add member
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        {/* ----- Member list ----- */}
        <Frame>
          <div className="bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            <div className="hidden h-12 grid-cols-[minmax(180px,1.6fr)_110px_minmax(140px,1.2fr)_110px_130px_16px] items-center gap-5 border-b border-slate-200 px-6 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 md:grid">
              <span>Member</span>
              <span>Role</span>
              <span>Locations</span>
              <span>Page access</span>
              <span>Production</span>
              <span />
            </div>
            {loading ? (
              <div className="px-6 py-8 text-sm text-slate-500">Loading team…</div>
            ) : members.length === 0 ? (
              <div className="px-6 py-8 text-sm text-slate-500">No members yet.</div>
            ) : visible.length === 0 ? (
              <div className="px-6 py-8 text-sm text-slate-500">No members match.</div>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {visible.map((m) => {
                  const isSel = !showAdd && selected?.user_id === m.user_id;
                  const pages = effectiveFor(m).size;
                  return (
                    <li key={m.user_id}>
                      <button
                        type="button"
                        onClick={() => selectMember(m.user_id)}
                        aria-current={isSel ? "true" : undefined}
                        className={cn(
                          "grid w-full grid-cols-[1fr_auto] items-center gap-x-5 gap-y-2 px-4 py-4 text-left transition-colors md:min-h-[76px] md:grid-cols-[minmax(180px,1.6fr)_110px_minmax(140px,1.2fr)_110px_130px_16px] md:px-6 md:py-0",
                          isSel
                            ? "bg-slate-50 shadow-[inset_3px_0_0_theme(colors.emerald.500)] dark:bg-slate-800/50 dark:shadow-[inset_3px_0_0_theme(colors.emerald.400)]"
                            : "hover:bg-slate-50 dark:hover:bg-slate-800/30",
                          busyUserId === m.user_id ? "opacity-60" : "",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-3.5">
                          <Avatar member={m} size="md" />
                          <span className="truncate text-[15px] font-semibold text-slate-900 dark:text-slate-100">
                            {m.display_name}
                          </span>
                          {m.user_id === profile?.user_id ? (
                            <span className="shrink-0 text-[11px] text-slate-400">You</span>
                          ) : null}
                        </span>
                        <span><RoleBadge role={m.role} /></span>
                        <span className="col-span-2 flex flex-wrap gap-1.5 md:col-span-1">
                          {m.locations.length === 0 ? (
                            <span className="text-xs text-amber-600 dark:text-amber-400">No locations</span>
                          ) : LOCATIONS.filter((l) => m.locations.includes(l)).map((l) => (
                            <span key={l} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
                              {LOCATION_SHORT[l] ?? l}
                            </span>
                          ))}
                        </span>
                        <span className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                            <span className="block h-full bg-emerald-500 dark:bg-emerald-400" style={{ width: `${(pages / NAV_KEYS.length) * 100}%` }} />
                          </span>
                          {pages}/{NAV_KEYS.length}
                        </span>
                        <span className="flex flex-col text-xs">
                          {m.barcode
                            ? <span className="text-emerald-600 dark:text-emerald-400">● Lanyard issued</span>
                            : <span className="text-amber-600 dark:text-amber-400">○ No lanyard</span>}
                          <span className="text-slate-400">
                            {m.hourly_rate !== null ? `$${m.hourly_rate.toFixed(2)}/hr` : "No rate set"}
                          </span>
                        </span>
                        <ChevronRight size={16} className="hidden text-slate-400 md:block" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Frame>

        {/* ----- Side panel ----- */}
        <Frame className="lg:sticky lg:top-4">
          <aside className="bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
            {showAdd ? (
              <AddMemberPanel
                newName={newName} setNewName={setNewName}
                newEmail={newEmail} setNewEmail={setNewEmail}
                newPassword={newPassword} setNewPassword={setNewPassword}
                newRole={newRole} setNewRole={setNewRole}
                newLocs={newLocs} setNewLocs={setNewLocs}
                inviteBusy={inviteBusy} inviteMsg={inviteMsg}
                onSubmit={() => void submitInvite()}
                onCancel={members.length ? () => setPanelMode("member") : undefined}
              />
            ) : selected ? (
              <MemberPanel
                key={selected.user_id}
                member={selected}
                isSelf={selected.user_id === profile?.user_id}
                busy={busyUserId === selected.user_id}
                tab={tab}
                setTab={setTab}
                onRename={(name) => void updateDisplayName(selected.user_id, name)}
                onRole={(role) => void updateRole(selected.user_id, role)}
                onToggleLocation={(loc, on) => void toggleLocation(selected.user_id, loc, on)}
                onSetNav={(next) => void updateAllowedNav(selected.user_id, next)}
                onIssueBarcode={() => void issueBarcode(selected)}
                onPrint={() => printBarcode(selected)}
                onRate={(rate) => void updateRate(selected, rate)}
                onRemove={() => void removeMember(selected.user_id, selected.display_name)}
              />
            ) : null}
          </aside>
        </Frame>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

/** Hairline frame with small square markers on each corner. */
function Frame({ className, children }: { className?: string; children: ReactNode }) {
  const corner = "pointer-events-none absolute z-10 h-2 w-2 border border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-950";
  return (
    <div className={cn("relative", className)}>
      <span aria-hidden className={cn(corner, "-left-1 -top-1")} />
      <span aria-hidden className={cn(corner, "-right-1 -top-1")} />
      <span aria-hidden className={cn(corner, "-bottom-1 -left-1")} />
      <span aria-hidden className={cn(corner, "-bottom-1 -right-1")} />
      {children}
    </div>
  );
}

function Avatar({ member, size }: { member: MemberRow; size: "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-semibold tracking-wide",
        ROLE_STYLE[member.role].avatar,
        size === "lg" ? "h-14 w-14 text-lg" : "h-10 w-10 text-sm",
      )}
    >
      {initials(member.display_name)}
    </span>
  );
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1", ROLE_STYLE[role].badge)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", ROLE_STYLE[role].dot)} />
      {ROLE_LABELS[role]}
    </span>
  );
}

/** Large checkbox-style toggle used for pages and locations. */
function ToggleChip({
  checked, locked, onChange, children, title,
}: {
  checked: boolean;
  locked?: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={locked || undefined}
      title={title}
      onClick={() => { if (!locked) onChange(!checked); }}
      className={cn(
        "flex items-center gap-2.5 rounded px-3 py-2.5 text-left text-sm ring-1 transition-colors",
        checked
          ? "bg-emerald-50 text-emerald-900 ring-emerald-400 dark:bg-emerald-400/10 dark:text-slate-100 dark:ring-emerald-400/50"
          : "bg-slate-50 text-slate-500 ring-slate-200 hover:ring-slate-300 dark:bg-slate-800/40 dark:text-slate-400 dark:ring-slate-700 dark:hover:ring-slate-600",
        locked ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <span
        className={cn(
          "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[3px] border-[1.5px]",
          checked
            ? "border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-slate-900"
            : "border-slate-300 dark:border-slate-600",
        )}
      >
        {checked ? <Check size={12} strokeWidth={3} /> : null}
      </span>
      <span className="flex-1 truncate">{children}</span>
      {locked ? <Lock size={12} className="shrink-0" /> : null}
    </button>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      {hint ? <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
    </div>
  );
}

function MemberPanel({
  member, isSelf, busy, tab, setTab,
  onRename, onRole, onToggleLocation, onSetNav, onIssueBarcode, onPrint, onRate, onRemove,
}: {
  member: MemberRow;
  isSelf: boolean;
  busy: boolean;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  onRename: (name: string) => void;
  onRole: (role: Role) => void;
  onToggleLocation: (loc: string, on: boolean) => void;
  onSetNav: (next: string[] | null) => void;
  onIssueBarcode: () => void;
  onPrint: () => void;
  onRate: (rate: number | null) => void;
  onRemove: () => void;
}) {
  const eff = effectiveFor(member);
  const tabs: Array<{ key: PanelTab; label: string; count?: number }> = [
    { key: "access", label: "Access", count: eff.size },
    { key: "locations", label: "Locations", count: member.locations.length },
    { key: "production", label: "Production" },
  ];

  const togglePage = (key: NavKey, on: boolean) => {
    const next = new Set<string>(eff);
    if (on) next.add(key);
    else next.delete(key);
    next.add("dashboard"); // always on
    onSetNav(Array.from(next));
  };

  return (
    <div className={cn(busy ? "opacity-70" : "")}>
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-slate-200 p-6 dark:border-slate-800">
        <Avatar member={member} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <input
            defaultValue={member.display_name}
            aria-label="Display name"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== member.display_name) onRename(v);
              else e.target.value = member.display_name;
            }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            className="-ml-2 h-9 w-full rounded-md bg-transparent px-2 text-lg font-semibold text-slate-900 outline-none ring-1 ring-transparent transition hover:bg-slate-50 focus:bg-slate-50 focus:ring-emerald-400 dark:text-slate-100 dark:hover:bg-slate-800/60 dark:focus:bg-slate-800/60"
          />
          <RoleBadge role={member.role} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 px-4 dark:border-slate-800" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-3 text-sm font-medium transition-colors",
              tab === t.key
                ? "border-emerald-500 text-slate-900 dark:border-emerald-400 dark:text-slate-100"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200",
            )}
          >
            {t.label}
            {t.count !== undefined ? (
              <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700">
                {t.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex max-h-[calc(100vh-260px)] flex-col gap-6 overflow-auto p-6">
        {tab === "access" ? (
          <>
            <div>
              <SectionTitle title="Role" hint={ROLE_DESCRIPTIONS[member.role]} />
              <Select
                value={member.role}
                disabled={isSelf}
                onChange={(e) => onRole(e.target.value as Role)}
                title={isSelf ? "You can't change your own role here." : undefined}
                className="h-10 w-full"
              >
                {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </Select>
            </div>
            <div>
              <SectionTitle
                title="Page access"
                hint={<>
                  {member.allowed_nav === null
                    ? <>Using <strong>{ROLE_LABELS[member.role]}</strong> role defaults.</>
                    : "Custom selection."}{" "}
                  Pages show in the sidebar and can be opened by URL.
                </>}
              />
              <div className="mb-4 flex flex-wrap gap-2">
                <MiniButton onClick={() => onSetNav([...NAV_KEYS])}>Select all</MiniButton>
                <MiniButton onClick={() => onSetNav(["dashboard"])}>Clear</MiniButton>
                <MiniButton onClick={() => onSetNav(null)} disabled={member.allowed_nav === null}>
                  Reset to role default
                </MiniButton>
              </div>
              <div className="space-y-4">
                {ALL_NAV_GROUPS.map((g) => (
                  <div key={g.label}>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      {g.label}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {g.keys.map((key) => {
                        const locked = key === "dashboard";
                        return (
                          <ToggleChip
                            key={key}
                            checked={eff.has(key)}
                            locked={locked}
                            title={locked ? "Dashboard is always available" : undefined}
                            onChange={(on) => togglePage(key, on)}
                          >
                            {DEFAULT_NAV_LABELS[key]}
                          </ToggleChip>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {tab === "locations" ? (
          <div>
            <SectionTitle title="Locations" hint="Which locations this member can switch to." />
            <div className="grid gap-2">
              {LOCATIONS.map((loc) => (
                <ToggleChip
                  key={loc}
                  checked={member.locations.includes(loc)}
                  onChange={(on) => onToggleLocation(loc, on)}
                >
                  {LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}
                </ToggleChip>
              ))}
            </div>
          </div>
        ) : null}

        {tab === "production" ? (
          <>
            <div>
              <SectionTitle title="Lanyard barcode" hint="Scanned at stations to log production work." />
              {member.barcode ? (
                <div className="flex flex-wrap items-center gap-4 rounded bg-slate-50 p-4 ring-1 ring-slate-200 dark:bg-slate-800/40 dark:ring-slate-700">
                  <code className="font-mono text-base tracking-[0.15em] text-slate-900 dark:text-slate-100">
                    {member.barcode}
                  </code>
                  <div className="flex gap-2">
                    <MiniButton onClick={onPrint} title="Open a print window with this user's lanyard card">
                      <Printer size={12} /> Print lanyard
                    </MiniButton>
                    <MiniButton onClick={onIssueBarcode} disabled={busy} title="Generate a new barcode — invalidates the old lanyard">
                      <RefreshCw size={12} /> Regenerate
                    </MiniButton>
                  </div>
                </div>
              ) : (
                <div className="rounded border-[1.5px] border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  No lanyard yet
                  <div className="mt-3">
                    <Button
                      size="sm"
                      onClick={onIssueBarcode}
                      disabled={busy || member.locations.length === 0}
                      title={member.locations.length === 0 ? "Grant a location first" : "Generate a new barcode token"}
                      className="rounded-full px-4"
                    >
                      Issue lanyard barcode
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div>
              <SectionTitle title="Hourly rate" hint="Used for labour cost in production reports." />
              <label className="flex h-10 w-44 items-center rounded-md bg-white pl-3 ring-1 ring-slate-300 focus-within:ring-emerald-400 dark:bg-slate-900 dark:ring-slate-700">
                <span className="text-sm text-slate-400">$</span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  defaultValue={member.hourly_rate ?? ""}
                  placeholder="0.00"
                  aria-label="Hourly rate"
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v === "") {
                      if (member.hourly_rate !== null) onRate(null);
                      return;
                    }
                    const n = Number(v);
                    if (!Number.isFinite(n) || n < 0) return;
                    if (n !== member.hourly_rate) onRate(n);
                  }}
                  className="h-full w-full bg-transparent px-1.5 text-sm outline-none"
                />
                <span className="pr-3 text-sm text-slate-400">/hr</span>
              </label>
            </div>
          </>
        ) : null}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-6 py-4 dark:border-slate-800">
        {isSelf ? (
          <span className="text-xs text-slate-400">You can't remove yourself</span>
        ) : (
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium text-red-600 ring-1 ring-red-200 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:ring-red-900/50 dark:hover:bg-red-900/20"
          >
            <Trash2 size={13} /> Remove member
          </button>
        )}
        <span className="text-xs text-slate-400">{busy ? "Saving…" : "Changes save automatically"}</span>
      </div>
    </div>
  );
}

function MiniButton({
  children, onClick, disabled, title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-slate-600 ring-1 ring-slate-200 transition-colors hover:text-slate-900 hover:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-300 dark:ring-slate-700 dark:hover:text-slate-100 dark:hover:ring-slate-500"
    >
      {children}
    </button>
  );
}

function AddMemberPanel({
  newName, setNewName, newEmail, setNewEmail, newPassword, setNewPassword,
  newRole, setNewRole, newLocs, setNewLocs,
  inviteBusy, inviteMsg, onSubmit, onCancel,
}: {
  newName: string; setNewName: (v: string) => void;
  newEmail: string; setNewEmail: (v: string) => void;
  newPassword: string; setNewPassword: (v: string) => void;
  newRole: Role; setNewRole: (v: Role) => void;
  newLocs: Set<string>; setNewLocs: (fn: (prev: Set<string>) => Set<string>) => void;
  inviteBusy: boolean;
  inviteMsg: string | null;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
      autoComplete="off"
    >
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 p-6 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300">
            <UserPlus size={22} />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Add a new member</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">Creates their login. Give them the email and password.</p>
          </div>
        </div>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" aria-label="Close">
            <X size={18} />
          </button>
        ) : null}
      </div>
      <div className="space-y-5 p-6">
        <Field label="Name">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Email" hint="What they type to sign in.">
          <Input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="jane@inkaarthouse.com"
            autoComplete="off"
          />
        </Field>
        <div>
          <div className="mb-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">Password</div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={showPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <MiniButton
              onClick={() => { setNewPassword(generatePassword()); setShowPassword(true); }}
              title="Fill in a random, easy-to-read password"
            >
              <Wand2 size={12} /> Generate
            </MiniButton>
          </div>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            Pass this on to them yourself. They can change it later with "Forgot your password?".
          </p>
        </div>
        <Field label="Role" hint={ROLE_DESCRIPTIONS[newRole]}>
          <Select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
            {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </Select>
        </Field>
        <div>
          <div className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">Locations they can access</div>
          <div className="grid grid-cols-2 gap-2">
            {LOCATIONS.map((loc) => (
              <ToggleChip
                key={loc}
                checked={newLocs.has(loc)}
                onChange={(on) => setNewLocs((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(loc);
                  else next.delete(loc);
                  return next;
                })}
              >
                {LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}
              </ToggleChip>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-6 py-4 dark:border-slate-800">
        <Button type="submit" disabled={inviteBusy} className="rounded-full px-5">
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
    </form>
  );
}

/** 12-character password without look-alike characters (no 0/O, 1/l/I). */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
