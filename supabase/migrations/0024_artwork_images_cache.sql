-- 0024_artwork_images_cache.sql
--
-- Shared artwork-image cache backing the Production-kiosk thumbnails.
-- Reads are open to any authenticated user (every kiosk reads the same
-- map). Writes go through a SECURITY DEFINER RPC so the API function
-- doesn't need the service-role key.
--
-- Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS artwork_images (
  artwork_code            TEXT PRIMARY KEY,
  dropbox_path            TEXT NOT NULL,
  cached_url              TEXT,
  cached_url_expires_at   TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE artwork_images IS
  'Cache mapping v6 artwork codes (KAN0566, S3-WIL0049-01, AUX-FP-MCO) to Dropbox paths + signed URLs. Shared by every kiosk. Populated lazily by /api/dropbox/artwork-image on first lookup. Self-healing when files move (404 on the stored path drops the row and re-searches).';

CREATE INDEX IF NOT EXISTS artwork_images_expires_idx
  ON artwork_images (cached_url_expires_at);

ALTER TABLE artwork_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS artwork_images_read ON artwork_images;
CREATE POLICY artwork_images_read ON artwork_images
  FOR SELECT
  TO authenticated
  USING (true);

-- Cache writes go through a SECURITY DEFINER function. Authenticated
-- users can call it (which is fine - the API gate is at the Vercel
-- function level), but they can't INSERT/UPDATE/DELETE the table directly.

CREATE OR REPLACE FUNCTION upsert_artwork_image_cache(
  p_artwork_code  TEXT,
  p_dropbox_path  TEXT,
  p_cached_url    TEXT,
  p_expires_at    TIMESTAMPTZ
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO artwork_images
    (artwork_code, dropbox_path, cached_url, cached_url_expires_at, updated_at)
  VALUES
    (p_artwork_code, p_dropbox_path, p_cached_url, p_expires_at, now())
  ON CONFLICT (artwork_code) DO UPDATE SET
    dropbox_path           = EXCLUDED.dropbox_path,
    cached_url             = EXCLUDED.cached_url,
    cached_url_expires_at  = EXCLUDED.cached_url_expires_at,
    updated_at             = now();
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_artwork_image_cache TO authenticated;

CREATE OR REPLACE FUNCTION delete_artwork_image_cache(p_artwork_code TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM artwork_images WHERE artwork_code = p_artwork_code;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_artwork_image_cache TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;