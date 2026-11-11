/**
 * GET /api/dropbox/artwork-image?sku=INKA-KAN0566-A4-FB
 *
 * Three-tier lookup:
 *
 *   1. Check artwork_images cache in Supabase. If a fresh signed URL is
 *      stored, return it (~30ms).
 *   2. If the cache has the path but the URL is stale (or never set),
 *      call get_temporary_link directly on the known path, update the
 *      cache, return (~300ms).
 *   3. If nothing is cached, do the full Dropbox search, get the URL,
 *      populate the cache for next time, return (~600-1000ms).
 *
 * Self-healing: if get_temporary_link returns 409 (path moved/renamed),
 * we drop the stale cache row and fall through to search.
 *
 * Env (server-side only):
 *   DROPBOX_ACCESS_TOKEN
 *   DROPBOX_IMAGE_FOLDER
 *
 * Auth: Supabase Bearer JWT. The same JWT is forwarded to Supabase queries,
 * so RLS works correctly. Cache writes go through a SECURITY DEFINER RPC.
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

/**
 * Derive the expected filename PREFIX (without .jpg/.png) from a v6 SKU.
 * Returns null when no image is expected (gift cards, picture-frame-only,
 * AUX-other).
 *   INKA-KAN0566-A4-FB        -> "INKA-KAN0566"
 *   INKA-S3WIL0049-A2-FN      -> "INKA-S3-WIL0049-01"
 *   INKA-AUX-FP-ESP-A2        -> "INKA-AUX-FP-ESP"
 */
function queryFromSku(rawSku: string): string | null {
  const sku = rawSku.trim().toUpperCase();
  if (!sku.startsWith("INKA-")) return null;

  let m = /^INKA-AUX-FP-([A-Z]{2,3})-(A[0-4]|GW)$/.exec(sku);
  if (m) return `INKA-AUX-FP-${m[1]}`;

  if (sku.startsWith("INKA-AUX-")) return null;
  if (/^INKA-GC\d{4}-\d+$/.test(sku)) return null;
  if (/^INKA-PF\d{4}-/.test(sku)) return null;

  m = /^INKA-S(\d)([A-Z]{2,3})(\d{4})-/.exec(sku);
  if (m) return `INKA-S${m[1]}-${m[2]}${m[3]}-01`;

  m = /^INKA-([A-Z]{2,3})(\d{4})-/.exec(sku);
  if (m) return `INKA-${m[1]}${m[2]}`;

  return null;
}

/** "INKA-KAN0566" -> "KAN0566" (the cache primary key). */
function artworkCodeFromQuery(query: string): string {
  return query.startsWith("INKA-") ? query.slice(5) : query;
}

/** ~3.5 hours - signed URLs are good for ~4h; refresh with a 30min buffer. */
const URL_TTL_MS = Math.floor(3.5 * 60 * 60 * 1000);
/** Don't serve a URL that's about to expire. */
const URL_SAFETY_BUFFER_MS = 5 * 60 * 1000;

async function callDropboxGetTempLink(
  token: string,
  path: string,
): Promise<{ ok: true; link: string } | { ok: false; status: number; detail: string }> {
  const r = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  if (r.status === 409 || r.status === 404) {
    const detail = await r.text();
    return { ok: false, status: r.status, detail: detail.slice(0, 300) };
  }
  if (!r.ok) {
    const detail = await r.text();
    return { ok: false, status: r.status, detail: detail.slice(0, 300) };
  }
  const body = (await r.json()) as { link?: string };
  if (!body.link) {
    return { ok: false, status: 502, detail: "Dropbox response missing link" };
  }
  return { ok: true, link: body.link };
}

async function searchDropbox(
  token: string,
  folder: string,
  query: string,
): Promise<{ ok: true; path: string; name: string } | { ok: false; detail: string }> {
  const r = await fetch("https://api.dropboxapi.com/2/files/search_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      options: {
        path: folder,
        max_results: 20,
        file_status: "active",
        filename_only: true,
      },
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    return { ok: false, detail: `Search HTTP ${r.status}: ${detail.slice(0, 200)}` };
  }
  const body = (await r.json()) as {
    matches?: Array<{
      metadata?: { metadata?: { name?: string; path_lower?: string } };
    }>;
  };
  const candidates = (body.matches ?? [])
    .map((m) => m.metadata?.metadata)
    .filter((m): m is { name: string; path_lower: string } =>
      !!m && typeof m.name === "string" && typeof m.path_lower === "string",
    );
  if (candidates.length === 0) {
    return { ok: false, detail: `No matches for "${query}"` };
  }
  const wanted = query.toUpperCase();
  const strict = candidates.filter((c) => {
    const n = c.name.toUpperCase();
    return (
      n === wanted ||
      n.startsWith(`${wanted}.`) ||
      n.startsWith(`${wanted} `) ||
      n.startsWith(`${wanted}(`)
    );
  });
  const pool = strict.length > 0 ? strict : candidates;
  const jpg = pool.find((c) => c.name.toLowerCase().endsWith(".jpg"));
  const png = pool.find((c) => c.name.toLowerCase().endsWith(".png"));
  const best = jpg ?? png ?? pool[0];
  return { ok: true, path: best.path_lower, name: best.name };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // ---- Auth ----
  const authHeader = req.headers["authorization"] ?? req.headers["Authorization"];
  if (!authHeader) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!bearer?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const userToken = bearer.slice(7).trim();
  if (!userToken) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseAnon =
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    res.status(500).json({ error: "Supabase env vars not configured" });
    return;
  }
  // Build a Supabase client that forwards the user's JWT on every request -
  // RLS and SECURITY DEFINER functions both authorize correctly.
  const supabase = createClient(supabaseUrl, supabaseAnon, {
    global: {
      headers: {
        apikey: supabaseAnon,
        Authorization: `Bearer ${userToken}`,
      },
    },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: authErr } = await supabase.auth.getUser(userToken);
  if (authErr || !userData?.user) {
    res.status(401).json({ error: "Invalid session", detail: authErr?.message });
    return;
  }

  // ---- Env ----
  const dropboxToken = process.env.DROPBOX_ACCESS_TOKEN;
  const folder = process.env.DROPBOX_IMAGE_FOLDER;
  if (!dropboxToken || !folder) {
    res.status(500).json({ error: "Dropbox env vars not configured" });
    return;
  }
  const cleanFolder = folder.replace(/\/$/, "");

  // ---- Input ----
  const skuInput = req.query.sku;
  const sku = Array.isArray(skuInput) ? skuInput[0] : skuInput;
  if (!sku || typeof sku !== "string") {
    res.status(400).json({ error: "Missing ?sku=... query parameter" });
    return;
  }
  const query = queryFromSku(sku);
  if (!query) {
    res.status(404).json({
      error: "No artwork image expected for this SKU",
      sku,
      reason: "Gift cards / picture-frame-only / AUX-other do not have images.",
    });
    return;
  }
  const artworkCode = artworkCodeFromQuery(query);

  // ---- Tier 1: Supabase cache lookup ----
  const cacheRes = await supabase
    .from("artwork_images")
    .select("dropbox_path, cached_url, cached_url_expires_at")
    .eq("artwork_code", artworkCode)
    .maybeSingle();

  if (cacheRes.data) {
    const cached = cacheRes.data as {
      dropbox_path: string;
      cached_url: string | null;
      cached_url_expires_at: string | null;
    };
    const expiresAt = cached.cached_url_expires_at
      ? new Date(cached.cached_url_expires_at).getTime()
      : 0;
    const safeUntil = Date.now() + URL_SAFETY_BUFFER_MS;

    if (cached.cached_url && expiresAt > safeUntil) {
      // Tier 1 hit: fresh URL, ship it.
      res.status(200).json({
        sku,
        artwork_code: artworkCode,
        path: cached.dropbox_path,
        url: cached.cached_url,
        source: "cache_fresh",
      });
      return;
    }

    // Tier 2: cache has path, URL needs refresh. Skip search.
    const linkRes = await callDropboxGetTempLink(dropboxToken, cached.dropbox_path);
    if (linkRes.ok) {
      const newExpires = new Date(Date.now() + URL_TTL_MS).toISOString();
      await supabase.rpc("upsert_artwork_image_cache", {
        p_artwork_code: artworkCode,
        p_dropbox_path: cached.dropbox_path,
        p_cached_url: linkRes.link,
        p_expires_at: newExpires,
      });
      res.status(200).json({
        sku,
        artwork_code: artworkCode,
        path: cached.dropbox_path,
        url: linkRes.link,
        source: "cache_refresh",
      });
      return;
    }
    // Self-healing: 404/409 means the path is stale. Drop and fall through
    // to a fresh search.
    if (linkRes.status === 404 || linkRes.status === 409) {
      await supabase.rpc("delete_artwork_image_cache", {
        p_artwork_code: artworkCode,
      });
    } else {
      res.status(502).json({
        error: "Dropbox temp link failed on cached path",
        detail: linkRes.detail,
      });
      return;
    }
  }

  // ---- Tier 3: full Dropbox search ----
  const searchRes = await searchDropbox(dropboxToken, cleanFolder, query);
  if (!searchRes.ok) {
    res.status(404).json({
      error: "Artwork file not found in Dropbox",
      sku,
      searchedFor: query,
      folder: cleanFolder,
      detail: searchRes.detail,
    });
    return;
  }
  const linkRes = await callDropboxGetTempLink(dropboxToken, searchRes.path);
  if (!linkRes.ok) {
    res.status(502).json({
      error: "Dropbox temp link failed after search",
      detail: linkRes.detail,
    });
    return;
  }
  const newExpires = new Date(Date.now() + URL_TTL_MS).toISOString();
  // Best-effort cache write; don't fail the request if it doesn't persist.
  await supabase
    .rpc("upsert_artwork_image_cache", {
      p_artwork_code: artworkCode,
      p_dropbox_path: searchRes.path,
      p_cached_url: linkRes.link,
      p_expires_at: newExpires,
    })
    .then(() => null)
    .catch(() => null);

  res.status(200).json({
    sku,
    artwork_code: artworkCode,
    filename: searchRes.name,
    path: searchRes.path,
    url: linkRes.link,
    source: "search",
  });
}