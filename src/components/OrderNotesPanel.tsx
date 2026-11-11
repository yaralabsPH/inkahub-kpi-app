import { useCallback, useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/Button";

/**
 * OrderNotesPanel
 * ===============
 *
 * Shows staff-written notes attached to a specific order_number at a
 * specific location, and lets the current user add a new note or toggle
 * the resolved flag.
 *
 * Backed by the `order_notes` table (see migration 0016_order_notes.sql).
 *
 * Two visual variants:
 *   - "loud"    â€” big amber banner, large type, used inside Production
 *                 so a framer can't miss a pending message
 *   - "compact" â€” neutral card, used in Reports' Order lookup
 *
 * If `author` is null, the panel renders read-only (no Add / Resolve buttons).
 */

export interface OrderNote {
  id: string;
  location: string;
  order_number: string;
  staff_id: string | null;
  staff_display_name: string;
  body: string;
  resolved: boolean;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface Props {
  supabase: SupabaseClient;
  location: string;
  orderNumber: string;
  /** Author identity used when adding/resolving. If null, panel is read-only. */
  author: { user_id: string; display_name: string } | null;
  /** Visual variant. "loud" for production scan, "compact" for reports. */
  variant?: "loud" | "compact";
}

export function OrderNotesPanel({
  supabase, location, orderNumber, author, variant = "compact",
}: Props) {
  const [notes, setNotes] = useState<OrderNote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("order_notes")
        .select("*")
        .eq("location", location)
        .eq("order_number", orderNumber)
        .order("created_at", { ascending: false });
      if (err) throw err;
      setNotes((data ?? []) as OrderNote[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [supabase, location, orderNumber]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const addNote = useCallback(async () => {
    if (!author) return;
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await supabase.from("order_notes").insert([{
        id: crypto.randomUUID(),
        location,
        order_number: orderNumber,
        staff_id: author.user_id,
        staff_display_name: author.display_name,
        body,
        resolved: false,
      }]);
      if (err) throw err;
      setDraft("");
      setComposing(false);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supabase, location, orderNumber, author, draft, reload]);

  const toggleResolved = useCallback(async (note: OrderNote) => {
    if (!author) return;
    setBusy(true);
    setError(null);
    try {
      const willResolve = !note.resolved;
      const { error: err } = await supabase.from("order_notes").update({
        resolved: willResolve,
        resolved_at: willResolve ? new Date().toISOString() : null,
        resolved_by: willResolve ? author.user_id : null,
      }).eq("location", location).eq("id", note.id);
      if (err) throw err;
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supabase, location, author, reload]);

  const all = notes ?? [];
  const unresolved = all.filter((n) => !n.resolved);
  const resolved = all.filter((n) => n.resolved);

  // If we have nothing to show AND no author to compose with, render nothing.
  if (!loading && notes !== null && all.length === 0 && !author) {
    return null;
  }

  const isLoud = variant === "loud";

  // Only show the loud banner styling when there are actually unresolved notes
  // OR the user is composing one. Otherwise downgrade to compact-ish neutral.
  const showLoud = isLoud && (unresolved.length > 0 || composing);

  const containerCls = showLoud
    ? "rounded-2xl ring-2 ring-amber-300 dark:ring-amber-700 bg-amber-50/80 dark:bg-amber-900/30 p-5"
    : isLoud
    ? "rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-3"
    : "rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-3";

  const headerCls = showLoud
    ? "flex items-center gap-2 text-lg font-semibold text-amber-900 dark:text-amber-200"
    : "flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200";

  return (
    <div className={containerCls}>
      <div className={headerCls}>
        <StickyNote size={showLoud ? 22 : 14} />
        <span>
          Notes on this order
          {unresolved.length > 0 ? ` (${unresolved.length} unresolved)` : ""}
        </span>
        {author && !composing ? (
          <button
            type="button"
            onClick={() => setComposing(true)}
            className={
              showLoud
                ? "ml-auto text-sm underline text-amber-900 hover:text-amber-700 dark:text-amber-200"
                : "ml-auto text-xs underline text-slate-600 hover:text-slate-900 dark:text-slate-300"
            }
          >
            + Add note
          </button>
        ) : null}
      </div>

      {loading && notes === null ? (
        <div className="text-xs text-slate-500 italic mt-2">Loading notes...</div>
      ) : null}
      {error ? (
        <div className="mt-2 text-xs text-rose-700 bg-rose-50 ring-1 ring-rose-200 rounded px-2 py-1 dark:bg-rose-900/20 dark:text-rose-300 dark:ring-rose-800">
          {error}
        </div>
      ) : null}

      {composing && author ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. customer requested wider frame; cancel and remake"
            rows={3}
            disabled={busy}
            autoFocus
            className="w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void addNote()}
              disabled={busy || !draft.trim()}
            >
              {busy ? "Saving..." : "Save note"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setComposing(false); setDraft(""); }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {unresolved.length > 0 ? (
        <div className="mt-3 space-y-2">
          {unresolved.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              loud={showLoud}
              canResolve={!!author}
              onToggle={() => void toggleResolved(n)}
            />
          ))}
        </div>
      ) : null}

      {resolved.length > 0 ? (
        <details className="mt-3">
          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 dark:hover:text-slate-300 select-none">
            {resolved.length} resolved note{resolved.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-2 space-y-2">
            {resolved.map((n) => (
              <NoteCard
                key={n.id}
                note={n}
                loud={false}
                canResolve={!!author}
                onToggle={() => void toggleResolved(n)}
                resolved
              />
            ))}
          </div>
        </details>
      ) : null}

      {!loading && all.length === 0 && author && !composing ? (
        <div className="mt-2 text-xs text-slate-500 italic">
          No notes on this order yet.
        </div>
      ) : null}
    </div>
  );
}

function NoteCard({
  note, loud, canResolve, onToggle, resolved,
}: {
  note: OrderNote;
  loud: boolean;
  canResolve: boolean;
  onToggle: () => void;
  resolved?: boolean;
}) {
  const when = new Date(note.created_at).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const cardCls = resolved
    ? "rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-slate-50 dark:bg-slate-900/40 p-2 opacity-70"
    : loud
    ? "rounded-md ring-1 ring-amber-300 dark:ring-amber-700 bg-white dark:bg-slate-900 p-3"
    : "rounded-md ring-1 ring-slate-200 dark:ring-slate-800 bg-white dark:bg-slate-900 p-2";
  const bodyCls = loud && !resolved
    ? "text-base font-medium text-slate-900 dark:text-slate-100 whitespace-pre-wrap"
    : "text-sm text-slate-800 dark:text-slate-200 whitespace-pre-wrap";
  return (
    <div className={cardCls}>
      <div className={bodyCls}>{note.body}</div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span>
          {note.staff_display_name} - {when}
          {resolved ? " - resolved" : ""}
        </span>
        {canResolve ? (
          <button
            type="button"
            onClick={onToggle}
            className="text-[11px] underline hover:text-slate-800 dark:hover:text-slate-200"
          >
            {resolved ? "Reopen" : "Resolve"}
          </button>
        ) : null}
      </div>
    </div>
  );
}