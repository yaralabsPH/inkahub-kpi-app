/**
 * Deployed-runtime import smoke check (no network, no bundler).
 *
 * Vercel compiles each api/ file to JavaScript WITHOUT bundling or rewriting import specifiers and then loads
 * it with Node ESM ("type": "module"), which requires exact relative file paths such as "./x.js". The type
 * checks and Vite use bundler resolution and accept extensionless imports, so a missing ".js" only failed at
 * runtime (Preview 500, ERR_MODULE_NOT_FOUND). This check emits the same unbundled JavaScript with the
 * existing TypeScript compiler, then (1) verifies every relative specifier in the emitted server graph
 * resolves to an existing file exactly as Node would, and (2) imports every api/ entrypoint in a fresh Node
 * process with an empty environment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "node_modules", ".api-runtime-check"); // inside node_modules so packages resolve; never committed
const ENTRIES = readdirSync(path.join(ROOT, "api"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_lib")
  .flatMap((d) => readdirSync(path.join(ROOT, "api", d.name)).filter((f) => f.endsWith(".ts")).map((f) => `api/${d.name}/${f}`))
  .sort();

/** The OS environment Node needs (PATH, SystemRoot, TEMP, ...) WITHOUT any app configuration or credentials. */
const OS_ONLY_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/SUPABASE|SHOPIFY|DROPBOX|RESEND|MAKE_|ORDER_TIMELINE|REPORT|CRON|VERCEL|VITE_|SECRET|TOKEN|KEY|PASSWORD|DATABASE|PG/i.test(k)));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
}

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  // Emit only (no type check here: tsc -b and typecheck:api already do that with the real settings).
  execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    "--outDir", OUT, "--rootDir", ROOT, "--module", "ESNext", "--moduleResolution", "bundler", "--target", "ES2022",
    "--skipLibCheck", "--noCheck", "--types", "node", "--jsx", "react-jsx", ...ENTRIES], { cwd: ROOT, stdio: "pipe" });
  writeFileSync(path.join(OUT, "package.json"), JSON.stringify({ type: "module" }));
}, 120_000);

describe("api runtime imports (unbundled Node ESM, as deployed)", () => {
  it("found the twelve function entrypoints", () => {
    expect(ENTRIES.length).toBe(12);
  });

  it("every relative import in the emitted server graph names an existing file exactly", () => {
    const bad: string[] = [];
    const spec = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
    for (const file of walk(OUT)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(spec)) {
        const target = path.resolve(path.dirname(file), m[1]);
        if (!existsSync(target) || !statSync(target).isFile()) bad.push(`${path.relative(OUT, file)} -> ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(ENTRIES)("%s loads under plain Node ESM with no environment", (entry) => {
    const url = pathToFileURL(path.join(OUT, entry.replace(/\.ts$/, ".js"))).href;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], {
      cwd: ROOT, env: OS_ONLY_ENV, encoding: "utf8", timeout: 60_000,
    });
    const why = r.error ? `spawn: ${r.error.message}` : ((r.stderr || "").split("\n").find((l) => /Error/.test(l)) ?? (r.stderr || "").slice(0, 300));
    expect(r.status, `${why} (status ${r.status})`).toBe(0);
  });
});
