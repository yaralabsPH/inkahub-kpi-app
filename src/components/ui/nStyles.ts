/**
 * Shared class strings for plain elements (open tables, date fields) where a
 * wrapper component would add nothing. Redesign tokens only.
 */

/**
 * Wrap open tables (no box) in this so they scroll inside their own area on
 * narrow screens. `relative` keeps sr-only header labels inside the scroll
 * box (otherwise they position against <body> and stretch the window).
 */
export const nTableWrap = "relative overflow-x-auto";
export const nTable = "w-full border-collapse text-[13.5px]";
export const nTh = "whitespace-nowrap border-b border-hub-line px-2.5 py-[7px] text-left text-[12.5px] font-medium text-hub-muted";
export const nThNum = nTh + " text-right";
export const nTd = "border-b border-hub-line px-2.5 py-[9px] align-middle";
export const nTdNum = nTd + " text-right tabular-nums";

/** 32px date / text field; the shell sets color-scheme so the native picker follows the theme. */
export const nField =
  "h-8 rounded-hub border border-hub-line bg-hub-fill px-2.5 text-sm text-hub-text outline-none focus:border-hub-accent-text";
