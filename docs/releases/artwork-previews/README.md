# Artwork previews: a table of preview paths

The app already looks artwork up through the `artwork_images` table (artwork code -> Dropbox path).
On live that table is empty, so every lookup searches Dropbox for the full-size original and shows it
as the thumbnail. This seed fills the table with the paths of the small previews that already exist in
Dropbox (`/Packing Slip Previews/<hash>.jpg`, about 21 KB each). No app code changes: the lookup uses a
stored path first (`api/dropbox/artwork-image.ts`).

## What is in `seed.sql`
- 556 rows, built from `packing-preview-index-v1.json`. Every row's preview file was checked to exist in
  the synced Dropbox folder.
- The key is the code without `INKA-` (for example `ABS0007`, `S3-WIL0049-01`, `AUX-FP-MCO`), which is what
  the lookup asks for.
- 27 codes are left out and listed at the top of the file: one legacy key, 18 where two different current
  originals share one code, and 8 old name formats the app never asks for. They keep working through the
  existing, slower search.

## Apply (CJ, any time; it only writes to `artwork_images`)
Run `seed.sql` in the Supabase SQL editor on the live project. It is safe to run again (it upserts).
Staging check done: applied twice on inka-staging-2, row count stayed the same.

## Check it worked
Open an order that has artwork. The thumbnail should appear quickly, and the lookup response
(`/api/dropbox/artwork-image?sku=...`) should show a path starting `/Packing Slip Previews/`.
Not yet tested: the Dropbox temporary link itself, which needs the live Dropbox token to be valid
(`DROPBOX_ACCESS_TOKEN` is a fixed token and can expire). If thumbnails do not load after the seed,
check that token first.

## Rollback
`delete from artwork_images where dropbox_path like '/Packing Slip Previews/%';`
The lookup then goes back to searching Dropbox, as it does today.

## Limits
- New or changed artwork has no preview until the old Make "Part 6" preview step is run for it; it falls
  back to the slower search in the meantime. Re-run `build-seed.py` after new previews are made.
- If a preview file is ever moved or renamed, the lookup drops that row by itself and falls back to the search.

## Rebuild the seed
`python build-seed.py <packing-preview-index-v1.json> <Dropbox folder> > seed.sql` (read-only on both inputs).
