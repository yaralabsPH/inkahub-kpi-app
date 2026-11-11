/**
 * GET /api/shopify/install-start?shop=inka-arthouse.myshopify.com
 *
 * Kicks off the Shopify OAuth install flow. Generates a random `state` for
 * CSRF protection, sets it as an HttpOnly cookie, then 302-redirects the
 * browser to Shopify's authorize endpoint. After the merchant approves the
 * scopes, Shopify calls `/api/shopify/install-callback` (a sibling file).
 *
 * This endpoint is used ONCE per install. Once we have the offline access
 * token saved in Vercel env, we never call it again.
 *
 * Required env (server-side, no VITE_ prefix):
 *   SHOPIFY_CLIENT_ID       Client ID from your Shopify Partners app
 *
 * The redirect URL is computed from req.headers.host, so this works in
 * preview deploys (each preview URL) and production without code change.
 * BUT every URL the redirect can land on must be allowlisted in your
 * Partners app's Allowed Redirect URLs configuration.
 */

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  send(body: string): void;
  setHeader(name: string, value: string | string[]): void;
  end(): void;
}

const SCOPES = "read_orders,read_customers,read_fulfillments,read_shipping";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }
  const shopRaw = req.query.shop;
  const shop = Array.isArray(shopRaw) ? shopRaw[0] : shopRaw;
  if (!shop || typeof shop !== "string" || !/^[a-z0-9-]+\.myshopify\.com$/i.test(shop)) {
    res.status(400).send(
      `Missing or invalid 'shop' query param. Expected something like inka-arthouse.myshopify.com.`,
    );
    return;
  }
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    res.status(500).send("SHOPIFY_CLIENT_ID env var not set on Vercel.");
    return;
  }
  const state = randomToken(24);
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (!host) {
    res.status(500).send("Couldn't determine request host.");
    return;
  }
  const redirectUri = `https://${host}/api/shopify/install-callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      scope: SCOPES,
      redirect_uri: redirectUri,
      state,
      "grant_options[]": "",
    }).toString();

  res.setHeader(
    "Set-Cookie",
    `shopify_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
  );
  res.setHeader("Location", authUrl);
  res.status(302).end();
}

function randomToken(bytes: number): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const arr = new Uint8Array(bytes);
    g.crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
