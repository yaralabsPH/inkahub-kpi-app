/**
 * Lanyard barcode utilities — token generation + print-window rendering.
 *
 * Barcode tokens are 8 random hex chars (4 bytes of entropy). That's 16^8
 * ≈ 4.3B possible values, which is plenty for a workshop of a few dozen
 * staff. Collisions are checked at the DB layer (composite PK on
 * (location, barcode)) so a duplicate token gets rejected with a clear
 * error and we can retry.
 *
 * Print rendering uses JsBarcode loaded from a CDN. The print window
 * is a self-contained mini-page that:
 *   1. Renders the staff name + Code128 barcode + the token text.
 *   2. Calls window.print() automatically when the script finishes.
 *   3. Closes itself after print or after 30 seconds (whichever first).
 *
 * Requires network at print time (CDN fetch). If the operator is offline
 * they'll see a placeholder + an error toast; closing and retrying when
 * online will work.
 */

/**
 * Cryptographically-strong random 8-char uppercase hex token.
 * Uses globalThis.crypto.getRandomValues when available (modern browsers
 * including all Vercel runtimes); falls back to Math.random with a
 * console warning.
 */
export function generateBarcodeToken(): string {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  const bytes = new Uint8Array(4);
  if (g.crypto?.getRandomValues) {
    g.crypto.getRandomValues(bytes);
  } else {
    // eslint-disable-next-line no-console
    console.warn("crypto.getRandomValues unavailable — using Math.random");
    for (let i = 0; i < 4; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

/**
 * Open a new tab/window containing a printable lanyard card and trigger
 * the print dialog. The page is fully inline (no React, no app shell) so
 * print preview shows exactly what'll come out of the printer.
 *
 * The card is sized roughly 85mm × 55mm — standard credit-card dimensions
 * that fit common lanyard pouches. Adjust the CSS if your pouches differ.
 */
export function printLanyard(opts: {
  /** Staff display name printed large at the top. */
  name: string;
  /** The 8-char hex token that will be encoded into the barcode. */
  barcode: string;
  /** Optional subtitle printed below the name (e.g. role / department). */
  subtitle?: string;
}): void {
  const { name, barcode, subtitle } = opts;
  const win = window.open("", "_blank", "width=600,height=400");
  if (!win) {
    alert("Couldn't open the print window. Check your browser's popup blocker.");
    return;
  }
  // Escape user-supplied strings before injecting into innerHTML.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Lanyard — ${esc(name)}</title>
  <style>
    /* Page setup: one card per page, no margins so the card sits where we put it. */
    @page { size: 85mm 55mm; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      background: #fff;
    }
    .card {
      width: 85mm;
      height: 55mm;
      padding: 4mm 5mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      border: 1px solid #e2e8f0; /* visible on screen, removable in print preview */
    }
    .name {
      font-size: 22pt;
      font-weight: 600;
      line-height: 1.1;
      letter-spacing: -0.01em;
    }
    .subtitle {
      font-size: 9pt;
      color: #64748b;
      margin-top: 1mm;
    }
    .barcode-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .barcode-wrap svg { display: block; max-width: 100%; }
    .token {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 9pt;
      letter-spacing: 0.1em;
      margin-top: 1mm;
    }
    .brand {
      position: absolute;
      bottom: 2mm;
      right: 4mm;
      font-size: 6pt;
      color: #cbd5e1;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .err {
      color: #dc2626;
      font-size: 10pt;
      padding: 8mm;
      text-align: center;
    }
    @media print {
      .card { border: none; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div>
      <div class="name">${esc(name)}</div>
      ${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ""}
    </div>
    <div class="barcode-wrap">
      <svg id="barcode"></svg>
      <div class="token">${esc(barcode)}</div>
    </div>
    <div class="brand">Inka Arthouse</div>
  </div>
  <script src="https://unpkg.com/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <script>
    (function () {
      function render() {
        try {
          window.JsBarcode("#barcode", "${esc(barcode)}", {
            format: "CODE128",
            width: 2,
            height: 50,
            margin: 0,
            displayValue: false,
          });
          setTimeout(function () { window.print(); }, 100);
        } catch (e) {
          document.body.innerHTML = '<div class="err">Couldn\\'t load the barcode library. Check your connection and try again.</div>';
        }
      }
      if (window.JsBarcode) {
        render();
      } else {
        var poll = setInterval(function () {
          if (window.JsBarcode) {
            clearInterval(poll);
            render();
          }
        }, 50);
        setTimeout(function () { clearInterval(poll); }, 5000);
      }
      // Auto-close 30s after open as a fallback for forgotten tabs.
      setTimeout(function () { try { window.close(); } catch (e) {} }, 30_000);
      // Also close on afterprint (some browsers).
      window.onafterprint = function () { try { window.close(); } catch (e) {} };
    })();
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

/**
 * Multi-card variant: open a print window with one card per staff member,
 * page break between each. Use the browser's print dialog "Save as PDF"
 * destination to download a single PDF file with all team lanyards.
 *
 * Uses the same CDN JsBarcode approach as printLanyard() so no extra deps.
 * Renders all barcodes asynchronously after the script loads, then opens
 * the print dialog when every card is ready.
 */
export function printAllLanyards(staff: Array<{
  name: string;
  barcode: string;
  subtitle?: string;
}>): void {
  if (staff.length === 0) {
    alert("No active team members with barcodes to print.");
    return;
  }
  const win = window.open("", "_blank", "width=800,height=600");
  if (!win) {
    alert("Couldn't open the print window. Check your browser's popup blocker.");
    return;
  }

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const cards = staff
    .map((s, i) => `
      <div class="card" id="card-${i}">
        <div>
          <div class="name">${esc(s.name)}</div>
          ${s.subtitle ? `<div class="subtitle">${esc(s.subtitle)}</div>` : ""}
        </div>
        <div class="barcode-wrap">
          <svg class="barcode" data-token="${esc(s.barcode)}"></svg>
          <div class="token">${esc(s.barcode)}</div>
        </div>
        <div class="brand">Inka Arthouse</div>
      </div>
    `)
    .join("");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Team Lanyards (${staff.length})</title>
  <style>
    @page { size: 85mm 55mm; margin: 0; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      background: #f1f5f9;
    }
    .card {
      width: 85mm;
      height: 55mm;
      padding: 4mm 5mm;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      background: #fff;
      border: 1px solid #e2e8f0;
      margin: 4mm auto;
      page-break-after: always;
      position: relative;
    }
    .card:last-child { page-break-after: auto; }
    .name {
      font-size: 22pt;
      font-weight: 600;
      line-height: 1.1;
      letter-spacing: -0.01em;
    }
    .subtitle {
      font-size: 9pt;
      color: #64748b;
      margin-top: 1mm;
    }
    .barcode-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .barcode { display: block; max-width: 100%; }
    .token {
      font-family: ui-monospace, Menlo, Consolas, monospace;
      font-size: 9pt;
      letter-spacing: 0.1em;
      margin-top: 1mm;
    }
    .brand {
      position: absolute;
      bottom: 2mm;
      right: 4mm;
      font-size: 6pt;
      color: #cbd5e1;
      letter-spacing: 0.2em;
      text-transform: uppercase;
    }
    .toolbar {
      position: sticky;
      top: 0;
      background: #0f172a;
      color: #fff;
      padding: 8px 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 100;
      font-size: 12pt;
    }
    .toolbar button {
      background: #10b981;
      color: #fff;
      border: 0;
      padding: 6px 14px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      font-size: 11pt;
    }
    .toolbar button:hover { background: #059669; }
    .err {
      color: #dc2626;
      font-size: 10pt;
      padding: 8mm;
      text-align: center;
    }
    @media print {
      .toolbar { display: none; }
      .card { border: none; margin: 0; }
      body { background: #fff; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span>${staff.length} team member${staff.length === 1 ? "" : "s"} - tip: in the print dialog, choose "Save as PDF" as destination</span>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  ${cards}
  <script src="https://unpkg.com/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
  <script>
    (function () {
      function renderAll() {
        try {
          var nodes = document.querySelectorAll("svg.barcode");
          nodes.forEach(function (svg) {
            var token = svg.getAttribute("data-token");
            window.JsBarcode(svg, token, {
              format: "CODE128",
              width: 2,
              height: 50,
              margin: 0,
              displayValue: false,
            });
          });
          // Give the layout a tick, then open print dialog.
          setTimeout(function () { window.print(); }, 200);
        } catch (e) {
          document.body.innerHTML = '<div class="err">Couldn\\'t load the barcode library. Check your connection and try again.</div>';
        }
      }
      if (window.JsBarcode) {
        renderAll();
      } else {
        var poll = setInterval(function () {
          if (window.JsBarcode) {
            clearInterval(poll);
            renderAll();
          }
        }, 50);
        setTimeout(function () { clearInterval(poll); }, 5000);
      }
      window.onafterprint = function () { try { window.close(); } catch (e) {} };
    })();
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

// ---------------------------------------------------------------------------
// JPEG / ZIP download: render each lanyard to a canvas, encode as JPEG, zip
// them all, trigger one browser download. Useful when the operator wants
// individual image files (one per staff member) instead of a printable PDF.
// ---------------------------------------------------------------------------

/**
 * Load a script tag from a URL and resolve once it's on window. Idempotent â€”
 * if the script is already loaded, resolves immediately. Used to pull
 * JsBarcode + JSZip from CDN at click-time so we don't need to npm install.
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = src;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(tag);
  });
}

/**
 * Build a single lanyard JPEG. Returns a Blob. Layout matches the printed
 * card: name top-left, Code128 barcode centered toward the bottom, token
 * text below, brand watermark bottom-right. 300 DPI for crisp printing.
 */
async function renderLanyardJpeg(opts: {
  name: string;
  barcode: string;
  subtitle?: string;
}): Promise<Blob> {
  const { name, barcode, subtitle } = opts;
  // 85mm x 55mm at 300 DPI = ~1004 x 650 px
  const CARD_W = 1004;
  const CARD_H = 650;
  const PAD = 60;

  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // White background.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Faint border so cropped print still shows the card edge.
  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, CARD_W - 2, CARD_H - 2);

  // Name - big, dark, left-aligned at top.
  ctx.fillStyle = "#0f172a";
  ctx.font = '600 88px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(name, PAD, PAD);

  // Subtitle (role / dept) - small, grey, beneath name.
  if (subtitle) {
    ctx.fillStyle = "#64748b";
    ctx.font = "36px system-ui, -apple-system, sans-serif";
    ctx.fillText(subtitle, PAD, PAD + 100);
  }

  // Render barcode to a temp canvas via JsBarcode, then composite centered.
  type JsBarcodeFn = (target: HTMLCanvasElement, value: string, opts: Record<string, unknown>) => void;
  const jsbarcode = (window as unknown as { JsBarcode?: JsBarcodeFn }).JsBarcode;
  if (!jsbarcode) throw new Error("JsBarcode not loaded");
  const bcCanvas = document.createElement("canvas");
  jsbarcode(bcCanvas, barcode, {
    format: "CODE128",
    width: 5,
    height: 200,
    margin: 0,
    displayValue: false,
  });
  const bcX = Math.max(PAD, (CARD_W - bcCanvas.width) / 2);
  const bcY = CARD_H - bcCanvas.height - 110;
  ctx.drawImage(bcCanvas, bcX, bcY, Math.min(bcCanvas.width, CARD_W - 2 * PAD), bcCanvas.height);

  // Token text under the barcode, centered, monospace.
  ctx.fillStyle = "#0f172a";
  ctx.font = '40px ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Letter-spacing approximation: write per-char with offset.
  const spaced = barcode.split("").join(" ");
  ctx.fillText(spaced, CARD_W / 2, bcY + bcCanvas.height + 18);

  // Brand watermark bottom-right.
  ctx.fillStyle = "#cbd5e1";
  ctx.font = '22px system-ui, sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("INKA ARTHOUSE", CARD_W - PAD, CARD_H - 30);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/jpeg",
      0.92,
    );
  });
}

/**
 * Sanitize a display name into a filename-safe slug. Strips diacritics by
 * stripping non-ASCII, collapses spaces to underscore, drops everything
 * that isn't a letter / digit / underscore / hyphen.
 */
function safeFilename(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    || "staff";
}

/**
 * Bulk download: produce one JPEG per staff member, package into a single
 * ZIP, trigger a browser download. Uses JsBarcode + JSZip from CDN.
 *
 * Resolves once the download has been triggered. Caller should disable the
 * button while this is running to prevent double-clicks.
 */
export async function downloadAllLanyardsAsJpegs(
  staff: Array<{ name: string; barcode: string; subtitle?: string }>,
): Promise<{ count: number; filename: string }> {
  if (staff.length === 0) {
    throw new Error("No staff with barcodes to download.");
  }

  await loadScript("https://unpkg.com/jsbarcode@3.11.6/dist/JsBarcode.all.min.js");
  await loadScript("https://unpkg.com/jszip@3.10.1/dist/jszip.min.js");

  type JSZipCtor = new () => {
    file: (name: string, data: Blob) => void;
    generateAsync: (opts: { type: "blob" }) => Promise<Blob>;
  };
  const JSZip = (window as unknown as { JSZip?: JSZipCtor }).JSZip;
  if (!JSZip) throw new Error("JSZip failed to load");

  const zip = new JSZip();
  for (const s of staff) {
    const blob = await renderLanyardJpeg(s);
    const fname = `${safeFilename(s.name)}_${s.barcode}.jpg`;
    zip.file(fname, blob);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(zipBlob);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `lanyards_${stamp}.zip`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { count: staff.length, filename };
}
