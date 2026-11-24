import { shortCode, type Product } from "@/lib/domain";

/**
 * Local filter for the Movements SKU picker. Matches the product code or its
 * short code, case-insensitively, after trimming the query. An empty query
 * keeps every product in the input order. Pure: never mutates or selects.
 */
export function filterProductsForPicker(products: readonly Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return products.slice();
  return products.filter((p) => p.code.toLowerCase().includes(q) || shortCode(p).toLowerCase().includes(q));
}
