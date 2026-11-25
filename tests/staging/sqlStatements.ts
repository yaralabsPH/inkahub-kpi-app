/**
 * Split a Postgres SQL script into top-level statements so each one can be
 * run on its own and its result captured. Semicolons inside quotes,
 * identifiers, comments and dollar-quoted bodies (DO $$ ... $$) do not split.
 */
export interface SqlStatement {
  /** 1-based position in the script. */
  index: number;
  /** 1-based line where the statement's first code starts. */
  line: number;
  /** Statement text without the trailing semicolon (comments kept). */
  text: string;
  /** First line of actual code, for labels. */
  label: string;
}

/** Remove comments and whitespace to decide whether anything executable remains. */
function codeOnly(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

export function splitSqlStatements(script: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let i = 0;
  const n = script.length;

  const push = (end: number) => {
    const raw = script.slice(start, end);
    const code = codeOnly(raw);
    if (code) {
      // locate first code line
      const lines = raw.split("\n");
      let offsetLines = 0;
      let inBlock = false;
      for (const l of lines) {
        const t = l.trim();
        if (inBlock) {
          if (t.includes("*/")) inBlock = false;
          offsetLines++;
          continue;
        }
        if (t === "" || t.startsWith("--")) {
          offsetLines++;
          continue;
        }
        if (t.startsWith("/*") && !t.includes("*/")) {
          inBlock = true;
          offsetLines++;
          continue;
        }
        break;
      }
      const line = script.slice(0, start).split("\n").length + offsetLines;
      out.push({
        index: out.length + 1,
        line,
        text: raw.trim(),
        label: code.split("\n")[0].trim().slice(0, 120),
      });
    }
  };

  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const nl = script.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (script[i] === "/" && script[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (script[i] === "*" && script[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) throw new Error("Unterminated block comment in SQL script.");
    } else if (ch === "'") {
      const escapes = i > 0 && /[eE]/.test(script[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(script[i - 2]));
      i++;
      for (;;) {
        if (i >= n) throw new Error("Unterminated string literal in SQL script.");
        if (escapes && script[i] === "\\") {
          i += 2;
        } else if (script[i] === "'" && script[i + 1] === "'") {
          i += 2;
        } else if (script[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (ch === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Error("Unterminated quoted identifier in SQL script.");
        if (script[i] === '"' && script[i + 1] === '"') i += 2;
        else if (script[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (ch === "$" && !(i > 0 && /[A-Za-z0-9_]/.test(script[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
      if (m) {
        const tag = m[0];
        const close = script.indexOf(tag, i + tag.length);
        if (close === -1) throw new Error(`Unterminated dollar-quoted body ${tag} in SQL script.`);
        i = close + tag.length;
      } else i++;
    } else if (ch === ";") {
      push(i);
      i++;
      start = i;
    } else i++;
  }
  push(n);
  return out;
}
