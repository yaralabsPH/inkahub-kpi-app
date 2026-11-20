/**
 * Task 17: browser access to the authorized published report API.
 *
 * Calls GET /api/reports/summary and /api/reports/detail with the signed-in
 * user's access token (the server re-authorizes every request and derives the
 * audience itself). Failures are typed, never zeroed:
 *   READ_MODE_LEGACY / READ_MODE_SHADOW  the site still uses the existing reads
 *   GENERATION_EXPIRED (410)             reload the whole view (drop the pin)
 *   401 / 403                            session / permission
 *   503 UNAVAILABLE / TOO_LARGE, 5xx     no published report / service error
 */
import type { DetailRequest, Page, PublishedDetailRow, SummaryRequest, SummaryResult } from "@/lib/domain/productionReporting";

export class PublishedReadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PublishedReadError";
  }
  /** The site has not switched to published reports: keep the existing read path. */
  get legacyMode(): boolean {
    return this.code === "READ_MODE_LEGACY" || this.code === "READ_MODE_SHADOW";
  }
  /** The pinned generation is gone: the whole view must reload together. */
  get expired(): boolean {
    return this.status === 410;
  }
}

export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal; cache: "no-store" }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  return q.toString();
}

async function get<T>(fetchImpl: FetchLike, path: string, token: string, signal?: AbortSignal): Promise<T> {
  const r = await fetchImpl(path, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal, cache: "no-store" });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  if (!r.ok) {
    const b = (body ?? {}) as { error?: unknown; code?: unknown };
    throw new PublishedReadError(r.status, typeof b.code === "string" ? b.code : `HTTP_${r.status}`, typeof b.error === "string" ? b.error : "Report request failed");
  }
  if (!body || typeof body !== "object") throw new PublishedReadError(502, "BAD_RESPONSE", "The report service returned no data");
  return body as T;
}

export function fetchPublishedSummary(fetchImpl: FetchLike, token: string, r: SummaryRequest, signal?: AbortSignal): Promise<SummaryResult> {
  return get<SummaryResult>(fetchImpl, `/api/reports/summary?${query({ site: r.site, firstDate: r.firstDate, lastDate: r.lastDate, view: r.view, staffId: r.staffId, workType: r.workType, generationId: r.generationId })}`, token, signal);
}

export function fetchPublishedDetail(fetchImpl: FetchLike, token: string, r: DetailRequest, signal?: AbortSignal): Promise<Page<PublishedDetailRow>> {
  return get<Page<PublishedDetailRow>>(fetchImpl, `/api/reports/detail?${query({ site: r.site, generationId: r.generationId, kind: r.kind, firstDate: r.firstDate, lastDate: r.lastDate, staffId: r.staffId, workType: r.workType, orderNumber: r.orderNumber, cursor: r.cursor, limit: r.limit })}`, token, signal);
}
