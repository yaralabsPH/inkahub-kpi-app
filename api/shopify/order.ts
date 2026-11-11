/**
 * GET /api/shopify/order?order_number=10186629
 *
 * Vercel serverless function. Looks up a Shopify order by name and returns
 * the fields the "Fetch from Shopify" button on the CS Cases page wants to
 * autofill: customer name + email, date ordered, admin URL, and the original
 * delivery carrier (from the first fulfillment's tracking info).
 *
 * Auth: requires a valid Supabase Bearer JWT in `Authorization`. This is
 * essential — without it, anyone who guesses the URL could enumerate our
 * orders and burn through Shopify's API rate-limit budget.
 *
 * Server-side env vars (no VITE_ prefix — these must NOT ship to the
 * browser bundle):
 *   SHOPIFY_SHOP_DOMAIN   "inka-arthouse.myshopify.com"
 *   SHOPIFY_ADMIN_TOKEN   the `shpat_...` Admin API access token obtained
 *                         via the OAuth install flow (install-start +
 *                         install-callback endpoints).
 *
 * Reuses VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (already present in
 * Vercel from the frontend build) for JWT verification.
 */

import { createClient } from "@supabase/supabase-js";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

const SHOPIFY_API_VERSION = "2024-04";

const ORDER_QUERY = `
  query FindOrder($q: String!) {
    orders(first: 1, query: $q) {
      edges {
        node {
          id
          name
          legacyResourceId
          createdAt
          cancelledAt
          cancelReason
          tags
          customer { firstName lastName email }
          fulfillments(first: 1) {
            trackingInfo { company }
          }
          lineItems(first: 50) {
            edges {
              node {
                sku
                title
                quantity
                currentQuantity
                variantTitle
              }
            }
          }
        }
      }
    }
  }
`;

interface ShopifyOrderNode {
  id: string;
  name: string;
  legacyResourceId: string;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  tags: string[];
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  fulfillments: Array<{ trackingInfo: Array<{ company: string | null }> }>;
  lineItems: {
    edges: Array<{
      node: { sku: string | null; title: string | null; quantity: number; currentQuantity: number | null; variantTitle: string | null };
    }>;
  };
}

interface ShopifyGraphQLResponse {
  data?: {
    orders?: {
      edges?: Array<{ node: ShopifyOrderNode }>;
    };
  };
  errors?: Array<{ message: string }>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // ---- 1. Auth ----
  const authHeader = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!authHeader) {
    res.status(401).json({
      error: "Missing bearer token",
      detail: "No Authorization header on the request. If you're seeing this on the deployed app, check Network tab -> Headers -> Request Headers to confirm the header was actually sent. If missing, the client's Supabase session is null or stale.",
    });
    return;
  }
  const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!bearer?.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Missing bearer token",
      detail: `Authorization header present but not Bearer-prefixed. Received: "${String(bearer).slice(0, 40)}..."`,
    });
    return;
  }
  const token = bearer.slice(7).trim();
  if (!token) {
    res.status(401).json({
      error: "Missing bearer token",
      detail: "Authorization header has 'Bearer ' prefix but no token after it.",
    });
    return;
  }
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnon =
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    res.status(500).json({ error: "Supabase env vars not configured on the server" });
    return;
  }
  const supabase = createClient(supabaseUrl, supabaseAnon);
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) {
    res.status(401).json({
      error: "Invalid session",
      detail: authErr?.message ?? "supabase.auth.getUser() returned no user object",
    });
    return;
  }

  // ---- 2. Shopify config ----
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !apiToken) {
    res.status(500).json({
      error:
        "Shopify integration not configured. Add SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN to Vercel env vars. The token comes from completing the OAuth install flow at /api/shopify/install-start.",
    });
    return;
  }

  // ---- 3. Input ----
  const orderRaw = req.query.order_number;
  const orderInput = Array.isArray(orderRaw) ? orderRaw[0] : orderRaw;
  if (!orderInput || typeof orderInput !== "string") {
    res.status(400).json({ error: "Missing order_number query param" });
    return;
  }
  const trimmed = orderInput.trim().replace(/^#+/, "");
  if (!/^\d+$/.test(trimmed)) {
    res.status(400).json({ error: "Order number should be numeric, e.g. 10186629" });
    return;
  }
  const searchQuery = `name:#${trimmed} status:any`;

  // ---- 4. Shopify call ----
  try {
    const shopifyRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": apiToken,
        },
        body: JSON.stringify({ query: ORDER_QUERY, variables: { q: searchQuery } }),
      },
    );
    if (!shopifyRes.ok) {
      const text = await shopifyRes.text();
      res.status(502).json({
        error: `Shopify API returned HTTP ${shopifyRes.status}`,
        detail: text.slice(0, 500),
      });
      return;
    }
    const body = (await shopifyRes.json()) as ShopifyGraphQLResponse;
    if (body.errors?.length) {
      res.status(502).json({
        error: "Shopify GraphQL error",
        detail: body.errors.map((e) => e.message).join("; "),
      });
      return;
    }
    let node = body.data?.orders?.edges?.[0]?.node;

    // ---- REST fallback for old / archived orders ----
    // Shopify's GraphQL search index doesn't reliably return orders
    // older than ~60-90 days. Try multiple REST strategies before
    // giving up; the first one that returns a match wins.
    const restStrategies: Array<{ label: string; qs: string }> = [
      { label: "name=#N",       qs: `name=${encodeURIComponent("#" + trimmed)}&status=any&limit=1` },
      { label: "name=N",        qs: `name=${encodeURIComponent(trimmed)}&status=any&limit=1` },
      { label: "order_number",  qs: `status=any&limit=250` }, // paged sweep - last resort
    ];
    const restDiagnostics: Array<{ strategy: string; hits: number; status: number }> = [];
    if (!node) {
      for (const strat of restStrategies) {
        try {
          const restUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?${strat.qs}`;
          const restRes = await fetch(restUrl, {
            headers: { "X-Shopify-Access-Token": apiToken },
          });
          restDiagnostics.push({ strategy: strat.label, hits: 0, status: restRes.status });
          if (!restRes.ok) continue;
          const restBody = await restRes.json() as {
            orders?: Array<{
              id: number | string;
              name: string;
              created_at: string;
              cancelled_at: string | null;
              cancel_reason: string | null;
              tags: string | string[] | null;
              customer: { first_name: string | null; last_name: string | null; email: string | null } | null;
              fulfillments: Array<{ tracking_company: string | null }>;
              line_items: Array<{
                sku: string | null;
                title: string | null;
                quantity: number;
                current_quantity?: number;
                variant_title: string | null;
              }>;
            }>;
          };
          const orders = restBody.orders ?? [];
          restDiagnostics[restDiagnostics.length - 1].hits = orders.length;
          // For the sweep strategy, filter client-side by order_number
          // matching the trimmed input. For name-based strategies,
          // Shopify already narrowed to <=1 result.
          let rest = orders[0];
          if (strat.label === "order_number") {
            const target = Number(trimmed);
            rest = orders.find((o) => Number((o as { order_number?: number }).order_number) === target);
          }
          if (rest) {
            // Reshape REST -> GraphQL node shape so the rest of the
            // handler works unchanged.
            const tagsArr: string[] = Array.isArray(rest.tags)
              ? rest.tags
              : typeof rest.tags === "string" && rest.tags.length > 0
                ? rest.tags.split(",").map((t: string) => t.trim())
                : [];
            node = {
              id: String(rest.id),
              name: rest.name,
              legacyResourceId: String(rest.id),
              createdAt: rest.created_at,
              cancelledAt: rest.cancelled_at,
              cancelReason: rest.cancel_reason,
              tags: tagsArr,
              customer: rest.customer
                ? {
                    firstName: rest.customer.first_name,
                    lastName:  rest.customer.last_name,
                    email:     rest.customer.email,
                  }
                : null,
              fulfillments: (rest.fulfillments ?? []).map((f) => ({
                trackingInfo: [{ company: f.tracking_company ?? null }],
              })),
              lineItems: {
                edges: (rest.line_items ?? []).map((l) => ({
                  node: {
                    sku: l.sku,
                    title: l.title,
                    quantity: l.quantity,
                    currentQuantity: typeof l.current_quantity === "number" ? l.current_quantity : null,
                    variantTitle: l.variant_title,
                  },
                })),
              },
            } as ShopifyOrderNode;
          }
        } catch (restErr) {
          // eslint-disable-next-line no-console
          console.warn("REST fallback strategy failed:", strat.label, restErr);
          continue;
        }
        if (node) break; // Found via this strategy - stop trying.
      }
    }

    if (!node) {
      res.status(404).json({
        error: `Order #${trimmed} not found in Shopify (checked GraphQL + REST strategies).`,
        found: false,
        rest_diagnostics: restDiagnostics,
        hint: "If this order exists in Shopify admin, verify: (1) the SHOPIFY_ADMIN_TOKEN has read_orders scope for orders older than 60 days (Shopify may require read_all_orders for archived data), (2) the order number matches the display name exactly, (3) the order is in this shop (not a duplicate store).",
      });
      return;
    }

    const firstName = node.customer?.firstName ?? "";
    const lastName = node.customer?.lastName ?? "";
    const customerName = `${firstName} ${lastName}`.trim() || null;
    const customerEmail = node.customer?.email ?? null;
    const dateOrdered = node.createdAt ? node.createdAt.slice(0, 10) : null;
    const adminUrl = `https://${shop}/admin/orders/${node.legacyResourceId}`;
    const carrier = node.fulfillments?.[0]?.trackingInfo?.[0]?.company ?? null;

    const lineItems = (node.lineItems?.edges ?? [])
      .map((e) => e.node)
      .map((n) => {
        // Prefer currentQuantity (remaining after refunds). When a line
        // is fully refunded/removed in Shopify, currentQuantity drops to
        // 0 while the original quantity stays at the placed value. Using
        // currentQuantity here makes removed lines drop out via the
        // > 0 filter below, so they never reach Production / CS.
        const effectiveQty = typeof n.currentQuantity === "number"
          ? n.currentQuantity
          : (Number.isFinite(n.quantity) ? n.quantity : 0);
        return {
          sku: (n.sku ?? "").trim() || null,
          title: (n.title ?? "").trim() || null,
          quantity: effectiveQty,
          variant_title: (n.variantTitle ?? "").trim() || null,
        };
      })
      .filter((l) => l.quantity > 0);

    res.status(200).json({
      found: true,
      order_name: node.name,
      customer_name: customerName,
      customer_email: customerEmail,
      date_ordered: dateOrdered,
      shopify_order_url: adminUrl,
      original_carrier: carrier,
      cancelled_at: node.cancelledAt ?? null,
      cancel_reason: node.cancelReason ?? null,
      tags: Array.isArray(node.tags) ? node.tags : [],
      line_items: lineItems,
    });
  } catch (e) {
    res.status(502).json({
      error: "Couldn't reach Shopify",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
