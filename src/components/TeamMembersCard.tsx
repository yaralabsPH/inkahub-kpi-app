import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  UserPlus, Printer, RefreshCw, Search, Lock, X, Eye, EyeOff, Wand2,
  Users, Type, CircleChevronDown, AlignLeft, Barcode, Plus, ChevronDown, ChevronUp,
  ChevronsRight, MoreHorizontal, Info, Mail, MapPin, Coins, ListFilter, Download, Check,
} from "lucide-react";
import { useAuth, type UserProfile } from "@/lib/auth/AuthProvider";
import { getSupabase, getBackendMode } from "@/lib/repository/supabase/client";
import {
  LOCATIONS, LOCATION_LABELS,
  NAV_KEYS, DEFAULT_NAV_LABELS,
  type NavKey,
} from "@/lib/domain";
import { effectiveNavAccess } from "@/lib/auth/permissions";
import {
  ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_ORDER, ROLE_TAG_COLOR,
  type Role,
} from "@/lib/auth/roles";
import { NAV_ICONS, accessGroups } from "@/components/layout/navigation";

const ACCESS_GROUPS = accessGroups();
import { useAppStore } from "@/lib/state/appStore";
import { useToast } from "@/components/ui/Toast";
import { Tag, Avatar as SharedAvatar } from "@/components/ui/Tag";
import { Callout } from "@/components/ui/Callout";
import { printAllTeamLanyards, downloadAllTeamLanyards } from "@/components/team/bulkLanyards";
import { cn } from "@/lib/utils/cn";
import { generateBarcodeToken, printLanyard, renderBarcodeSvg } from "@/lib/utils/lanyard";

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

const LOCATION_SHORT: Record<string, string> = { default: "Default", uk: "UK", us: "US", au: "AU" };

/**
 * Optional one-line subtitle per location on the Locations tab (e.g.
 * "Sydney studio"). Nothing in the database holds this yet.
 * TODO(CJ): fill these in or back them with data; empty = no subtitle.
 */
const LOCATION_SUBTITLES: Partial<Record<string, string>> = {};

type PanelTab = "access" | "locations" | "production";
type ExtraFilter = "none" | "no_lanyard" | "no_rate" | "custom";
const EXTRA_FILTER_LABELS: Record<ExtraFilter, string> = {
  none: "Everyone",
  no_lanyard: "No lanyard",
  no_rate: "No rate set",
  custom: "Custom page access",
};

function effectiveFor(m: MemberRow) {
  return effectiveNavAccess({
    user_id: m.user_id,
    display_name: m.display_name,
    role: m.role,
    allowed_nav: m.allowed_nav,
  });
}

/** True when the member's effective pages differ from their role defaults. */
function isCustomAccess(m: MemberRow): boolean {
  const eff = effectiveFor(m);
  const def = effectiveFor({ ...m, allowed_nav: null });
  if (eff.size !== def.size) return true;
  for (const k of eff) if (!def.has(k)) return true;
  return false;
}

function lockReasonFor(key: NavKey, role: Role): string | undefined {
  return key === "welcome" ? "Welcome is always available"
    : key === "dashboard" && role !== "owner" ? "Dashboard is only available to owners"
      : key === "settings" && role === "owner" ? "Settings is always available to owners" : undefined;
}

const iconBtn = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-hub-muted hover:bg-hub-hover hover:text-hub-text disabled:pointer-events-none disabled:opacity-35";

/** Page header: icon tile, title, description and (for owners) the stats row. */
export function TeamHeader({ stats }: { stats?: Array<[ReactNode, string]> }) {
  return (
    <div>
      <div className="mb-3.5 grid h-[52px] w-[52px] place-items-center rounded-xl border border-hub-line bg-hub-fill text-hub-muted">
        <Users size={26} strokeWidth={1.4} />
      </div>
      <h1 className="text-[34px] font-bold leading-[1.15] tracking-[-0.02em]">Team</h1>
      <p className="mt-1.5 text-[15px] text-hub-muted">
        Manage team members, roles, and lanyard barcodes for this location.
      </p>
      {stats ? (
        <div className="mt-[22px] flex flex-wrap gap-7 pb-1">
          {stats.map(([n, l]) => (
            <div key={l}>
              <div className="text-xl font-semibold tracking-[-0.01em] tabular-nums">{n}</div>
              <div className="text-[12.5px] text-hub-muted">{l}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
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
  // Keep the owner gate outside the component that loads data and uses hooks.
  if (profile?.role !== "owner") return null;
  return <OwnerTeamMembersCard key={profile.user_id} profile={profile} />;
}

function OwnerTeamMembersCard({ profile }: { profile: UserProfile }) {
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [extraFilter, setExtraFilter] = useState<ExtraFilter>("none");
  const searchRef = useRef<HTMLInputElement>(null);
  const location = useAppStore((s) => s.location);
  const selfEmail = useAuth().session?.user?.email ?? null;
  const { toast, toastNode } = useToast();

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
    if (userId === profile.user_id) return;
    setBusyUserId(userId);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ role })
        .eq("user_id", userId);
      if (error) throw error;
      setMembers((prev) => prev.map((m) => m.user_id === userId ? { ...m, role } : m));
      toast(`Role changed to ${ROLE_LABELS[role]}`);
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
      `This blocks their login, turns off their lanyard barcode, and removes their location access and profile. ` +
      `They won't be able to sign in or see any data.\n\n` +
      `Their past production records are kept for reports.`,
    )) return;
    setBusyUserId(userId);
    try {
      // The `remove-member` Edge Function blocks the login (Auth admin API)
      // and then, as us under RLS, revokes barcodes, location grants and the
      // profile. History is kept. Every step is safe to retry.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("your session has expired. Sign in again.");
      const { error } = await supabase.functions.invoke<{ user_id?: string; error?: string }>(
        "remove-member",
        { headers: { Authorization: `Bearer ${token}` }, body: { user_id: userId } },
      );
      if (error) {
        const ctx = (error as { context?: Response }).context;
        let detail: string | undefined;
        if (ctx && typeof ctx.json === "function") {
          if (ctx.status === 404) {
            detail = "the remove-member function isn't deployed to this Supabase project yet.";
          } else {
            const b = (await ctx.json().catch(() => null)) as { error?: string } | null;
            detail = b?.error;
          }
        } else {
          detail = "couldn't reach the server. Some steps may have run; it's safe to try again.";
        }
        throw new Error(detail ?? error.message);
      }
      setMembers((prev) => prev.filter((m) => m.user_id !== userId));
      setSelectedId(null);
      setPanelOpen(false);
      toast(`${name} removed`);
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
      toast(member.barcode ? "New lanyard issued" : "Lanyard issued");
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
    if (inviteBusy) return;
    setInviteMsg(null);
    setGlobalError(null);
    const name = newName.trim();
    const email = newEmail.trim().toLowerCase();
    if (!name) { setInviteMsg("Invite failed: enter a display name."); return; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { setInviteMsg("Invite failed: enter a valid email address."); return; }
    if (newPassword.length < 8) { setInviteMsg("Invite failed: password must be at least 8 characters."); return; }
    if (new TextEncoder().encode(newPassword).length > 72) { setInviteMsg("Invite failed: password must be 72 UTF-8 bytes or fewer."); return; }
    if (newLocs.size === 0) { setInviteMsg("Invite failed: tick at least one location."); return; }
    setInviteBusy(true);
    try {
      // The `add-member` Supabase Edge Function creates the login (with the
      // service-role key Supabase gives it), the profile and the location
      // grants in one go, after checking we're an owner.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("your session has expired. Sign in again.");
      const { data, error } = await supabase.functions.invoke<{ user_id?: string; error?: string }>(
        "add-member",
        {
          headers: { Authorization: `Bearer ${token}` },
          body: {
            email,
            password: newPassword,
            display_name: name,
            role: newRole,
            locations: Array.from(newLocs),
          },
        },
      );
      if (error) {
        // Non-2xx responses carry the function's JSON error in `context`.
        const ctx = (error as { context?: Response }).context;
        let detail: string | undefined;
        if (ctx && typeof ctx.json === "function") {
          if (ctx.status === 404) {
            detail = "the add-member function isn't deployed to this Supabase project yet.";
          } else {
            const b = (await ctx.json().catch(() => null)) as { error?: string } | null;
            detail = b?.error;
          }
        }
        throw new Error(detail ?? "Could not confirm whether the member was added. Ask CJ to check the account before retrying.");
      }
      const body = data ?? {};
      if (!body.user_id) throw new Error(body.error ?? "no user id returned.");

      setAddedNotice(`Added ${name} as ${ROLE_LABELS[newRole]}. They sign in with ${email} and the password you set.`);
      setNewName("");
      setNewEmail("");
      setNewPassword("");
      setNewRole("manager");
      setNewLocs(new Set([LOCATIONS[0]]));
      await loadMembers();
      setSelectedId(body.user_id);
      setPanelMode("member");
      toast("Member added");
    } catch (e) {
      setInviteMsg(`Invite failed: ${(e as Error).message}`);
    } finally {
      setInviteBusy(false);
    }
  };

  const busyAny = inviteBusy || busyUserId !== null;
  const q = query.trim().toLowerCase();
  const visible = members.filter((m) =>
    (roleFilter === "all" || m.role === roleFilter)
    && `${m.display_name} ${ROLE_LABELS[m.role]}`.toLowerCase().includes(q)
    && (extraFilter === "none"
      || (extraFilter === "no_lanyard" && !m.barcode)
      || (extraFilter === "no_rate" && m.hourly_rate === null)
      || (extraFilter === "custom" && isCustomAccess(m))),
  );
  const selected = members.find((m) => m.user_id === selectedId) ?? null;
  const showAdd = panelMode === "add";
  const peekOpen = panelOpen && (showAdd || selected !== null);

  const selectMember = (userId: string) => {
    setSelectedId(userId);
    setPanelMode("member");
    setPanelOpen(true);
  };
  const openAdd = () => {
    setPanelMode("add");
    setInviteMsg(null);
    setPanelOpen(true);
  };
  const closePanel = () => setPanelOpen(false);
  const step = (d: 1 | -1) => {
    if (visible.length === 0) return;
    const i = visible.findIndex((m) => m.user_id === selectedId);
    const next = i < 0 ? visible[0] : visible[(i + d + visible.length) % visible.length];
    selectMember(next.user_id);
  };

  const runBulk = async (kind: "print" | "download") => {
    toast(kind === "print" ? "Preparing lanyards…" : "Generating lanyard images…");
    toast(kind === "print" ? await printAllTeamLanyards(location) : await downloadAllTeamLanyards(location));
  };

  // Keyboard: Esc closes the panel, ↑/↓ move between members while it is
  // open (not while typing), Ctrl/Cmd+K focuses search on this page.
  // A ref keeps the window listener stable across renders.
  const keyState = useRef({ peekOpen, showAdd, step, closePanel });
  keyState.current = { peekOpen, showAdd, step, closePanel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = keyState.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        // Capture phase + stopPropagation so the global command palette
        // doesn't also open while the Team page is showing.
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        return;
      }
      if (!s.peekOpen) return;
      if (e.key === "Escape") {
        s.closePanel();
        return;
      }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !s.showAdd) {
        const t = e.target as HTMLElement | null;
        if (t?.closest("input, select, textarea, [contenteditable='true']")) return;
        e.preventDefault();
        s.step(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const issued = members.filter((m) => m.barcode).length;
  const stats: Array<[ReactNode, string]> = [
    [members.length, "Members"],
    [`${issued} / ${members.length}`, "Lanyards issued"],
    [new Set(members.flatMap((m) => m.locations)).size, "Locations"],
    [members.filter((m) => m.hourly_rate === null).length, "Missing rates"],
  ];

  return (
    <section>
      <TeamHeader stats={loading ? undefined : stats} />

      {globalError ? (
        <div role="alert" className="mt-5 flex items-start justify-between gap-3 rounded-md bg-hub-fill px-3.5 py-2.5 text-[13.5px] text-hub-bad">
          <span>{globalError}</span>
          <button type="button" onClick={() => setGlobalError(null)} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {addedNotice ? (
        <div role="status" className="mt-5 flex items-start justify-between gap-3 rounded-md bg-hub-fill px-3.5 py-2.5 text-[13.5px] text-hub-muted">
          <span className="flex items-start gap-2.5">
            <Info size={16} strokeWidth={1.6} className="mt-0.5 shrink-0" />
            <span>{addedNotice}</span>
          </span>
          <button type="button" onClick={() => setAddedNotice(null)} className="shrink-0 opacity-70 hover:opacity-100" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* ----- View tabs + toolbar ----- */}
      <div className="mt-7 flex flex-wrap items-end gap-x-2 border-b border-hub-line">
        <div className="flex flex-wrap gap-0.5" role="group" aria-label="Filter by role">
          {(["all", ...ROLE_ORDER] as const).map((r) => {
            const on = roleFilter === r;
            const count = r === "all" ? members.length : members.filter((m) => m.role === r).length;
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter(r)}
                aria-pressed={on}
                className={cn(
                  "relative flex items-center gap-1.5 rounded-t-md px-2 pb-[9px] pt-1.5 text-[13.5px] font-medium transition-colors",
                  on ? "text-hub-text" : "text-hub-muted hover:text-hub-text",
                )}
              >
                {r === "all" ? "All members" : ROLE_LABELS[r]}
                <span className="text-xs text-hub-faint">{count}</span>
                {on ? <span aria-hidden className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-sm bg-hub-text" /> : null}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1 pb-1.5">
          <label
            className={cn(
              "flex h-7 w-7 cursor-text items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-hub-muted transition-[width] duration-200 focus-within:w-[220px] focus-within:bg-hub-hover",
              query ? "w-[220px] bg-hub-hover" : "",
            )}
            title="Search (Ctrl+K)"
          >
            <Search size={16} strokeWidth={1.6} className="shrink-0" />
            <input
              ref={searchRef}
              aria-label="Search members by name or role"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
              placeholder="Search by name or role…"
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-hub-text outline-none placeholder:text-hub-faint"
            />
          </label>
          <Popover
            label="Filter"
            buttonClassName={cn(iconBtn, extraFilter !== "none" && "bg-hub-accent-bg text-hub-accent-text hover:text-hub-accent-text")}
            button={<ListFilter size={16} strokeWidth={1.6} />}
          >
            {(close) => (Object.keys(EXTRA_FILTER_LABELS) as ExtraFilter[]).map((f) => (
              <MenuItem key={f} onClick={() => { setExtraFilter(f); close(); }}>
                <span className="w-4">{extraFilter === f ? <Check size={14} /> : null}</span>
                {EXTRA_FILTER_LABELS[f]}
              </MenuItem>
            ))}
          </Popover>
          <div className="ml-1.5 flex h-7 items-stretch overflow-hidden rounded-md bg-hub-accent text-[13.5px] font-semibold text-[#0d2b1d]">
            <button
              type="button"
              disabled={busyAny}
              onClick={openAdd}
              className="flex items-center gap-1.5 px-2.5 hover:bg-black/10 disabled:opacity-60"
            >
              <Plus size={14} strokeWidth={2} /> Add member
            </button>
            <span aria-hidden className="w-px bg-white/25" />
            <Popover
              label="More team actions"
              align="right"
              buttonClassName="flex h-full items-center px-1.5 hover:bg-black/10"
              button={<ChevronDown size={14} strokeWidth={2} />}
            >
              {(close) => (
                <>
                  <MenuItem onClick={() => { close(); void runBulk("print"); }}>
                    <Printer size={14} strokeWidth={1.6} /> Print all team lanyards (PDF)
                  </MenuItem>
                  <MenuItem onClick={() => { close(); void runBulk("download"); }}>
                    <Download size={14} strokeWidth={1.6} /> Download all as JPEGs (zip)
                  </MenuItem>
                </>
              )}
            </Popover>
          </div>
        </div>
      </div>

      {/* ----- Members table ----- */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr>
              {([
                [Type, "Member", "w-[34%]"],
                [CircleChevronDown, "Role", ""],
                [AlignLeft, "Locations", ""],
                [Lock, "Page access", ""],
                [Barcode, "Production", ""],
              ] as const).map(([Icon, label, w]) => (
                <th key={label} className={cn("whitespace-nowrap border-b border-hub-line px-2.5 py-2 text-left text-[13px] font-medium text-hub-muted", w)}>
                  <span className="flex items-center gap-1.5">
                    <Icon size={14} strokeWidth={1.6} className="text-hub-faint" />{label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="p-10 text-center text-hub-faint">Loading team…</td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={5} className="p-10 text-center text-hub-faint">No members yet.</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={5} className="p-10 text-center text-hub-faint">No members match{q ? ` “${query.trim()}”` : ""}.</td></tr>
            ) : visible.map((m) => {
              const isSel = peekOpen && !showAdd && selected?.user_id === m.user_id;
              const pages = effectiveFor(m).size;
              const full = pages === NAV_KEYS.length;
              const self = m.user_id === profile.user_id;
              return (
                <tr
                  key={m.user_id}
                  onClick={() => { if (!busyAny) selectMember(m.user_id); }}
                  className={cn(
                    "group cursor-pointer transition-colors duration-100",
                    isSel ? "bg-hub-accent-bg" : "hover:bg-hub-hover",
                    busyUserId === m.user_id ? "opacity-60" : "",
                  )}
                >
                  <td className="border-b border-hub-line px-2.5 py-[9px] align-middle">
                    <div className="flex items-center gap-2.5">
                      <Avatar member={m} size={28} />
                      <button
                        type="button"
                        disabled={busyAny}
                        onClick={(e) => { e.stopPropagation(); selectMember(m.user_id); }}
                        aria-current={isSel ? "true" : undefined}
                        aria-label={`Open ${m.display_name}`}
                        className="min-w-0 truncate text-left font-medium text-hub-text outline-none focus-visible:underline"
                      >
                        {m.display_name}
                      </button>
                      {self ? <span className="ml-0.5 text-[11.5px] text-hub-faint">You</span> : null}
                      <span
                        aria-hidden
                        className="ml-auto rounded-[5px] bg-hub-panel px-[7px] py-0.5 text-[11.5px] font-semibold tracking-[0.03em] text-hub-muted opacity-0 shadow-[0_0_0_1px_rgb(var(--hub-line-2))] transition-opacity group-hover:opacity-100"
                      >
                        OPEN
                      </span>
                    </div>
                  </td>
                  <td className="border-b border-hub-line px-2.5 py-[9px]">
                    <Tag color={ROLE_TAG_COLOR[m.role]}>{ROLE_LABELS[m.role]}</Tag>
                  </td>
                  <td className="border-b border-hub-line px-2.5 py-[9px]">
                    <LocationTags locations={m.locations} />
                  </td>
                  <td className="border-b border-hub-line px-2.5 py-[9px]">
                    <div className="flex items-center gap-2.5 whitespace-nowrap text-[13px] tabular-nums text-hub-muted">
                      <span className="h-1 w-16 overflow-hidden rounded bg-hub-line-2">
                        <span
                          className={cn("block h-full rounded", full ? "bg-hub-accent-text" : "bg-hub-muted")}
                          style={{ width: `${(pages / NAV_KEYS.length) * 100}%` }}
                        />
                      </span>
                      {pages}/{NAV_KEYS.length}
                      {isCustomAccess(m) ? <span className="text-xs text-hub-faint">· custom</span> : null}
                    </div>
                  </td>
                  <td className="border-b border-hub-line px-2.5 py-[9px] text-[13px] leading-[1.35]">
                    <StatusDot ok={!!m.barcode}>{m.barcode ? "Lanyard issued" : "No lanyard"}</StatusDot>
                    <div className="pl-3 text-[12.5px] text-hub-faint">
                      {m.hourly_rate !== null ? `$${m.hourly_rate.toFixed(2)}/hr` : "No rate set"}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading ? (
              <tr>
                <td colSpan={5} className="p-0">
                  <button
                    type="button"
                    disabled={busyAny}
                    onClick={openAdd}
                    className="flex w-full items-center gap-2 px-2.5 py-[9px] text-left text-hub-faint hover:bg-hub-hover hover:text-hub-muted disabled:opacity-50"
                  >
                    <Plus size={16} strokeWidth={1.6} /> New member
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* ----- Side peek ----- */}
      <section
        aria-label={showAdd ? "Add member" : selected ? `${selected.display_name} details` : "Member details"}
        aria-hidden={!peekOpen}
        className="fixed inset-y-0 right-0 z-30 flex w-full flex-col bg-hub-panel text-hub-text shadow-hub-pop md:w-[min(520px,46vw)]"
        style={{
          transform: peekOpen ? "none" : "translateX(102%)",
          visibility: peekOpen ? "visible" : "hidden",
          transition: "transform 260ms cubic-bezier(.2,.8,.2,1), visibility 260ms",
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 px-2.5">
          <button type="button" className={iconBtn} onClick={closePanel} aria-label="Close panel" title="Close">
            <ChevronsRight size={16} strokeWidth={1.6} />
          </button>
          {!showAdd ? (
            <>
              <button type="button" className={iconBtn} onClick={() => step(-1)} disabled={busyAny || visible.length < 2} aria-label="Previous member" title="Previous">
                <ChevronUp size={16} strokeWidth={1.6} />
              </button>
              <button type="button" className={iconBtn} onClick={() => step(1)} disabled={busyAny || visible.length < 2} aria-label="Next member" title="Next">
                <ChevronDown size={16} strokeWidth={1.6} />
              </button>
            </>
          ) : null}
          <span className="flex-1" />
          <span className="mr-1.5 text-xs text-hub-faint">Esc to close</span>
          {!showAdd && selected ? (
            <Popover label="More" align="right" buttonClassName={iconBtn} button={<MoreHorizontal size={16} strokeWidth={1.6} />}>
              {(close) => (
                <>
                  <MenuItem disabled={!selected.barcode} onClick={() => { close(); printBarcode(selected); }}>
                    <Printer size={14} strokeWidth={1.6} /> Print lanyard
                  </MenuItem>
                  <MenuItem
                    disabled={busyAny || selected.locations.length === 0}
                    onClick={() => { close(); void issueBarcode(selected); }}
                  >
                    <RefreshCw size={14} strokeWidth={1.6} /> {selected.barcode ? "Regenerate lanyard" : "Issue lanyard"}
                  </MenuItem>
                </>
              )}
            </Popover>
          ) : null}
        </div>
        {showAdd ? (
          <AddMemberPanel
            newName={newName} setNewName={setNewName}
            newEmail={newEmail} setNewEmail={setNewEmail}
            newPassword={newPassword} setNewPassword={setNewPassword}
            newRole={newRole} setNewRole={setNewRole}
            newLocs={newLocs} setNewLocs={setNewLocs}
            inviteBusy={inviteBusy} inviteMsg={inviteMsg}
            onSubmit={() => void submitInvite()}
            onCancel={closePanel}
          />
        ) : selected ? (
          <MemberPanel
            key={selected.user_id}
            member={selected}
            isSelf={selected.user_id === profile.user_id}
            email={selected.user_id === profile.user_id ? selfEmail : null}
            busy={busyUserId !== null}
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
      </section>

      {toastNode}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

function LocationTags({ locations }: { locations: string[] }) {
  if (locations.length === 0) return <span className="text-[13px] text-hub-warn">No locations</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {LOCATIONS.filter((l) => locations.includes(l)).map((l) => (
        <Tag key={l}>{LOCATION_SHORT[l] ?? l}</Tag>
      ))}
    </div>
  );
}

function StatusDot({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-1.5", ok ? "text-hub-accent-text" : "text-hub-warn")}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </div>
  );
}

function Avatar({ member, size }: { member: MemberRow; size: 28 | 64 }) {
  return <SharedAvatar name={member.display_name} color={ROLE_TAG_COLOR[member.role]} size={size} className={size === 64 ? "text-[22px]" : "text-[11.5px]"} />;
}

/** 28×16 toggle switch visual (the clickable element is its parent row). */
function SwitchVisual({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative ml-auto h-4 w-7 shrink-0 rounded-full transition-colors duration-150",
        on ? "bg-hub-accent" : "bg-hub-line-2",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,.25)] transition-transform duration-150",
          on ? "translate-x-3" : "",
        )}
      />
    </span>
  );
}

/** A full-width row that toggles a setting; rendered as role="switch". */
function SwitchRow({
  checked, locked, disabled, onChange, children, title, className,
}: {
  checked: boolean;
  locked?: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || locked}
      title={title}
      onClick={() => { if (!locked) onChange(!checked); }}
      className={cn(
        "flex w-full select-none items-center gap-2.5 rounded-[5px] px-1.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-hub-accent-text",
        locked ? "cursor-default [&>span:last-child]:opacity-[.45]" : "cursor-pointer hover:bg-hub-hover disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {children}
      <SwitchVisual on={checked} />
    </button>
  );
}

function TextButton({
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
      className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-[3px] text-[13px] text-hub-muted hover:bg-hub-hover hover:text-hub-text disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function OutlineButton({
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
      className="inline-flex items-center gap-1.5 rounded-md px-3 py-[5px] text-[13px] text-hub-text shadow-[0_0_0_1px_rgb(var(--hub-line-2))] hover:bg-hub-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

/** Small click-to-open menu that closes on outside click or Escape. */
function Popover({
  label, button, buttonClassName, align = "right", children,
}: {
  label: string;
  button: ReactNode;
  buttonClassName?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName}
      >
        {button}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute top-8 z-40 min-w-[220px] rounded-lg bg-hub-panel p-1 text-[13.5px] font-normal text-hub-text shadow-hub-pop",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 whitespace-nowrap rounded-[5px] px-2 py-1.5 text-left hover:bg-hub-hover disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function BarcodeGraphic({ token }: { token: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [ok, setOk] = useState(true);
  useEffect(() => {
    if (!ref.current) return;
    let alive = true;
    // currentColor follows the theme without re-rendering the bars.
    void renderBarcodeSvg(ref.current, token, "currentColor").then((r) => { if (alive) setOk(r); });
    return () => { alive = false; };
  }, [token]);
  return <svg ref={ref} aria-hidden className={cn("h-14 max-w-full text-hub-text", ok ? "" : "hidden")} />;
}

const rateInputCls = "h-full w-16 min-w-0 bg-transparent px-1 text-[13.5px] text-hub-text outline-none [appearance:textfield] placeholder:text-hub-faint disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/** Inline hourly-rate editor. Saves on blur, exactly as before. */
function RateInput({ member, busy, onRate }: { member: MemberRow; busy: boolean; onRate: (rate: number | null) => void }) {
  return (
    <span className="flex h-[30px] w-fit items-center rounded-[5px] pl-2 hover:bg-hub-hover focus-within:bg-hub-hover">
      <span className="text-[13.5px] text-hub-faint">$</span>
      <input
        key={member.hourly_rate ?? "none"}
        type="number"
        disabled={busy}
        min={0}
        step={0.01}
        defaultValue={member.hourly_rate ?? ""}
        placeholder="Empty"
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
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        className={rateInputCls}
      />
      <span className="pr-2 text-[13.5px] text-hub-faint">/hr</span>
    </span>
  );
}

function PropKey({ icon: Icon, children }: { icon: typeof Info; children: ReactNode }) {
  return (
    <div className="flex h-[34px] items-center gap-2 text-[13.5px] text-hub-muted">
      <Icon size={15} strokeWidth={1.6} className="text-hub-faint" />{children}
    </div>
  );
}

export function MemberPanel({
  member, isSelf, email, busy, tab, setTab,
  onRename, onRole, onToggleLocation, onSetNav, onIssueBarcode, onPrint, onRate, onRemove,
}: {
  member: MemberRow;
  isSelf: boolean;
  /** Only known for the signed-in user (auth emails aren't readable client-side). */
  email?: string | null;
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
  const custom = isCustomAccess(member);
  const tabId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: Array<{ key: PanelTab; label: string; count?: number }> = [
    { key: "access", label: "Access", count: eff.size },
    { key: "locations", label: "Locations", count: member.locations.length },
    { key: "production", label: "Production" },
  ];

  const togglePage = (key: NavKey, on: boolean) => {
    const next = new Set<string>(eff);
    if (on) next.add(key);
    else next.delete(key);
    onSetNav(Array.from(next));
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", busy ? "opacity-70" : "")}>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-3.5 sm:px-10">
        {/* Header */}
        <div className="mb-3.5"><Avatar member={member} size={64} /></div>
        <input
          key={member.display_name}
          disabled={busy}
          defaultValue={member.display_name}
          aria-label="Display name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== member.display_name) onRename(v);
            else e.target.value = member.display_name;
          }}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          className="-ml-1.5 w-[calc(100%+12px)] rounded-md bg-transparent px-1.5 text-[28px] font-bold leading-[1.2] tracking-[-0.02em] text-hub-text outline-none hover:bg-hub-hover focus:bg-hub-hover"
        />

        {/* Properties */}
        <div className="mt-[18px] grid grid-cols-[140px_minmax(0,1fr)] gap-y-0.5">
          <PropKey icon={CircleChevronDown}>Role</PropKey>
          <div
            className={cn("relative flex min-h-[34px] items-center rounded-[5px] px-2", !(isSelf || busy) && "hover:bg-hub-hover")}
            title={isSelf ? "You can't change your own role here." : ROLE_DESCRIPTIONS[member.role]}
          >
            <Tag color={ROLE_TAG_COLOR[member.role]}>{ROLE_LABELS[member.role]}</Tag>
            <select
              value={member.role}
              aria-label="Role"
              disabled={isSelf || busy}
              onChange={(e) => onRole(e.target.value as Role)}
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
            >
              {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>

          {email ? (
            <>
              <PropKey icon={Mail}>Email</PropKey>
              <div className="flex min-h-[34px] min-w-0 items-center px-2 text-[13.5px]"><span className="truncate">{email}</span></div>
            </>
          ) : null}

          <PropKey icon={MapPin}>Locations</PropKey>
          <div className="flex min-h-[34px] items-center px-2">
            {member.locations.length ? <LocationTags locations={member.locations} /> : <span className="text-[13.5px] text-hub-faint">Empty</span>}
          </div>

          <PropKey icon={Barcode}>Lanyard</PropKey>
          <div className="flex min-h-[34px] items-center px-2 text-[13.5px]">
            {member.barcode ? <span className="text-hub-accent-text">Issued</span> : <span className="text-hub-faint">Not issued</span>}
          </div>

          <PropKey icon={Coins}>Hourly rate</PropKey>
          <div className="flex min-h-[34px] items-center">
            <RateInput member={member} busy={busy} onRate={onRate} />
          </div>
        </div>

        {/* Tabs */}
        <div className="mt-[22px] flex gap-0.5 border-b border-hub-line" role="tablist" aria-label="Member settings">
          {tabs.map((t, index) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${tabId}-${t.key}`}
              aria-controls={`${tabId}-panel`}
              aria-selected={tab === t.key}
              tabIndex={tab === t.key ? 0 : -1}
              ref={(el) => { tabRefs.current[index] = el; }}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => {
                const next = e.key === "ArrowRight" ? (index + 1) % tabs.length
                  : e.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                    : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
                if (next === null) return;
                e.preventDefault();
                setTab(tabs[next].key);
                tabRefs.current[next]?.focus();
              }}
              className={cn(
                "relative flex items-center gap-1.5 px-2 pb-[9px] pt-1.5 text-[13.5px] font-medium transition-colors",
                tab === t.key ? "text-hub-text" : "text-hub-muted hover:text-hub-text",
              )}
            >
              {t.label}
              {t.count !== undefined ? (
                <span className="rounded-[10px] bg-hub-hover px-1.5 text-[11.5px] text-hub-faint">{t.count}</span>
              ) : null}
              {tab === t.key ? <span aria-hidden className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-sm bg-hub-text" /> : null}
            </button>
          ))}
        </div>

        {/* Body */}
        <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0} className="outline-none">
          {tab === "access" ? (
            <>
              <Callout className="mt-[18px] text-[13.5px]">
                <b className="font-semibold text-hub-text">
                  {custom ? "Custom access." : `Using ${ROLE_LABELS[member.role]} defaults.`}
                </b>{" "}
                {ROLE_DESCRIPTIONS[member.role]} Pages show in the sidebar and can be opened by URL.
              </Callout>
              <div className="mt-3.5 flex flex-wrap gap-0.5">
                <TextButton onClick={() => onSetNav(NAV_KEYS.filter((key) => key !== "dashboard" || member.role === "owner"))} disabled={busy}>Select all</TextButton>
                <TextButton onClick={() => onSetNav([])} disabled={busy}>Clear</TextButton>
                <TextButton onClick={() => onSetNav(null)} disabled={busy || member.allowed_nav === null}>
                  Reset to role default
                </TextButton>
              </div>
              {ACCESS_GROUPS.map((g) => (
                <div key={g.label} className="mt-5">
                  <div className="flex items-center justify-between px-1.5 pb-1 text-xs font-medium tracking-[0.01em] text-hub-faint">
                    <span>{g.label}</span>
                    <span className="tabular-nums">{g.keys.filter((k) => eff.has(k)).length}/{g.keys.length}</span>
                  </div>
                  {g.keys.map((key) => {
                    const lockReason = lockReasonFor(key, member.role);
                    const Icon = NAV_ICONS[key];
                    return (
                      <SwitchRow
                        key={key}
                        checked={eff.has(key)}
                        locked={!!lockReason}
                        disabled={busy}
                        title={lockReason}
                        onChange={(on) => togglePage(key, on)}
                      >
                        <Icon size={16} strokeWidth={1.6} className="shrink-0 text-hub-muted" />
                        <span className={lockReason ? "text-hub-muted" : ""}>{DEFAULT_NAV_LABELS[key]}</span>
                        {lockReason ? <Lock size={13} strokeWidth={1.6} className="ml-0.5 shrink-0 text-hub-faint" /> : null}
                      </SwitchRow>
                    );
                  })}
                </div>
              ))}
            </>
          ) : null}

          {tab === "locations" ? (
            <>
              <Callout className="mt-[18px] text-[13.5px]">Members only see stock, orders and reports for the locations they&apos;re assigned to.</Callout>
              <div className="mt-3">
                {LOCATIONS.map((loc) => (
                  <SwitchRow
                    key={loc}
                    checked={member.locations.includes(loc)}
                    disabled={busy}
                    onChange={(on) => onToggleLocation(loc, on)}
                    className="gap-3 rounded-none border-b border-hub-line py-2.5"
                  >
                    <span className="grid h-5 w-7 shrink-0 place-items-center rounded border border-hub-line bg-hub-fill text-[10.5px] font-semibold text-hub-muted">
                      {(LOCATION_SHORT[loc] ?? loc).slice(0, 3).toUpperCase()}
                    </span>
                    <span className="flex-1">
                      {LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}
                      {LOCATION_SUBTITLES[loc] ? <span className="block text-[12.5px] text-hub-faint">{LOCATION_SUBTITLES[loc]}</span> : null}
                    </span>
                  </SwitchRow>
                ))}
              </div>
            </>
          ) : null}

          {tab === "production" ? (
            <>
              <div className="mt-[18px] flex flex-col items-center gap-2.5 rounded-lg border border-hub-line p-[18px]">
                {member.barcode ? (
                  <>
                    <BarcodeGraphic token={member.barcode} />
                    <code className="font-mono text-[12.5px] tracking-[0.12em] text-hub-muted">{member.barcode}</code>
                    <div className="mt-1 flex flex-wrap justify-center gap-2">
                      <OutlineButton onClick={onPrint} title="Open a print window with this user's lanyard card">
                        <Printer size={13} strokeWidth={1.6} /> Print lanyard
                      </OutlineButton>
                      <OutlineButton onClick={onIssueBarcode} disabled={busy} title="Generate a new barcode — invalidates the old lanyard">
                        <RefreshCw size={13} strokeWidth={1.6} /> Regenerate
                      </OutlineButton>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-center text-[13.5px] text-hub-faint">
                      No lanyard issued yet.<br />
                      Issue one so {member.display_name.split(" ")[0]} can scan in on the floor.
                    </div>
                    <OutlineButton
                      onClick={onIssueBarcode}
                      disabled={busy || member.locations.length === 0}
                      title={member.locations.length === 0 ? "Grant a location first" : "Generate a new barcode token"}
                    >
                      Issue lanyard
                    </OutlineButton>
                  </>
                )}
              </div>
              <div className="mt-5">
                <div className="px-1.5 pb-1 text-xs font-medium text-hub-faint">Pay</div>
                <div className="grid grid-cols-[140px_minmax(0,1fr)]">
                  <PropKey icon={Coins}>Hourly rate</PropKey>
                  <div className="flex min-h-[34px] items-center"><RateInput member={member} busy={busy} onRate={onRate} /></div>
                </div>
                <p className="px-1.5 text-[12.5px] text-hub-faint">Used for labour cost in production reports.</p>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Footer */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-hub-line px-6 py-2.5 text-[12.5px] text-hub-faint sm:px-10">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", busy ? "bg-hub-warn" : "bg-hub-accent-text")} />
          {busy ? "Saving…" : "Changes save automatically"}
        </span>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy || isSelf}
          className="rounded-[5px] px-2 py-[3px] text-[12.5px] text-hub-bad hover:bg-[rgba(226,85,79,.1)] disabled:pointer-events-none disabled:text-hub-faint"
        >
          {isSelf ? "You can't remove yourself" : "Remove from team"}
        </button>
      </div>
    </div>
  );
}

const fieldCls = "h-9 w-full rounded-md bg-hub-hover px-2.5 text-[13.5px] text-hub-text outline-none ring-1 ring-transparent placeholder:text-hub-faint focus:ring-hub-accent-text";

function FormField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-hub-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[12.5px] text-hub-faint">{hint}</span> : null}
    </label>
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
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-3.5 sm:px-10">
        <span className="mb-3.5 grid h-16 w-16 place-items-center rounded-full bg-hub-accent-bg text-hub-accent-text">
          <UserPlus size={26} strokeWidth={1.6} />
        </span>
        <h2 className="text-[28px] font-bold leading-[1.2] tracking-[-0.02em]">Add a new member</h2>
        <p className="mt-1 text-[13.5px] text-hub-muted">Creates their login. Give them the email and password.</p>

        <fieldset disabled={inviteBusy} className="mt-6 min-w-0 space-y-5">
          <FormField label="Name">
            <input className={fieldCls} value={newName} maxLength={80} onChange={(e) => setNewName(e.target.value)} placeholder="Jane Smith" />
          </FormField>
          <FormField label="Email" hint="What they type to sign in.">
            <input
              className={fieldCls}
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="jane@inkaarthouse.com"
              autoComplete="off"
            />
          </FormField>
          <div>
            <div className="mb-1.5 text-[13px] font-medium text-hub-muted">Password</div>
            <div className="flex flex-wrap gap-2">
              <div className="relative min-w-0 flex-1 basis-40">
                <input
                  className={cn(fieldCls, "pr-10")}
                  type={showPassword ? "text" : "password"}
                  aria-label="Password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 grid w-10 place-items-center text-hub-faint hover:text-hub-text"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={16} strokeWidth={1.6} /> : <Eye size={16} strokeWidth={1.6} />}
                </button>
              </div>
              <OutlineButton
                onClick={() => { setNewPassword(generatePassword()); setShowPassword(true); }}
                title="Fill in a random, easy-to-read password"
              >
                <Wand2 size={13} strokeWidth={1.6} /> Generate
              </OutlineButton>
            </div>
            <p className="mt-1.5 text-[12.5px] text-hub-faint">
              Pass this on to them yourself. They can change it later with &quot;Forgot your password?&quot;.
            </p>
          </div>
          <FormField label="Role" hint={ROLE_DESCRIPTIONS[newRole]}>
            <select className={cn(fieldCls, "cursor-pointer")} value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
              {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </FormField>
          <div>
            <div className="mb-1 text-[13px] font-medium text-hub-muted">Locations they can access</div>
            {LOCATIONS.map((loc) => (
              <SwitchRow
                key={loc}
                checked={newLocs.has(loc)}
                onChange={(on) => setNewLocs((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(loc);
                  else next.delete(loc);
                  return next;
                })}
              >
                <span>{LOCATION_LABELS[loc as keyof typeof LOCATION_LABELS]}</span>
              </SwitchRow>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-hub-line px-6 py-2.5 sm:px-10">
        <button
          type="submit"
          disabled={inviteBusy}
          className="inline-flex h-7 items-center rounded-md bg-hub-accent px-3 text-[13.5px] font-semibold text-[#0d2b1d] hover:brightness-95 disabled:opacity-60"
        >
          {inviteBusy ? "Adding…" : "Add member"}
        </button>
        {onCancel ? <TextButton onClick={onCancel}>Cancel</TextButton> : null}
        {inviteMsg ? (
          <span role="alert" className={cn("text-[12.5px]", inviteMsg.startsWith("Invite failed") ? "text-hub-bad" : "text-hub-accent-text")}>
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
