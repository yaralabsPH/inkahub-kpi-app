/**
 * Task 17: the framework-free state shape of a published management view and
 * the key of a detail table within it (shared by the view controller hook and
 * the pure page adapters; no React here).
 */
import type { DetailKind, PublishedDetailRow, SummaryResult } from "./productionReporting";

export type PublishedStatus = "idle" | "loading" | "current" | "stale" | "legacy" | "error";
export interface PublishedState {
  status: PublishedStatus;
  identityKey: string | null;
  summary: SummaryResult | null;
  error: string | null;
  /** Loaded detail pages per complete selector (`detailKey`), all in the generation of `summary`. */
  details: Partial<Record<string, { rows: PublishedDetailRow[]; nextCursor: string | null; totalRows: number }>>;
}

/** A detail table's complete selector within a view: kind plus every detail-only filter (order number). */
export const detailKey = (kind: DetailKind, orderNumber?: string | null) => JSON.stringify([kind, orderNumber ?? null]);
