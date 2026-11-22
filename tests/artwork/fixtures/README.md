# F3 converter fixtures

No artwork originals, customer files or Part 6 previews are committed here.

## Local tests (committed, generated at test time)

`tests/api/artwork/converter.test.ts` builds small synthetic images with Sharp
in a per-test scratch directory: solid colours in JPEG/PNG/WebP/TIFF, an
extensionless JPEG, an EXIF-rotated JPEG, a transparent PNG, a 16-bit PNG,
random-noise PNGs, an animated WebP, SVG/GIF (rejected formats), random bytes
and a truncated JPEG. These prove behaviour, not memory headroom.

Sharp cannot *write* a 16-bit TIFF, so that case is only in the Preview
suite below.

## Task 3 Preview suite (not committed)

The staging Preview benchmark uses large fixtures kept in an **isolated
staging Dropbox test folder** (never `/INKA Hub`, never
`/Packing Slip Previews/`). Generate them on a workstation and upload them
there by hand; record each file's name, bytes, dimensions, format, depth and
Dropbox `content_hash` in the plan's Implementation log.

Required cases (limits: 150,000,000 bytes, 300,000,000 pixels):

| Fixture | How to make it |
| --- | --- |
| Largest JPEG, high entropy | 20000 × 15000 random noise, quality 95, trimmed to ≤150 MB |
| Largest PNG | 17320 × 17320 (≈300 MP) noise or photographic content, ≤150 MB |
| Single-page TIFF, 8-bit | ≈300 MP, LZW or uncompressed within the byte cap |
| 16-bit TIFF | Export from an image editor (e.g. GIMP/Photoshop "16 bits/channel") or `vips copy in.png out.tif[compression=lzw]` from a 16-bit PNG |
| 16-bit PNG, RGBA | Large, with transparency |
| Extensionless | Copy of the largest JPEG named like `INKA-TEST9999` |
| Just over the limits | 150,000,001 bytes; 15000 × 20001 pixels — must be rejected, not converted |
| Corrupt / truncated | Large JPEG cut in half; random bytes with an `INKA-` name |
| Six-piece and nine-piece sets | Six/nine distinct large components named `INKA-S6-TEST0001-01…06` (and S9) |

Sharp one-liner for a noise JPEG (adjust size/quality to land under 150 MB):

```js
const sharp = require("sharp");
const w = 20000, h = 15000;
sharp(require("crypto").randomBytes(w * h * 3), { raw: { width: w, height: h, channels: 3 }, limitInputPixels: false })
  .jpeg({ quality: 95 }).toFile("noise-300mp.jpg");
```

`limitInputPixels: false` is acceptable only in this fixture-making script
on a workstation, never in the converter.
