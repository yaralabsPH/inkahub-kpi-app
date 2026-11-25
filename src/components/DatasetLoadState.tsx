import { RefreshCw } from "lucide-react";
import { DataState } from "@/components/ui/DataState";
import { Button } from "@/components/ui/Button";

/** The parts of the existing dataset query this presentation needs. */
export interface DatasetReadState {
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  data: unknown;
  refetch: () => unknown;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error");

/**
 * What a page shows while its dataset is absent: loading, or the read error
 * with Retry. Retry only re-runs the existing read (the query's refetch); it
 * never repeats a write.
 */
export function DatasetLoadState({ result, title }: { result: DatasetReadState; title: string }) {
  if (result.isError) {
    return (
      <DataState
        kind="error"
        title="Couldn't load this page's data."
        message={<>Check your connection. Nothing you entered was lost. ({messageOf(result.error)})</>}
        action={
          <Button variant="secondary" size="sm" onClick={() => void result.refetch()} disabled={result.isFetching}>
            <RefreshCw size={14} aria-hidden="true" /> {result.isFetching ? "Retrying…" : "Retry"}
          </Button>
        }
      />
    );
  }
  return <DataState kind="loading" title={title} />;
}

/**
 * Shell banner for a background refresh failure while earlier data is still
 * on screen. Pages, forms and their unsaved input stay mounted.
 */
export function DatasetRefreshBanner({ result }: { result: DatasetReadState }) {
  if (!result.isError || result.data === undefined) return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-hub bg-hub-warn-bg px-3 py-2 text-[13px] text-hub-text">
      <span className="min-w-0 flex-1">
        Couldn't refresh the data — showing what was loaded earlier. Unsaved input on this page is kept.
      </span>
      <Button variant="secondary" size="sm" onClick={() => void result.refetch()} disabled={result.isFetching}>
        <RefreshCw size={14} aria-hidden="true" /> {result.isFetching ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
