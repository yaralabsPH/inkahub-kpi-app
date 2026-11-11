import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Coins, Download } from "lucide-react";
import { useDataset } from "@/lib/hooks/useDataset";
import { Card, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { fmtMoney, fmtNum } from "@/lib/utils/format";
import { todayIso } from "@/lib/utils/dates";
import { downloadXlsx } from "@/lib/csv/xlsx";

/**
 * StockValue - shareable per-SKU breakdown of stock value.
 *
 *   value = current_on_hand * unit_cost
 *
 * Excludes shipments in transit (we only count what is physically on hand).
 * Includes zero-stock rows so the export is a complete catalogue snapshot
 * suitable for accountants / valuations.
 *
 * URL is shareable; the page re-fetches from the active location dataset
 * every time it mounts.
 */
export function StockValue() {
  const { data } = useDataset();
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"value" | "on_hand" | "code" | "unit_cost">("value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [hideZero, setHideZero] = useState(false);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.products.map((p) => {
      const unitCost = p.unit_cost ?? 0;
      const onHand = p.current_on_hand;
      return {
        id: p.id,
        code: p.code,
        size: p.size,
        colour: p.colour,
        supplier: p.supplier,
        on_hand: onHand,
        unit_cost: unitCost,
        value: onHand * unitCost,
      };
    });
  }, [data]);

  const filtered = useMemo(() => {
    let r = rows;
    if (supplierFilter !== "all") r = r.filter((x) => x.supplier === supplierFilter);
    if (hideZero) r = r.filter((x) => x.on_hand > 0);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((x) =>
        x.code.toLowerCase().includes(q) ||
        x.supplier.toLowerCase().includes(q) ||
        x.size.toLowerCase().includes(q) ||
        x.colour.toLowerCase().includes(q),
      );
    }
    const sorted = r.slice().sort((a, b) => {
      const ak = a[sortKey];
      const bk = b[sortKey];
      if (typeof ak === "number" && typeof bk === "number") {
        return sortDir === "asc" ? ak - bk : bk - ak;
      }
      const as = String(ak ?? "");
      const bs = String(bk ?? "");
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return sorted;
  }, [rows, supplierFilter, search, sortKey, sortDir, hideZero]);

  if (!data) return <div className="text-sm text-slate-500">Loading...</div>;

  const currency = data.settings.currency_symbol;
  const totalValue = filtered.reduce((s, r) => s + r.value, 0);
  const totalOnHand = filtered.reduce((s, r) => s + r.on_hand, 0);
  const zeroStockCount = filtered.filter((r) => r.on_hand === 0).length;
  const suppliers = Array.from(
    new Set(data.products.map((p) => p.supplier).filter(Boolean)),
  ).sort();

  const setSort = (k: "value" | "on_hand" | "code" | "unit_cost") => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "code" ? "asc" : "desc");
    }
  };
  const arrow = (k: string) =>
    sortKey === k ? (sortDir === "asc" ? " ^" : " v") : "";

  const exportXlsx = () => {
    downloadXlsx(`stock-value-${todayIso()}.xlsx`, [
      {
        name: "Stock value",
        headers: ["Code", "Size", "Colour", "Supplier", "On hand", "Unit cost", "Value"],
        rows: filtered.map((r) => [
          r.code,
          r.size,
          r.colour,
          r.supplier,
          r.on_hand,
          r.unit_cost,
          r.value,
        ]),
        columnWidths: [22, 16, 14, 22, 12, 12, 14],
      },
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 mb-1">
            <ArrowLeft size={12} /> Back to dashboard
          </Link>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Coins size={20} className="text-amber-600" /> Stock value
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-2xl">
            Per-SKU breakdown of stock value: <strong>current on hand x unit cost</strong>.
            Excludes shipments in transit. Includes 0-stock rows so this is a
            complete catalogue snapshot. URL is shareable.
          </p>
        </div>
        <Button onClick={exportXlsx} size="sm" variant="primary">
          <Download size={14} /> Export to Excel
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Total value" value={fmtMoney(totalValue, currency)} sub="sum of value column" />
        <SummaryTile label="Total on hand" value={fmtNum(totalOnHand)} sub="units across all rows" />
        <SummaryTile label="SKUs shown" value={fmtNum(filtered.length)} sub={`${zeroStockCount} with 0 stock`} />
        <SummaryTile label="Suppliers" value={fmtNum(new Set(filtered.map((r) => r.supplier)).size)} sub="in current filter" />
      </div>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 mb-1">Supplier</div>
              <Select value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)} className="w-48">
                <option value="all">All suppliers</option>
                {suppliers.map((s) => (<option key={s} value={s}>{s}</option>))}
              </Select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 mb-1">Search</div>
              <Input placeholder="Code, supplier, size, colour..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 pb-2">
              <input type="checkbox" checked={hideZero} onChange={(e) => setHideZero(e.target.checked)} />
              Hide 0-stock rows
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <Th onClick={() => setSort("code")}>Code{arrow("code")}</Th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Colour</th>
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <Th onClick={() => setSort("on_hand")} align="right">On hand{arrow("on_hand")}</Th>
                  <Th onClick={() => setSort("unit_cost")} align="right">Unit cost{arrow("unit_cost")}</Th>
                  <Th onClick={() => setSort("value")} align="right">Value{arrow("value")}</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.id}
                    className={"border-b border-slate-100 dark:border-slate-800 " + (r.on_hand === 0 ? "text-slate-400" : "")}>
                    <td className="px-3 py-2 font-medium">
                      <Link to={`/skus/${r.id}`} className="hover:underline">{r.code}</Link>
                    </td>
                    <td className="px-3 py-2">{r.size}</td>
                    <td className="px-3 py-2">{r.colour}</td>
                    <td className="px-3 py-2">{r.supplier}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.on_hand)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.unit_cost, currency)}</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtMoney(r.value, currency)}</td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-slate-500 italic">No SKUs match the filter.</td>
                  </tr>
                ) : null}
              </tbody>
              {filtered.length > 0 ? (
                <tfoot className="border-t-2 border-slate-300 dark:border-slate-700">
                  <tr>
                    <td className="px-3 py-2 font-semibold" colSpan={4}>Total ({filtered.length} SKUs)</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtNum(totalOnHand)}</td>
                    <td className="px-3 py-2"></td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold">{fmtMoney(totalValue, currency)}</td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function Th({
  children, onClick, align,
}: { children: React.ReactNode; onClick: () => void; align?: "right" }) {
  return (
    <th
      className={
        "px-3 py-2 font-medium cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-300 " +
        (align === "right" ? "text-right" : "")
      }
      onClick={onClick}>
      {children}
    </th>
  );
}

function SummaryTile({
  label, value, sub,
}: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</div>
        {sub ? <div className="text-[11px] text-slate-500 mt-0.5">{sub}</div> : null}
      </CardBody>
    </Card>
  );
}