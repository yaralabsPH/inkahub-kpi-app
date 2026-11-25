/** @type {import('tailwindcss').Config} */
// `hub` colours are the redesign tokens (docs/wireframes/wf.css). They read CSS
// variables defined in src/index.css, so one class works in light and dark.
// Opaque tokens are RGB channels so opacity modifiers (bg-hub-panel/80) work;
// tokens that are translucent in dark mode are full colour values.
const ch = (name) => `rgb(var(--hub-${name}) / <alpha-value>)`;
const full = (name) => `var(--hub-${name})`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        hub: {
          page: ch("page"),
          panel: ch("panel"),
          sidebar: ch("sidebar"),
          "sidebar-2": ch("sidebar-2"),
          "sidebar-text": ch("sidebar-text"),
          "sidebar-hi": ch("sidebar-hi"),
          "sidebar-line": ch("sidebar-line"),
          "sidebar-dim": ch("sidebar-dim"),
          line: ch("line"),
          "line-2": ch("line-2"),
          text: ch("text"),
          muted: ch("muted"),
          faint: ch("faint"),
          fill: ch("fill"),
          "fill-2": ch("fill-2"),
          sub: ch("sub"),
          hover: ch("hover"),
          accent: ch("accent"),
          "accent-text": ch("accent-text"),
          "accent-bg": full("accent-bg"),
          "warn-bg": full("warn-bg"),
          warn: ch("warn"),
          "bad-bg": full("bad-bg"),
          bad: ch("bad"),
          "info-bg": full("info-bg"),
          info: ch("info"),
          scrim: full("scrim"),
        },
      },
      borderRadius: {
        hub: "6px",
        "hub-card": "8px",
      },
      boxShadow: {
        "hub-pop": "0 16px 40px var(--hub-shadow-2)",
        "hub-peek": "-12px 0 30px var(--hub-shadow)",
      },
      maxWidth: {
        hub: "1180px",
      },
    },
  },
  plugins: [],
};
