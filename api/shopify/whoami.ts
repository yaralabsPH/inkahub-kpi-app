/**
 * Diagnostic: report what the current SHOPIFY_ADMIN_TOKEN can do.
 * Hits /admin/oauth/access_scopes.json + /admin/api/.../shop.json.
 * No PII, safe to view. Returns:
 *   - shop domain + name
 *   - list of scopes the token holds
 *   - whether read_all_orders is granted
 */
interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
}

const SHOPIFY_API_VERSION = "2024-04";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !apiToken) {
    res.status(500).json({
      error: "SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN not set in Vercel env vars.",
    });
    return;
  }
  const tokenPreview = `${apiToken.slice(0, 8)}... (len ${apiToken.length})`;

  const results: Record<string, unknown> = { token_preview: tokenPreview, shop_domain: shop };
  try {
    const scopesRes = await fetch(
      `https://${shop}/admin/oauth/access_scopes.json`,
      { headers: { "X-Shopify-Access-Token": apiToken } },
    );
    const scopesBody = await scopesRes.json() as {
      access_scopes?: Array<{ handle: string }>;
    };
    const scopes = (scopesBody.access_scopes ?? []).map((s) => s.handle);
    results.scopes = scopes;
    results.has_read_orders = scopes.includes("read_orders") || scopes.includes("write_orders");
    results.has_read_all_orders = scopes.includes("read_all_orders");
    results.scopes_status = scopesRes.status;
  } catch (e) {
    results.scopes_error = e instanceof Error ? e.message : String(e);
  }

  try {
    const shopRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      { headers: { "X-Shopify-Access-Token": apiToken } },
    );
    const shopBody = await shopRes.json() as {
      shop?: { name: string; email: string; plan_name: string; myshopify_domain: string };
    };
    if (shopBody.shop) {
      results.shop_name = shopBody.shop.name;
      results.shop_plan = shopBody.shop.plan_name;
      results.shop_myshopify_domain = shopBody.shop.myshopify_domain;
    }
    results.shop_status = shopRes.status;
  } catch (e) {
    results.shop_error = e instanceof Error ? e.message : String(e);
  }

  results.next_steps = {
    if_has_read_all_orders: "Great - scope is enabled. If old orders still 404, the issue is elsewhere. Retest #10157677.",
    if_missing_read_all_orders: "Enable read_all_orders on this app. See instructions returned by /api/shopify/whoami?help=1 (or ask your dev).",
    if_no_shop_returned: "Token is invalid or revoked. Regenerate.",
  };

  res.status(200).json(results);
}