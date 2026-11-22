/**
 * F7: reading the stored framer attributions for Reports (order lookup and
 * the raw CSV). Read-only; RLS limits rows to owner/manager at their sites.
 * Nothing here feeds KPI math: a manual attribution is never framing work.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FramerAttribution {
  dispatch_event_id: string;
  order_number: string;
  sku: string;
  source: "scan" | "manual";
  display_name: string;
  person_id: string;
  recorded_at: string;
  dispatcher_id: string;
}

const COLUMNS = "dispatch_event_id, order_number, sku, source, display_name, person_id, recorded_at, dispatcher_id";
export const ATTRIBUTION_BATCH = 200;
/** Rows per response page; at or below Supabase's default max-rows (1000). */
export const ATTRIBUTION_PAGE = 1000;

/** Only shared-scanner dispatches (event ids "dsp-...-d") can have attributions. */
export function attributableEventIds(events: ReadonlyArray<{ id: string; event_type: string }>): string[] {
  return [...new Set(events.filter((e) => e.event_type === "dispatched" && e.id.startsWith("dsp-")).map((e) => e.id))];
}

export type AttributionLoad = { ok: true; rows: FramerAttribution[] } | { ok: false; message: string };

const missingTable = (code?: string) => code === "PGRST205" || code === "42P01";

/**
 * Batched by event id within the caller's site, and paged inside each batch
 * in a stable order (dispatch_event_id, sku; unique per site) until a short
 * page, so a capped response can never silently drop rows. A database
 * without 0056 answers "none".
 */
export async function fetchAttributionsForEvents(client: SupabaseClient, location: string, eventIds: readonly string[]): Promise<AttributionLoad> {
  const rows: FramerAttribution[] = [];
  for (let i = 0; i < eventIds.length; i += ATTRIBUTION_BATCH) {
    const ids = eventIds.slice(i, i + ATTRIBUTION_BATCH);
    for (let from = 0; ; from += ATTRIBUTION_PAGE) {
      try {
        const { data, error } = await client.from("dispatch_framer_attributions").select(COLUMNS)
          .eq("location", location).in("dispatch_event_id", ids)
          .order("dispatch_event_id", { ascending: true }).order("sku", { ascending: true })
          .range(from, from + ATTRIBUTION_PAGE - 1);
        if (error) {
          if (missingTable(error.code)) return { ok: true, rows: [] };
          return { ok: false, message: error.message };
        }
        const page = (data ?? []) as FramerAttribution[];
        rows.push(...page);
        if (page.length < ATTRIBUTION_PAGE) break;
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  return { ok: true, rows };
}

export async function fetchAttributionsForOrder(client: SupabaseClient, location: string, orderNumber: string): Promise<AttributionLoad> {
  try {
    const { data, error } = await client.from("dispatch_framer_attributions").select(COLUMNS)
      .eq("location", location).eq("order_number", orderNumber).order("sku").limit(500);
    if (error) return missingTable(error.code) ? { ok: true, rows: [] } : { ok: false, message: error.message };
    return { ok: true, rows: (data ?? []) as FramerAttribution[] };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Spreadsheet formula guard for free text we newly export (OWASP CSV injection). */
export function csvSafeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export const ATTRIBUTION_CSV_HEADERS = ["framed_by", "framer_evidence"] as const;

/**
 * The two appended CSV cells for one event row: names ("; "-joined, per SKU
 * order) and "SKU: scan|manual" pairs. Empty for rows without attributions.
 */
export function attributionCsvCells(eventId: string, byEvent: ReadonlyMap<string, readonly FramerAttribution[]>, unavailable = false): [string, string] {
  const rows = byEvent.get(eventId);
  if (!rows || rows.length === 0) return unavailable && eventId.startsWith("dsp-") ? ["unavailable", "unavailable"] : ["", ""];
  const sorted = [...rows].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return [
    sorted.map((r) => csvSafeText(r.display_name)).join("; "),
    sorted.map((r) => `${r.sku}: ${r.source === "manual" ? "manual" : "scan"}`).join("; "),
  ];
}

export function groupByEvent(rows: readonly FramerAttribution[]): Map<string, FramerAttribution[]> {
  const m = new Map<string, FramerAttribution[]>();
  for (const r of rows) {
    const list = m.get(r.dispatch_event_id) ?? [];
    list.push(r);
    m.set(r.dispatch_event_id, list);
  }
  return m;
}
