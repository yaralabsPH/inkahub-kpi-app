/**
 * Exact production-event instants. PostgreSQL keeps microseconds and
 * `Date.parse` drops them, so ordering, qualification and cancellation checks
 * compare these bigint keys; milliseconds are only for display and durations.
 */

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Microseconds since the epoch, or null if the text is not an exact ISO-8601 instant. */
export function instantMicros(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const m = INSTANT_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(ms);
  if (
    !Number.isFinite(ms) || +h > 23 || +mi > 59 || +s > 59 ||
    check.getUTCFullYear() !== +y || check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d
  ) return null;
  let offsetMin = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const oh = +digits.slice(0, 2);
    const om = digits.length > 2 ? +digits.slice(2, 4) : 0;
    if (oh > 23 || om > 59) return null;
    offsetMin = sign * (oh * 60 + om);
  }
  const micros = BigInt((frac ?? "").padEnd(6, "0"));
  return (BigInt(ms) - BigInt(offsetMin) * 60_000n) * 1000n + micros;
}

