import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, Maximize2 } from "lucide-react";
import { SideSheet } from "@/components/ui/SideSheet";
import { StatusPill } from "@/components/ui/StatusPill";
import { PRODUCT_TYPE_LABELS, shortCode, type Product } from "@/lib/domain";
import { useForecasts } from "@/lib/hooks/useForecasts";
import { useAuthOptional } from "@/lib/auth/AuthProvider";
import { allNavAccess, effectiveNavAccess } from "@/lib/auth/permissions";
import { fmtFloat, fmtNum } from "@/lib/utils/format";

const AVG_METHOD_LABEL: Record<string, string> = {
  trailing_8: "Trailing 8 weeks",
  trailing_12: "Trailing 12 weeks",
  weighted: "Weighted",
  manual: "Manual",
  selected_weeks: "Selected weeks",
};

function Prop({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="py-1 text-hub-muted">{k}</dt>
      <dd className="min-w-0 py-1 text-hub-text">{children}</dd>
    </>
  );
}

/**
 * Read-only side peek of one already-loaded SKU (wireframe skus.html peek).
 * No fetching, no saving: on hand is shown, not edited; changes stay in the
 * existing editors, the SKU page and Movements.
 */
export function SkuPeek({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const { byId } = useForecasts();
  const auth = useAuthOptional();
  const allowed = auth?.profile ? effectiveNavAccess(auth.profile) : allNavAccess();
  const r = product ? byId[product.id] : undefined;

  return (
    <SideSheet open={product !== null} title={product?.code ?? ""} onClose={onClose}>
      {product ? (
        <div className="space-y-5 text-[13.5px]">
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/skus/${product.id}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-hub border border-hub-line-2 bg-hub-panel px-2.5 text-[13px] text-hub-text hover:bg-hub-hover"
            >
              <Maximize2 size={14} aria-hidden="true" /> Open as page
            </Link>
            {allowed.has("movements") ? (
              <Link
                to="/movements"
                className="inline-flex h-8 items-center gap-1.5 rounded-hub border border-hub-line-2 bg-hub-panel px-2.5 text-[13px] text-hub-text hover:bg-hub-hover"
              >
                <ArrowLeftRight size={14} aria-hidden="true" /> Adjust stock in Movements
              </Link>
            ) : null}
          </div>

          <dl className="grid grid-cols-[150px_1fr] gap-x-3">
            <Prop k="Short code"><span className="font-mono text-xs">{shortCode(product)}</span></Prop>
            <Prop k="Size · colour">{product.size || "—"} · {product.colour || "—"}</Prop>
            <Prop k="Type">{PRODUCT_TYPE_LABELS[product.product_type ?? "product"] ?? product.product_type}</Prop>
            <Prop k="Supplier">{product.supplier}</Prop>
            <Prop k="On hand">
              <span className="tabular-nums">{fmtNum(product.current_on_hand)}</span>
              <span className="ml-2 text-xs text-hub-muted">read-only here</span>
            </Prop>
            <Prop k="Lead time">{product.lead_time_days} days</Prop>
            <Prop k="Safety stock">{product.safety_stock_pct ?? 100}% of weekly demand</Prop>
            <Prop k="Min order · increment">{fmtNum(product.min_order_qty)} · {fmtNum(product.order_increment ?? 1)}</Prop>
            <Prop k="Average method">{AVG_METHOD_LABEL[product.weekly_avg_method] ?? product.weekly_avg_method}</Prop>
            <Prop k="Avg / week">{r ? fmtFloat(r.weeklyAverage, 1) : "—"}</Prop>
            <Prop k="Weeks left">{r ? (r.weeksUntilOosCurrent == null ? "52+" : `${fmtFloat(r.weeksUntilOosCurrent, 1)}w`) : "—"}</Prop>
            <Prop k="Status">{r ? <StatusPill status={r.status} /> : "—"}</Prop>
            <Prop k="Components">
              {(product.components ?? []).length === 0
                ? "None"
                : `${product.components.length} component${product.components.length === 1 ? "" : "s"} (edit on the SKU page)`}
            </Prop>
          </dl>

          {product.notes ? (
            <div>
              <h3 className="mb-1 text-[13px] font-semibold">Notes</h3>
              <p className="whitespace-pre-wrap text-hub-muted">{product.notes}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </SideSheet>
  );
}
