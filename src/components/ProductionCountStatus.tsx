/**
 * Shared status line for F1 production counts: load state, production window,
 * snapshot time, visibility and coverage. Shows only counts of issues, never
 * other people's details, so it reveals nothing a role could not already see.
 */
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { ProductionCoverage, CoverageIssueKind, CoverageNoteKind } from "@/lib/domain/productionCounts";
import type { ProductionRange } from "@/lib/domain/productionPeriods";
import type { ProductionEvidenceState } from "@/lib/hooks/useProductionSummary";
import { cn } from "@/lib/utils/cn";

const ISSUE_LABELS: Record<CoverageIssueKind, string> = {
  invalid_event: "invalid saved events",
  unclassified_sku: "unrecognised SKUs",
  invalid_quantity: "missing or invalid quantities",
  unresolved_parent: "corrections that could not be matched",
  missing_completion_detail: "completions without line detail",
  ambiguous_repeat: "possible repeated scans",
};

const NOTE_LABELS: Record<CoverageNoteKind, string> = {
  expected_exclusion: "excluded lines (hooks, gift cards, packaging…)",
  corrected_verification: "unverified lines",
  reversed_terminal: "reversed completions",
  excluded_only_completion: "completions with excluded items only",
};

function fmtTime(iso: string | undefined, timeZone?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) });
}

export interface ProductionCountStatusProps {
  state: Pick<ProductionEvidenceState, "status" | "updating" | "error" | "unavailableReason" | "snapshot" | "refresh">;
  range: ProductionRange | null;
  coverage?: ProductionCoverage | null;
  /** Extra disclosures (overlapping Orders, processed work…). */
  notes?: string[];
  className?: string;
  compact?: boolean;
}

export function ProductionCountStatus({ state, range, coverage, notes, className, compact }: ProductionCountStatusProps) {
  const { status, updating, error, unavailableReason, snapshot, refresh } = state;
  const issueEntries = coverage ? (Object.entries(coverage.issueCounts) as [CoverageIssueKind, number][]).filter(([, n]) => n > 0) : [];
  const noteEntries = coverage ? (Object.entries(coverage.notes) as [CoverageNoteKind, number][]).filter(([, n]) => n > 0) : [];
  const limited = coverage?.visibility.kind === "limited" ? coverage.visibility.reason : null;

  const pill =
    status === "unavailable" ? (
      <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300">
        <AlertTriangle size={12} /> Counts unavailable: {unavailableReason}
      </span>
    ) : status === "error" ? (
      <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-300" role="alert">
        <AlertTriangle size={12} /> Couldn't load production counts: {error}
      </span>
    ) : status === "stale" ? (
      <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300" role="status">
        <AlertTriangle size={12} /> Showing counts as of {fmtTime(snapshot?.asOfUtc, range?.timeZone)}; refresh failed: {error}
      </span>
    ) : status === "loading" || updating ? (
      <span className="inline-flex items-center gap-1 text-slate-600 dark:text-slate-300" role="status">
        <Loader2 size={12} className="animate-spin" /> {status === "loading" ? "Loading production counts…" : "Updating…"}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 size={12} /> Counts as of {fmtTime(snapshot?.asOfUtc, range?.timeZone)}
      </span>
    );

  return (
    <div className={cn("text-[11px] text-slate-500 dark:text-slate-400 space-y-0.5", className)} data-production-status={status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {pill}
        {status !== "unavailable" && (status === "error" || status === "stale" || !compact) ? (
          <button type="button" onClick={refresh} className="inline-flex items-center gap-1 underline hover:text-slate-700 dark:hover:text-slate-200">
            <RefreshCw size={11} /> {status === "error" || status === "stale" ? "Retry" : "Refresh"}
          </button>
        ) : null}
      </div>
      {range && !compact ? (
        <div>
          Production {range.firstDate === range.lastDate ? `day ${range.firstDate}` : `days ${range.firstDate} → ${range.lastDate}`}, starting 04:00{" "}
          {range.timeZone} ({range.startUtc.slice(0, 16).replace("T", " ")} → {range.endUtcExclusive.slice(0, 16).replace("T", " ")} UTC)
          {snapshot ? ` · loaded ${fmtTime(snapshot.loadedAtUtc, range.timeZone)}` : ""}
        </div>
      ) : null}
      {limited ? <div className="text-amber-700 dark:text-amber-300">{limited} Coverage is limited.</div> : null}
      {issueEntries.length ? (
        <div className="text-amber-700 dark:text-amber-300">
          Totals may be incomplete: {issueEntries.map(([k, n]) => `${n} ${ISSUE_LABELS[k]}`).join(", ")}.
        </div>
      ) : null}
      {noteEntries.length && !compact ? <div>Included in reconciliation: {noteEntries.map(([k, n]) => `${n} ${NOTE_LABELS[k]}`).join(", ")}.</div> : null}
      {notes?.length && !compact ? notes.map((n) => <div key={n}>{n}</div>) : null}
    </div>
  );
}
