import { useEffect, useState } from "react";

interface Item {
  id: string;
  label: string;
}

const slug = (s: string) =>
  "report-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

function collect(root: HTMLElement): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  const nodes = root.querySelectorAll<HTMLElement>("h2, [data-report-section]");
  nodes.forEach((el) => {
    // A heading inside an already-listed section is not listed again.
    if (el.tagName === "H2" && el.closest("[data-report-section]")) return;
    const label = (el.dataset.reportSection ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!label) return;
    if (!el.id) {
      let id = slug(label);
      let n = 2;
      while (document.getElementById(id)) id = `${slug(label)}-${n++}`;
      el.id = id;
    }
    // Land below the sticky section bar.
    if (!el.style.scrollMarginTop) el.style.scrollMarginTop = "56px";
    if (seen.has(el.id)) return;
    seen.add(el.id);
    out.push({ id: el.id, label: label.length > 40 ? `${label.slice(0, 38)}…` : label });
  });
  return out;
}

/**
 * "On this page" links for Reports (wireframe reports.html sub-nav). It lists
 * the sections that are actually rendered for this user, so every existing
 * role/feature gate decides what appears. Anchors only: no routes, no state,
 * nothing is remounted or refetched.
 */
export function ReportsSectionNav({ containerId, label = "Report sections" }: { containerId: string; label?: string }) {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const root = document.getElementById(containerId);
    if (!root) return;
    let raf = 0;
    const refresh = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = collect(root);
        setItems((prev) =>
          prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.label === next[i].label) ? prev : next,
        );
      });
    };
    refresh();
    const mo = new MutationObserver(refresh);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
    };
  }, [containerId]);

  if (items.length < 2) return null;
  return (
    <nav
      aria-label={label}
      className="sticky top-0 z-[5] -mx-1 mb-3 flex gap-1 overflow-x-auto border-b border-hub-line bg-hub-page/95 px-1 py-1.5 backdrop-blur"
    >
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById(it.id);
            const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
            el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
            el?.setAttribute("tabindex", "-1");
            el?.focus({ preventScroll: true });
          }}
          className="shrink-0 whitespace-nowrap rounded-hub px-2.5 py-1 text-[12.5px] text-hub-muted hover:bg-hub-fill hover:text-hub-text"
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}
