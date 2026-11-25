import type { ReactNode } from "react";
import { initials, tagClass, type TagColor } from "@/lib/auth/roles";
import { cn } from "@/lib/utils/cn";

/** Coloured tag (role, location, BOX/TUBE, size…), from the redesign tokens. */
export function Tag({
  color = "gray", children, className,
}: {
  color?: TagColor;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[21px] items-center whitespace-nowrap rounded px-[7px] text-[12.5px] font-medium leading-none",
        tagClass(color),
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Round initials avatar tinted with a tag colour. `size` is in px. */
export function Avatar({
  name, color = "gray", size = 28, className,
}: {
  name: string;
  color?: TagColor;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full font-semibold leading-none", tagClass(color), className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.41) }}
    >
      {initials(name)}
    </span>
  );
}

const AVATAR_COLORS: TagColor[] = ["blue", "green", "pink", "purple", "yellow"];

/** Stable colour for a person when no role colour applies (e.g. reports). */
export function colorForId(id: string): TagColor {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
