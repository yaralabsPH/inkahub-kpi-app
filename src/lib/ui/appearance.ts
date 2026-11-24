import type { Theme } from "@/lib/state/appStore";

/**
 * The theme actually painted. An explicit light/dark choice always wins;
 * "system" follows the operating system preference.
 */
export function resolveTheme(theme: Theme, prefersDark: boolean): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return prefersDark ? "dark" : "light";
}

/**
 * Display-only environment label for the top bar. Reads the public
 * VITE_APP_ENV value; it never selects a backend or project. Production and
 * unknown values in a built app get no label, so an unlabelled deployment is
 * never claimed to be staging. The Vite dev server falls back to Development.
 */
export function environmentLabel(
  appEnv: string | undefined,
  isDev: boolean,
): "Preview" | "Development" | null {
  const v = (appEnv ?? "").trim().toLowerCase();
  if (v === "production") return null;
  if (v === "preview") return "Preview";
  if (v === "development") return "Development";
  return isDev ? "Development" : null;
}
