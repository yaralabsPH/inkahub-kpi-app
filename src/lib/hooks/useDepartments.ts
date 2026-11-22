import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  DEPARTMENT_PAGE_DEFAULT,
  type DepartmentControl,
  type DepartmentCursor,
  type DepartmentPageKind,
  type DepartmentPageRows,
} from "@/lib/domain/departments";
import {
  departmentAdminReducer,
  departmentPayloadKey,
  initialDepartmentAdminState,
  type DepartmentAdminAction,
  type DepartmentAdminState,
} from "@/lib/departments/adminState";
import {
  fetchAllDepartmentRows,
  fetchDepartmentControl,
  fetchDepartmentPage,
  sendDepartmentChange,
  type DepartmentChange,
  type DepartmentErrorKind,
  type DepartmentResult,
} from "@/lib/departments/client";
import { getSupabase } from "@/lib/repository/supabase/client";

/**
 * F5 departments: owner-only query hooks for the Team page.
 *
 * These call Supabase. They must only be mounted after the page has checked
 * that the backend is Supabase and the signed-in user is an owner (see
 * DepartmentsCard), so nothing is requested in Dexie mode or for non-owners.
 *
 * Every cache key starts with ["departments", callerId, "global", ...]:
 * one owner's cached lists are never shown to another account, and
 * `useDepartmentsSession` drops them when the caller changes or signs out.
 */

export class DepartmentQueryError extends Error {
  constructor(public readonly kind: DepartmentErrorKind, message: string) {
    super(message);
    this.name = "DepartmentQueryError";
  }
}

function unwrap<T>(result: DepartmentResult<T>): T {
  if (result.outcome === "ok") return result.value;
  throw new DepartmentQueryError(result.kind, result.message);
}

export function departmentsKeyPrefix(callerId: string): readonly unknown[] {
  return ["departments", callerId, "global"];
}

export function departmentsKey(
  callerId: string,
  kind: DepartmentPageKind | "control",
  subjectId: string | null = null,
  cursor: "all" | "paged" = "all",
): readonly unknown[] {
  return [...departmentsKeyPrefix(callerId), kind, subjectId, cursor];
}

/** Cancel and forget one caller's department data. */
export async function clearDepartmentsCache(queryClient: QueryClient, callerId: string): Promise<void> {
  const queryKey = departmentsKeyPrefix(callerId);
  await queryClient.cancelQueries({ queryKey });
  queryClient.removeQueries({ queryKey });
}

/** Mount once per owner session: clears that owner's data when they leave. */
export function useDepartmentsSession(callerId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    return () => {
      void clearDepartmentsCache(queryClient, callerId);
    };
  }, [queryClient, callerId]);
}

/** A whole list (departments, people, members). Read page by page to the end. */
export function useDepartmentRows<K extends DepartmentPageKind>(
  callerId: string,
  kind: K,
  subjectId: string | null = null,
  enabled = true,
) {
  return useQuery<DepartmentPageRows[K][], DepartmentQueryError>({
    queryKey: departmentsKey(callerId, kind, subjectId, "all"),
    queryFn: async () => unwrap(await fetchAllDepartmentRows(getSupabase(), kind, subjectId)),
    enabled,
    retry: false,
  });
}

/** A long list (history, audit) shown one page at a time with "Load more". */
export function useDepartmentPaged<K extends DepartmentPageKind>(
  callerId: string,
  kind: K,
  subjectId: string | null = null,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: departmentsKey(callerId, kind, subjectId, "paged"),
    initialPageParam: null as DepartmentCursor,
    queryFn: async ({ pageParam }) =>
      unwrap(await fetchDepartmentPage(getSupabase(), kind, subjectId, pageParam, DEPARTMENT_PAGE_DEFAULT)),
    // undefined (not null) is how TanStack Query is told "no more pages".
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    retry: false,
  });
}

export function useDepartmentControl(callerId: string, enabled = true) {
  return useQuery<DepartmentControl, DepartmentQueryError>({
    queryKey: departmentsKey(callerId, "control"),
    queryFn: async () => unwrap(await fetchDepartmentControl(getSupabase())),
    enabled,
    retry: false,
  });
}

export interface DepartmentChangeHandle {
  state: DepartmentAdminState<DepartmentChange>;
  /** Send a change. Resolves true only when the server confirmed it. */
  submit: (change: DepartmentChange) => Promise<boolean>;
  reset: () => void;
}

/**
 * One in-flight owner change with the retry rules from adminState.ts.
 * After any answer the caller's department lists are refetched, so the
 * screen never keeps showing a guess.
 */
export function useDepartmentChange(callerId: string): DepartmentChangeHandle {
  const queryClient = useQueryClient();
  const [state, setState] = useState<DepartmentAdminState<DepartmentChange>>(() => initialDepartmentAdminState());
  const current = useRef(state);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((action: DepartmentAdminAction<DepartmentChange>) => {
    const next = departmentAdminReducer(current.current, action);
    current.current = next;
    if (mounted.current) setState(next);
    return next;
  }, []);

  const submit = useCallback(async (change: DepartmentChange): Promise<boolean> => {
    const next = apply({
      type: "submit",
      input: change,
      payloadKey: departmentPayloadKey(change),
      newRequestId: crypto.randomUUID(),
    });
    if (!next.send) return false; // already in flight
    const { requestId } = next.send;
    const result = await sendDepartmentChange(getSupabase(), change, requestId);
    // The owner may have signed out or left while we waited: drop the answer.
    if (!mounted.current) return false;
    if (result.outcome === "ok") {
      apply({ type: "succeeded", requestId });
    } else {
      apply({ type: "failed", requestId, kind: result.kind, message: result.message });
    }
    await queryClient.invalidateQueries({ queryKey: departmentsKeyPrefix(callerId) });
    return result.outcome === "ok";
  }, [apply, queryClient, callerId]);

  const reset = useCallback(() => {
    apply({ type: "reset" });
  }, [apply]);

  return { state, submit, reset };
}
