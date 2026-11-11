import { useEffect, useState } from "react";
import { Image as ImageIcon } from "lucide-react";
import { getSupabase } from "@/lib/repository/supabase/client";

interface ProductImageProps {
  sku: string;
  size?: number;
  className?: string;
}

/**
 * Kiosk-friendly artwork thumbnail. Asks /api/dropbox/artwork-image for a
 * 4-hour signed URL, caches the result in sessionStorage so re-scans don't
 * re-hit Dropbox, and shows a placeholder while loading or a generic icon
 * if the artwork isn't found (PF / GC / AUX-other / file not yet renamed).
 */
export function ProductImage({ sku, size = 48, className = "" }: ProductImageProps) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const cacheKey = `dropbox_img:${sku}`;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached === "__missing__") {
        setState("error");
        return;
      }
      if (cached) {
        setUrl(cached);
        setState("loaded");
        return;
      }
    } catch {
      /* sessionStorage disabled - re-fetch is safe */
    }

    let cancelled = false;
    (async () => {
      const supabase = getSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      const t = session?.access_token;
      if (!t) {
        if (!cancelled) setState("error");
        return;
      }
      try {
        const r = await fetch(
          `/api/dropbox/artwork-image?sku=${encodeURIComponent(sku)}`,
          { headers: { Authorization: `Bearer ${t}` } },
        );
        if (cancelled) return;
        if (!r.ok) {
          try { sessionStorage.setItem(cacheKey, "__missing__"); } catch { /* ignore */ }
          setState("error");
          return;
        }
        const body = (await r.json()) as { url?: string };
        if (!body.url) {
          try { sessionStorage.setItem(cacheKey, "__missing__"); } catch { /* ignore */ }
          setState("error");
          return;
        }
        try { sessionStorage.setItem(cacheKey, body.url); } catch { /* ignore */ }
        setUrl(body.url);
        setState("loaded");
      } catch {
        if (!cancelled) setState("error");
      }
    })();

    return () => { cancelled = true; };
  }, [sku]);

  const baseCls =
    "shrink-0 rounded-md ring-1 ring-slate-200 dark:ring-slate-700 overflow-hidden bg-slate-100 dark:bg-slate-800 ";
  if (state === "loading") {
    return (
      <div
        style={{ width: size, height: size }}
        className={baseCls + "animate-pulse " + className}
        aria-hidden="true"
      />
    );
  }
  if (state === "error" || !url) {
    return (
      <div
        style={{ width: size, height: size }}
        className={baseCls + "flex items-center justify-center text-slate-400 " + className}
        aria-label="No artwork image"
      >
        <ImageIcon size={Math.max(16, Math.round(size * 0.4))} />
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={sku}
      style={{ width: size, height: size }}
      className={baseCls + "object-cover " + className}
      onError={() => setState("error")}
    />
  );
}