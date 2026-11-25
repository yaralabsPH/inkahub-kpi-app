import type { UserProfile } from "./AuthProvider";

export type Role = UserProfile["role"];

export const ROLE_ORDER: Role[] = ["owner", "manager", "staff", "kiosk", "cs"];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
  kiosk: "Kiosk",
  cs: "CS",
};

/** Existing copy shown on the Team page. Edit freely. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full access. Only role that can manage users.",
  manager: "Full operational access for their granted locations. Cannot manage users.",
  staff: "Read access for granted locations. Write access is limited to staff-owned modules (returns / production runs — coming soon).",
  kiosk: "Shared station login. Can record production events on behalf of scanned staff and nothing else. Cannot edit stock, sales, or correct events.",
  cs: "Customer Service. Can log returns and create replacement cases on /cs-returns and /cs-cases. No access to stock editing, shipments, or reports.",
};

export type TagColor = "gray" | "yellow" | "blue" | "green" | "pink" | "purple";

/** Tag colour per role. */
export const ROLE_TAG_COLOR: Record<Role, TagColor> = {
  owner: "yellow",
  manager: "blue",
  staff: "green",
  kiosk: "pink",
  cs: "purple",
};

/**
 * Background + text classes for a tag / avatar, from the live redesign
 * tokens only (no extra palette): the four status tones plus two neutrals.
 */
const TAG_CLASS: Record<TagColor, string> = {
  gray: "bg-hub-fill text-hub-muted",
  yellow: "bg-hub-warn-bg text-hub-warn",
  blue: "bg-hub-info-bg text-hub-info",
  green: "bg-hub-accent-bg text-hub-accent-text",
  pink: "bg-hub-bad-bg text-hub-bad",
  purple: "bg-hub-fill-2 text-hub-text",
};

export function tagClass(color: TagColor): string {
  return TAG_CLASS[color];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "?";
}
