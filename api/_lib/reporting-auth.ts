/**
 * Task 15: auth-first helpers for the protected reporting endpoints.
 *
 * `bearerMatches` is the same rule as the S1 digest's (unchanged there): a
 * nonblank configured secret, exactly one Authorization header, and a
 * constant-time comparison of the whole `Bearer <secret>` value. It runs
 * before any parsing, environment or database work.
 */
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { RpcClient } from "./reporting-jobs.js";

export type Headers = Record<string, string | string[] | undefined> | undefined;

export function bearerMatches(headers: Headers, secret: string | undefined): boolean {
  if (typeof secret !== "string" || secret.trim() === "") return false;
  if (!headers || typeof headers !== "object") return false;
  const keys = Object.keys(headers).filter((k) => k.toLowerCase() === "authorization");
  if (keys.length !== 1) return false;
  const value = headers[keys[0]];
  if (typeof value !== "string") return false;
  const got = Buffer.from(value, "utf-8");
  const want = Buffer.from(`Bearer ${secret}`, "utf-8");
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/** The service-role RPC client (server only), or null when the environment is incomplete. */
export function serviceRpcClient(env: Record<string, string | undefined> = process.env): RpcClient | null {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return { rpc: (fn, args) => supabase.rpc(fn, args) as unknown as PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
}

export interface MinimalRequest {
  method?: string;
  headers: Headers;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}
export interface MinimalResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}
