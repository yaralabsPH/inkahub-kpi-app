/**
 * GET /api/shopify/install-callback?code=...&shop=...&state=...&hmac=...
 *
 * Shopify redirects the merchant's browser here after they approve the
 * install. We:
 *   1. Verify the HMAC signature on the query params.
 *   2. Verify the `state` matches the cookie we set in install-start.
 *   3. Exchange the one-time `code` for a long-lived offline access token.
 *   4. Display the token in a styled HTML page for the operator to copy.
 *
 * The token is shown only on this page. We do NOT log it server-side and
 * do NOT persist it. The operator copies -> pastes into Vercel env vars
 * (SHOPIFY_ADMIN_TOKEN) -> the token is then read from process.env by
 * /api/shopify/order.ts for every Fetch button click.
 *
 * Required env (server-side, no VITE_ prefix):
 *   SHOPIFY_CLIENT_ID
 *   SHOPIFY_CLIENT_SECRET
 */

import { createHmac, timingSafeEqual } from "crypto";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  send(body: string): void;
  setHeader(name: string, value: string | string[]): void;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res
      .status(500)
      .send("SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET env var not set on Vercel.");
    return;
  }

  const q = flattenQuery(req.query);
  const { code, shop, state, hmac, host } = q;
  if (!code || !shop || !state || !hmac) {
    res
      .status(400)
      .send(htmlError(
        "Invalid callback",
        "Shopify didn't include all required parameters. Try the install again from the start.",
      ));
    return;
  }
  if (!/^[a-z0-9-]+\.myshopify\.com$/i.test(shop)) {
    res.status(400).send(htmlError("Invalid shop domain", `Got: ${shop}`));
    return;
  }

  const sigParams = Object.entries(q)
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const computed = createHmac("sha256", clientSecret).update(sigParams).digest("hex");
  if (!timingSafeEq(computed, hmac)) {
    res.status(401).send(htmlError(
      "HMAC verification failed",
      "The callback signature didn't match. This could mean the URL was tampered with or your SHOPIFY_CLIENT_SECRET env var is wrong.",
    ));
    return;
  }

  const cookieHeader = (Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie) || "";
  const cookies = parseCookies(cookieHeader);
  const expectedState = cookies["shopify_oauth_state"];
  if (!expectedState || !timingSafeEq(expectedState, state)) {
    res.status(401).send(htmlError(
      "State mismatch",
      "The OAuth state cookie didn't match. Try the install again - start by visiting /api/shopify/install-start in the same browser session that completes the approval.",
    ));
    return;
  }

  let tokenJson: { access_token?: string; scope?: string };
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      res.status(502).send(htmlError(
        `Shopify token exchange returned HTTP ${tokenRes.status}`,
        text.slice(0, 500),
      ));
      return;
    }
    tokenJson = await tokenRes.json();
  } catch (e) {
    res.status(502).send(htmlError(
      "Couldn't reach Shopify",
      e instanceof Error ? e.message : String(e),
    ));
    return;
  }

  if (!tokenJson.access_token) {
    res.status(502).send(htmlError(
      "Shopify didn't return an access token",
      JSON.stringify(tokenJson),
    ));
    return;
  }

  res.setHeader(
    "Set-Cookie",
    "shopify_oauth_state=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure",
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.status(200).send(htmlSuccess(shop, tokenJson.access_token, tokenJson.scope ?? "(unknown)", host));
}

function flattenQuery(q: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

function htmlError(title: string, detail: string | undefined): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;padding:48px;max-width:640px;margin:auto;color:#0f172a}
  h1{color:#b91c1c}
  pre{background:#f1f5f9;padding:12px;border-radius:6px;overflow:auto;font-size:12px}
</style></head>
<body>
  <h1>${escape(title)}</h1>
  ${detail ? `<pre>${escape(detail)}</pre>` : ""}
  <p>Close this tab and try again from <code>/api/shopify/install-start?shop=YOUR-SHOP.myshopify.com</code>.</p>
</body></html>`;
}

function htmlSuccess(shop: string, token: string, scope: string, host: string | undefined): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Shopify install complete</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;padding:48px 24px;max-width:720px;margin:auto;color:#0f172a;background:#f8fafc}
  h1{margin:0 0 8px;color:#059669}
  p{line-height:1.55;color:#334155}
  code{background:#e2e8f0;padding:2px 5px;border-radius:3px;font-size:13px}
  .token-box{background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:16px;margin:20px 0;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.5}
  button{font-family:inherit;font-size:14px;padding:8px 16px;background:#0f172a;color:#fff;border:none;border-radius:6px;cursor:pointer}
  button:hover{background:#1e293b}
  .copied{background:#059669!important}
  details{margin-top:24px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:12px 16px}
  summary{cursor:pointer;font-weight:600}
  ol{padding-left:18px}
  ol li{margin:6px 0}
  .warn{background:#fef3c7;border:1px solid #fcd34d;padding:12px;border-radius:6px;margin:16px 0;font-size:13px;color:#78350f}
</style></head>
<body>
  <h1>Install successful</h1>
  <p>Inka Stock Hub is now installed on <code>${escape(shop)}</code>. Shopify returned the offline access token below.</p>

  <div class="warn">
    <strong>Save this token now - you can't view it again.</strong>
    Copy it and paste it into your Vercel environment variables as <code>SHOPIFY_ADMIN_TOKEN</code>.
    If you lose it, you'll need to uninstall + reinstall the app.
  </div>

  <div class="token-box" id="token">${escape(token)}</div>
  <button id="copy" type="button" onclick="copy()">Copy token</button>

  <details>
    <summary>Next steps</summary>
    <ol>
      <li>Vercel - your project - <strong>Settings</strong> - <strong>Environment Variables</strong>.</li>
      <li>Add <code>SHOPIFY_ADMIN_TOKEN</code> = the token above (Production + Preview).</li>
      <li>Add <code>SHOPIFY_SHOP_DOMAIN</code> = <code>${escape(shop)}</code> (if not already set).</li>
      <li>Redeploy: <code>vercel --prod</code>.</li>
      <li>Open the live app, scan an order on the /production page.</li>
    </ol>
  </details>

  <details>
    <summary>Other details</summary>
    <p>Granted scopes: <code>${escape(scope)}</code></p>
    ${host ? `<p>Install host: <code>${escape(host)}</code></p>` : ""}
  </details>

<script>
  function copy() {
    const t = document.getElementById('token').textContent;
    navigator.clipboard.writeText(t).then(() => {
      const b = document.getElementById('copy');
      b.textContent = 'Copied!';
      b.classList.add('copied');
      setTimeout(() => { b.textContent = 'Copy token'; b.classList.remove('copied'); }, 2000);
    });
  }
</script>
</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
