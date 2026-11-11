/**
 * Tiny `classNames` helper. Joins truthy strings with spaces, flattens
 * arrays, drops falsy values. No tailwind-merge semantics — last-wins is
 * fine for this codebase since we don't ship conflicting tailwind classes
 * through the same call site.
 */
export type ClassValue = string | number | null | false | undefined | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const stack: ClassValue[] = [...inputs];
  while (stack.length) {
    const x = stack.shift();
    if (x === null || x === undefined || x === false || x === "") continue;
    if (Array.isArray(x)) { stack.unshift(...x); continue; }
    if (typeof x === "string") out.push(x);
    else if (typeof x === "number") out.push(String(x));
  }
  return out.join(" ");
}
