import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/repository/supabase/client";

/**
 * Authentication context for Supabase-backed mode. In Dexie mode the app
 * never mounts this provider — there's no concept of "logged in" locally.
 *
 * Holds the current session + user profile (display name + role). Listens
 * to Supabase auth state changes so the UI updates instantly on login /
 * logout / token refresh.
 */

export interface UserProfile {
  user_id: string;
  display_name: string;
  role: "owner" | "manager" | "staff" | "kiosk" | "cs";
  /**
   * Sidebar pages this user can access (NavKey strings). NULL = use role
   * defaults (owner/manager all, staff dashboard only). Set this per-user
   * via the Team Members card in Settings.
   */
  allowed_nav: string[] | null;
}

interface AuthCtx {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  locations: string[]; // location keys the user can access
  loading: boolean;
  error: string | null;
  /** True while the user is in the middle of a password-reset flow. */
  passwordRecovery: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Request a password reset email be sent to this address. */
  requestPasswordReset: (email: string) => Promise<void>;
  /** Set a new password during recovery mode. Resolves once the update lands. */
  setNewPassword: (password: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [locations, setLocations] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  // On mount: hydrate the existing session (if any) and subscribe to changes.
  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (!mounted) return;
      setSession(s);
      // Supabase fires PASSWORD_RECOVERY when the user lands here via a
      // reset link in an email. Hold the flag until the user actually
      // submits a new password.
      if (event === "PASSWORD_RECOVERY") {
        setPasswordRecovery(true);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  // Whenever the session changes, refetch the user's profile + locations.
  useEffect(() => {
    if (!session) {
      setProfile(null);
      setLocations([]);
      return;
    }
    let cancelled = false;

    (async () => {
      const [profileRes, locRes] = await Promise.all([
        // Pull only the fields we use rather than `*` so future profile-
        // table additions can't accidentally leak through the JWT bundle.
        supabase
          .from("profiles")
          .select("user_id, display_name, role, allowed_nav")
          .eq("user_id", session.user.id)
          .maybeSingle(),
        supabase.from("user_locations").select("location").eq("user_id", session.user.id),
      ]);

      if (cancelled) return;

      if (profileRes.error) {
        setError(`Profile load failed: ${profileRes.error.message}`);
        return;
      }
      if (locRes.error) {
        setError(`Locations load failed: ${locRes.error.message}`);
        return;
      }
      if (!profileRes.data) {
        setError(
          "Your auth user exists but has no app profile yet. Ask the owner to create one " +
          "in Supabase → profiles table (or via SQL: INSERT INTO profiles (user_id, display_name, role) VALUES (...))",
        );
        return;
      }
      setProfile(profileRes.data as UserProfile);
      setLocations((locRes.data ?? []).map((r) => r.location as string));
      setError(null);
    })();

    return () => { cancelled = true; };
  }, [session, supabase]);

  const signIn = async (email: string, password: string) => {
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      throw error;
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setLocations([]);
  };

  const requestPasswordReset = async (email: string) => {
    setError(null);
    // Redirect target after the user clicks the link in their email.
    // Lands on the same site, which is registered in the Supabase
    // Redirect URLs allow-list. PASSWORD_RECOVERY then fires here.
    const redirectTo = window.location.origin + "/";
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      setError(error.message);
      throw error;
    }
  };

  const setNewPassword = async (password: string) => {
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      throw error;
    }
    setPasswordRecovery(false);
  };

  return (
    <Ctx.Provider value={{
      session,
      user: session?.user ?? null,
      profile,
      locations,
      loading,
      error,
      passwordRecovery,
      signIn,
      signOut,
      requestPasswordReset,
      setNewPassword,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/**
 * Non-throwing variant. Returns `null` when no AuthProvider is in the tree
 * (i.e. Dexie mode). Use this from components that render in both Dexie
 * and Supabase modes — the Sidebar is the canonical example.
 */
export function useAuthOptional(): AuthCtx | null {
  return useContext(Ctx);
}
