/**
 * Classified fixture rows for publication tests and the staging runner: the
 * REAL Task 11 projector's facts mapped to the five staged arrays, grouped by
 * owner partition (trimmed nonblank order, else event id). Task 14 owns the
 * production mapping; this fixture only has to be a faithful, valid input
 * (every row passes resultRowProblem and the frozen-source binding).
 */
import { productionDateAt, type ReportSite } from "../../src/lib/domain/productionPeriods";
import { evidenceOrderKey } from "../../src/lib/domain/productionCounts";
import type { PartitionResult } from "../../src/lib/domain/productionReporting";
import type { ResultRows } from "../../api/_lib/reporting-stage";

export type Owner = { partitionKind: "order" | "event"; partitionKey: string };
export const ownerOf = (orderKey: string, id: string): Owner => (orderKey ? { partitionKind: "order", partitionKey: orderKey } : { partitionKind: "event", partitionKey: id });
export const ownerKey = (o: Owner) => `${o.partitionKind}\u0000${o.partitionKey}`;
export const emptyRows = (): ResultRows => ({ event_facts: [], cancel_edges: [], order_occurrences: [], timing_facts: [], source_issue_facts: [] });

/** Exact ISO-8601 (UTC, microseconds) for epoch microseconds. */
export function isoOfMicros(us: string): string {
  const n = BigInt(us);
  const ms = n / 1000n;
  return new Date(Number(ms)).toISOString().replace("Z", `${String(n % 1000n).padStart(3, "0")}Z`);
}

/** The five staged arrays of one partition result, grouped by owner. */
export function rowsByOwner(r: PartitionResult): Map<string, { owner: Owner; rows: ResultRows }> {
  const out = new Map<string, { owner: Owner; rows: ResultRows }>();
  const at = (o: Owner) => {
    const k = ownerKey(o);
    if (!out.has(k)) out.set(k, { owner: o, rows: emptyRows() });
    return out.get(k)!.rows;
  };
  const factOwner = new Map<string, Owner>();
  for (const f of r.facts) {
    const o = ownerOf(f.orderKey, f.id);
    factOwner.set(f.id, o);
    const v = f.role === "verification";
    at(o).event_facts.push({
      event_id: f.id, event_type: f.eventType, created_at: f.createdAt, staff_id: f.staffId, department: f.department, raw_order: f.rawOrder,
      order_key: f.orderKey, case_id: f.caseId, parent_event_id: f.parentId, sku: f.sku,
      quantity: typeof f.quantity === "number" && Number.isInteger(f.quantity) ? f.quantity : null,
      role: f.role, work_type: f.workType, invalid_detail: f.invalidDetail, line_key: f.lineKey,
      item_status: f.item?.status ?? null, items: f.item?.items ?? null, product_kind: f.item?.productKind ?? null,
      item_issue_kind: f.item?.issue?.kind ?? null, item_issue_detail: f.item?.issue?.detail ?? null,
      timing_stream: v ? (f.timing?.stream ?? false) : null, timing_weight: v ? (f.timing?.weight ?? 0) : null,
      production_date: v ? productionDateAt(new Date(f.ms), r.site as ReportSite) : null,
    });
  }
  for (const f of r.facts) {
    const o = factOwner.get(f.id)!;
    // Order identity of a terminal with a work type, person and order (exact terminal identity; qualification is read-time).
    if (f.role === "terminal" && f.workType && f.staffId && f.orderKey && f.rawOrder !== null) {
      at(o).order_occurrences.push({ terminal_event_id: f.id, order_key: f.orderKey, raw_order: f.rawOrder, case_id: f.caseId, work_type: f.workType, staff_id: f.staffId, occurred_at: f.createdAt });
    }
    // Timing observation of an effective stream line, with its full-history predecessors (index hints).
    if (f.role === "verification" && !f.cancelledBy.length && f.timing?.stream && f.staffId && f.workType) {
      at(o).timing_facts.push({
        event_id: f.id, staff_id: f.staffId, work_type: f.workType, occurred_at: f.createdAt, weight: f.timing.weight,
        prev_all_event_id: f.timing.prevAll?.id ?? null, prev_same_type_event_id: f.timing.prevSameType?.id ?? null,
      });
    }
  }
  for (const e of r.edges) {
    at(factOwner.get(e.cancelId)!).cancel_edges.push({
      cancel_event_id: e.cancelId, parent_event_id: e.parentId, is_self: e.self, parent_role: e.parentRole,
      parent_created_at: e.parentUs === null ? null : isoOfMicros(e.parentUs),
      pair: e.parentRole === "verification" || e.parentRole === "terminal" ? e.pair : null,
    });
  }
  for (const x of r.sourceIssues) {
    at(ownerOf(evidenceOrderKey(x.rawOrder), x.id)).source_issue_facts.push({
      event_id: x.id, event_type: x.eventType, created_at: x.createdAt, staff_id: x.staffId, raw_order: x.rawOrder, parent_event_id: x.parentId,
      issue_kind: x.issue.kind, issue_detail: x.issue.detail ?? null,
    });
  }
  return out;
}
