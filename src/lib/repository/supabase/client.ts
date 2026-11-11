import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Single-instance Supabase client. Reads the URL + anon key from env at
 * build time (Vite inlines `VITE_*` env vars). The client handles auth
 * sessions, real-time channels, and the PostgREST query builder.
 *
 * The client is lazy — calling `getSupabase()` only constructs it on first
 * use, so Dexie-mode apps that never touch Supabase won't pay the cost.
 *
 * Throws with a helpful message when env vars are missing, so the failure
 * mode is "obvious config error" rather than "mysterious network error".
 */
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase mode is on (VITE_BACKEND=supabase) but VITE_SUPABASE_URL or " +
      "VITE_SUPABASE_ANON_KEY are missing. Copy .env.example to .env.local and " +
      "fill in your project's URL + anon key from Supabase → Project Settings → API.",
    );
  }

  // Tab-isolated session is now the DEFAULT. Each tab uses
  // sessionStorage so accounts do not leak across tabs:
  //   - Tab A signs in as Max -> only Tab A has Maxs session
  //   - Tab B can independently sign in as Ellis or stay signed out
  //   - Closing the tab clears the session for that tab
  //
  // Kiosk tablets that want the old shared/persistent behaviour
  // bookmark "/?persist=1". The marker is sticky in sessionStorage
  // so SPA navigation keeps using localStorage.
  //
  // Backward compat: ?tabSession=1 still forces sessionStorage too.
  let usePersistent = false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has("persist")) {
      window.sessionStorage.setItem("inka-persist-session", "1");
    }
    if (params.has("tabSession")) {
      // Explicit opt-in to isolation - clear any persist marker.
      window.sessionStorage.removeItem("inka-persist-session");
    }
    usePersistent = window.sessionStorage.getItem("inka-persist-session") === "1";
  } catch {
    usePersistent = false;
  }
  const storage = usePersistent ? window.localStorage : window.sessionStorage;

  _client = createClient(url, key, {
    auth: {
      storage,
      // Per-project storageKey so two projects can not collide if you
      // ever run both in one browser. (Default key already includes the
      // project ref; we set it explicitly so it lives where we say.)
      storageKey: usePersistent ? "sb-inka-hub-shared" : "sb-inka-hub-tab",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false, // we're not using OAuth callbacks
    },
  });
  return _client;
}

/**
 * True if THIS tab is running in tab-isolated session mode (sessionStorage
 * backed). After the default flip this is the DEFAULT - so returns true
 * unless the tab was opened with ?persist=1.
 */
export function isTabSessionMode(): boolean {
  try {
    return window.sessionStorage.getItem("inka-persist-session") !== "1";
  } catch {
    return true;
  }
}

/**
 * True if THIS tab is in persistent/shared mode (localStorage backed).
 * Set by visiting with ?persist=1; useful for kiosk tablets that should
 * stay signed in across browser restarts.
 */
export function isPersistentSessionMode(): boolean {
  try {
    return window.sessionStorage.getItem("inka-persist-session") === "1";
  } catch {
    return false;
  }
}

/** Lightweight predicate so callers can decide whether to spin up Supabase. */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  );
}

/** Backend mode — driven by Vite env var, defaults to Dexie. */
export type BackendMode = "dexie" | "supabase";

export function getBackendMode(): BackendMode {
  const v = import.meta.env.VITE_BACKEND;
  return v === "supabase" ? "supabase" : "dexie";
}
