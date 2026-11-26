"""
Builds seed.sql: one artwork_images row per artwork code, pointing at the
EXISTING small preview JPEG in Dropbox ("/Packing Slip Previews/<hash>.jpg").

Inputs (read-only, never modified):
  - packing-preview-index-v1.json  (code -> source content hash(es))
  - the synced Dropbox folders, to check each preview file exists and to settle
    codes with two candidate hashes

Rules:
  - table key = code without the "INKA-" prefix (that is what
    api/dropbox/artwork-image.ts looks up, e.g. KAN0566, S3-WIL0049-01)
  - one candidate hash            -> use it (preview file must exist)
  - two candidates                -> use one only if EXACTLY ONE of them equals the
                                     Dropbox content hash of a current original;
                                     otherwise leave the code out (the old, slower
                                     lookup still serves it)
  - non-INKA keys (legacy)        -> skipped

Usage:  python build-seed.py <index.json> <dropbox root> > seed.sql
"""
import hashlib, json, os, re, sys

index_path, dbx = sys.argv[1], sys.argv[2]
previews = os.path.join(dbx, "Packing Slip Previews")
entries = json.load(open(index_path, encoding="utf-8"))["entries"]
have = {f[:-4] for f in os.listdir(previews) if f.lower().endswith(".jpg")}


def dropbox_content_hash(path):
    blocks = []
    with open(path, "rb") as fh:
        while True:
            b = fh.read(4 * 1024 * 1024)
            if not b:
                break
            blocks.append(hashlib.sha256(b).digest())
    return hashlib.sha256(b"".join(blocks)).hexdigest()


def current_original_hashes(code):
    out = set()
    root = os.path.join(dbx, "INKA Hub")
    for folder, _, files in os.walk(root):
        for f in files:
            if f.upper().startswith(code.upper()):
                p = os.path.join(folder, f)
                if os.path.getsize(p) <= 200 * 1024 * 1024:
                    out.add(dropbox_content_hash(p))
    return out


chosen, skipped = {}, []
for code, hashes in sorted(entries.items()):
    if not code.startswith("INKA-"):
        skipped.append((code, "legacy key"))
        continue
    if len(hashes) == 1:
        h = hashes[0]
    else:
        live = current_original_hashes(code)
        match = [h for h in hashes if h in live]
        if len(match) != 1:
            skipped.append((code, "two current originals share this code"))
            continue
        h = match[0]
    if h not in have:
        skipped.append((code, "preview file missing"))
        continue
    key = code[5:]  # drop "INKA-"
    # only formats the app actually looks up: KAN0566, S3-WIL0049-01, AUX-FP-MCO
    if not re.fullmatch(r"[A-Z]{2,3}\d{4}|S\d-[A-Z]{2,3}\d{4}-\d\d|AUX-FP-[A-Z]{2,3}", key):
        skipped.append((code, "old name format the app never looks up"))
        continue
    chosen[key] = h

print("-- Seed: artwork code -> existing small preview JPEG in Dropbox.")
print(f"-- {len(chosen)} rows. Safe to re-run (upserts). Skipped {len(skipped)}:")
for code, why in skipped:
    print(f"--   {code}: {why}")
print("BEGIN;")
print("INSERT INTO artwork_images (artwork_code, dropbox_path) VALUES")
rows = [f"  ('{c}', '/Packing Slip Previews/{h}.jpg')" for c, h in sorted(chosen.items())]
print(",\n".join(rows))
print("ON CONFLICT (artwork_code) DO UPDATE SET")
print("  dropbox_path = EXCLUDED.dropbox_path,")
print("  cached_url = NULL,")
print("  cached_url_expires_at = NULL,")
print("  updated_at = now();")
print("COMMIT;")
