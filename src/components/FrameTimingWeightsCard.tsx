/**
 * F9 Settings (owner only): per-site size weights for the Max-method frame
 * timing estimate. Blank until an owner enters them (nothing is invented).
 * Every save is a new immutable version and must name the version it was
 * edited from; if someone saved in between, the save is refused and the
 * current values are reloaded. The server checks the owner role itself.
 */
import { useCallback, useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { validateWeights, WEIGHT_SIZES, type WeightSize } from "@/lib/domain/frameTimingReport";

export interface WeightsRpc {
  read(site: string): Promise<{ version: number; weights: Record<string, number> }>;
  save(site: string, expectedVersion: number, weights: Record<string, number>): Promise<{ version: number; weights: Record<string, number> }>;
}

export function supabaseWeightsRpc(supabase: SupabaseClient): WeightsRpc {
  return {
    async read(site) {
      const { data, error } = await supabase.rpc("read_frame_timing_weights", { p_site: site });
      if (error) throw new Error(error.message);
      return data as { version: number; weights: Record<string, number> };
    },
    async save(site, expectedVersion, weights) {
      const { data, error } = await supabase.rpc("save_frame_timing_weights", { p_site: site, p_expected_version: expectedVersion, p_weights: weights });
      if (error) throw new Error(error.message);
      return data as { version: number; weights: Record<string, number> };
    },
  };
}

/** Form text -> validated weights (blank fields are left out; at least one is needed). */
export function weightsFromForm(form: Record<string, string>): Partial<Record<WeightSize, number>> {
  const out: Record<string, number> = {};
  for (const s of WEIGHT_SIZES) {
    const t = (form[s] ?? "").trim();
    if (t === "") continue;
    if (!/^\d+(\.\d+)?$/.test(t)) throw new RangeError(`weight for ${s} must be a positive number`);
    out[s] = Number(t);
  }
  return validateWeights(out);
}

export type SubmitOutcome =
  | { kind: "saved"; version: number; message: string }
  | { kind: "conflict"; version: number; weights: Record<string, number>; message: string }
  | { kind: "error"; message: string };

/** Validate and save from the version the form was loaded at; on a conflict, return the current values. */
export async function submitWeights(rpc: WeightsRpc, site: string, version: number, form: Record<string, string>): Promise<SubmitOutcome> {
  let weights;
  try {
    weights = weightsFromForm(form);
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
  try {
    const r = await rpc.save(site, version, weights as Record<string, number>);
    return { kind: "saved", version: r.version, message: `Saved as version ${r.version}.` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/version_conflict/.test(msg)) return { kind: "error", message: msg };
    const cur = await rpc.read(site);
    return { kind: "conflict", version: cur.version, weights: cur.weights ?? {}, message: "Someone saved weights for this site meanwhile. The current values are shown; check them and save again." };
  }
}

export function FrameTimingWeightsCard({ rpc, site }: { rpc: WeightsRpc; site: string }) {
  const [version, setVersion] = useState<number | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ kind: "idle" | "loading" | "saving" | "error" | "saved" | "conflict"; message?: string }>({ kind: "loading" });

  const load = useCallback(async () => {
    setStatus({ kind: "loading" });
    try {
      const r = await rpc.read(site);
      setVersion(r.version);
      setForm(Object.fromEntries(Object.entries(r.weights ?? {}).map(([k, v]) => [k, String(v)])));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [rpc, site]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (version === null) return;
    setStatus({ kind: "saving" });
    const r = await submitWeights(rpc, site, version, form);
    if (r.kind === "saved") setVersion(r.version);
    if (r.kind === "conflict") {
      setVersion(r.version);
      setForm(Object.fromEntries(Object.entries(r.weights).map(([k, v]) => [k, String(v)])));
    }
    setStatus({ kind: r.kind, message: r.message });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Frame timing size weights ({site.toUpperCase()})</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">
          Used only for the Max-method estimate in Reports: unmeasured framing time is shared by pieces × weight. Leave a size blank if you
          have no figure; estimates that need it stay unavailable. Each save is a new version; older versions are kept unchanged.
        </p>
        <div className="flex flex-wrap gap-3">
          {WEIGHT_SIZES.map((s) => (
            <label key={s} className="flex flex-col gap-1">
              <span className="text-xs text-slate-500">{s}</span>
              <input
                inputMode="decimal"
                className="w-20 rounded border px-2 py-1 dark:bg-slate-900"
                value={form[s] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, [s]: e.target.value }))}
                aria-label={`Weight for ${s}`}
              />
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void save()} disabled={version === null || status.kind === "saving" || status.kind === "loading"}>
            Save new version
          </Button>
          <span className="text-xs text-slate-500">{version === null ? "" : version === 0 ? "No weights saved yet." : `Current version ${version}.`}</span>
        </div>
        {status.message ? (
          <div className={status.kind === "error" || status.kind === "conflict" ? "text-xs text-rose-700 dark:text-rose-300" : "text-xs text-emerald-700"} role={status.kind === "error" || status.kind === "conflict" ? "alert" : "status"}>
            {status.message}
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
