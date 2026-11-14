/**
 * The Reports order-lookup lifecycle, without React: a result belongs to the
 * user, site and order it was read for, under one fixed cutoff. Changing user
 * or site clears it, and a late response for an older search (or an older
 * scope) is discarded, so a count never appears under another site or account.
 * `OrderLookupCard` drives this; tests drive it with deferred responses.
 */
import type { OrderLookupRequest, OrderLookupResult } from "./orderLookup";

export interface OrderLookupHit<T> {
  /** `${scopeKey}|${order}` the result was read for. */
  key: string;
  location: string;
  order: string;
  asOfUtc: string;
  events: T[];
  complete: boolean;
}

export interface OrderLookupView<T> {
  scopeKey: string;
  searched: string | null;
  loading: boolean;
  error: string | null;
  lookup: OrderLookupHit<T> | null;
  /** The events to show: only when the result belongs to the current scope and search. */
  events: T[] | null;
}

export interface OrderLookupSession<T> {
  view(): OrderLookupView<T>;
  /** User/site changed: clear everything and invalidate any search in flight. */
  setScope(scopeKey: string, location: string): void;
  search(rawInput: string): Promise<void>;
  setError(message: string | null): void;
  reset(): void;
}

export function createOrderLookupSession<T>(deps: {
  load: (req: OrderLookupRequest) => Promise<OrderLookupResult<T>>;
  normalize: (raw: string) => string;
  now: () => string;
  onChange: (view: OrderLookupView<T>) => void;
  scopeKey: string;
  location: string;
}): OrderLookupSession<T> {
  let seq = 0;
  let location = deps.location;
  let state: Omit<OrderLookupView<T>, "events"> = { scopeKey: deps.scopeKey, searched: null, loading: false, error: null, lookup: null };
  const view = (): OrderLookupView<T> => {
    const { lookup, searched, scopeKey } = state;
    const events = lookup && searched && lookup.key === `${scopeKey}|${searched}` ? lookup.events : null;
    return { ...state, events };
  };
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    deps.onChange(view());
  };
  return {
    view,
    setScope(scopeKey, loc) {
      if (scopeKey === state.scopeKey && loc === location) return;
      seq++;
      location = loc;
      set({ scopeKey, searched: null, lookup: null, error: null, loading: false });
    },
    async search(rawInput) {
      const normalized = deps.normalize(rawInput);
      if (!normalized) {
        set({ error: "Enter an order number first." });
        return;
      }
      const mine = ++seq;
      const asOfUtc = deps.now();
      const scopeKey = state.scopeKey;
      const loc = location;
      set({ error: null, loading: true, searched: normalized });
      try {
        const res = await deps.load({ location: loc, orderNumber: normalized, asOfUtc });
        if (mine !== seq) return;
        set({ lookup: { key: `${scopeKey}|${normalized}`, location: loc, order: normalized, asOfUtc, events: res.events, complete: res.complete }, loading: false });
      } catch (e) {
        if (mine !== seq) return;
        set({ error: e instanceof Error ? e.message : String(e), lookup: null, loading: false });
      }
    },
    setError(message) {
      set({ error: message });
    },
    reset() {
      seq++;
      set({ searched: null, lookup: null, error: null, loading: false });
    },
  };
}
