/* Wireframe shell (round 2). Wraps #content in the app chrome and adds:
   Lucide icons, light/dark/system theme, Framed/Unframed + Scenario
   controls, alerts dropdown, collapsible sidebar, mobile drawer, role
   preview (mirrors src/lib/auth/permissions.ts), data states, confirm
   dialogs and a keyboard-driven command palette. Needs icons.js first.
   Everything is mock data; nothing talks to a backend. */
(function () {
  const store = {
    get: (k, d) => { try { return localStorage.getItem("wf-" + k) || d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem("wf-" + k, v); } catch (e) {} },
  };

  // ---------- theme (runs immediately to avoid a flash) ----------
  const mq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  function applyTheme() {
    const t = store.get("theme", "system");
    const dark = t === "dark" || (t === "system" && mq && mq.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.querySelectorAll(".theme-btn button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.t === t)));
  }
  applyTheme();
  if (mq && mq.addEventListener) mq.addEventListener("change", applyTheme);
  window.WF_setTheme = t => { store.set("theme", t); applyTheme(); };

  // ---------- icons ----------
  const ICONS = window.WF_ICONS || {};
  function ic(name, cls) {
    return `<svg class="i ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS["list"] || ""}</svg>`;
  }
  window.WF_icon = ic;
  const prepend = (el, name, cls) => el.insertAdjacentHTML("afterbegin", ic(name, cls));

  // ---------- nav (keys match NAV_KEYS in schemas.ts) ----------
  const NAV = [
    { g: null, items: [["welcome", "Home", "welcome.html", "home"], ["dashboard", "Dashboard", "dashboard.html", "layout-dashboard"]] },
    { g: "Inventory", items: [["skus", "SKUs", "skus.html", "package", "142"], ["warehouse", "Warehouse", "warehouse.html", "warehouse"], ["movements", "Movements", "movements.html", "arrow-left-right"], ["paper", "Paper usage", "paper-usage.html", "printer"]] },
    { g: "Planning", items: [["sales", "Sales entry", "sales-entry.html", "clipboard-list"], ["events", "Demand events", "demand-events.html", "calendar-days", "3"], ["orders", "Shopping list", "shopping-list.html", "shopping-cart"], ["shipments", "Shipments", "shipments.html", "truck", "5"]] },
    { g: "Customer service", items: [["cs_cases", "CS cases", "cs-cases.html", "life-buoy", "12"], ["cs_returns", "Returns", "returns.html", "package-open", "4"], ["order_submission", "Order submission", "#", "scan-line", "", true]] },
    { g: "Insights", items: [["reports", "Reports", "reports.html", "bar-chart-3"]] },
    { g: "Workspace", items: [["team", "Team", "team.html", "users"], ["settings", "Settings", "settings.html", "settings"]] },
  ];
  const ALL = NAV.flatMap(s => s.items.map(i => i[0]));
  const PAGE_ICON = {};
  NAV.forEach(s => s.items.forEach(i => (PAGE_ICON[i[0]] = i[3])));

  // Mirror of effectiveNavAccess() role defaults.
  function access(role) {
    let k;
    if (role === "owner") k = ALL.slice();
    else if (role === "manager") k = ALL.filter(x => x !== "dashboard");
    else if (role === "kiosk") k = ["order_submission"];
    else if (role === "cs") k = ["cs_returns", "cs_cases"];
    else k = ["welcome"];
    if (role !== "owner") k = k.filter(x => x !== "dashboard");
    if (!k.includes("welcome")) k.push("welcome");
    return new Set(k);
  }
  const ROLES = { owner: ["CJ Gomba", "CJ", "Owner"], manager: ["Ana Lopez", "AL", "Manager"], staff: ["Jane Smith", "JS", "Staff"], cs: ["Rita Tan", "RT", "Customer service"], kiosk: ["Bench 1", "K1", "Kiosk"] };

  // ---------- keyword → icon ----------
  function pick(text, rules, fallback) {
    const t = text.toLowerCase();
    for (const [re, name] of rules) if (re.test(t)) return name;
    return fallback;
  }
  const STAT_RULES = [
    [/urgent|critical|overdue|late/, "alert-triangle"], [/refund/, "undo-2"], [/inspection|received/, "eye"], [/case/, "life-buoy"],
    [/order/, "clipboard-list"], [/hour|labour/, "clock"], [/min/, "timer"], [/value|\$/, "trending-up"],
    [/demand|vs last/, "trending-up"], [/cover/, "calendar-days"], [/shipment/, "truck"],
    [/capacity|in use|free|headroom/, "warehouse"], [/supplier/, "users"], [/line|rows|cells/, "list"],
    [/sku/, "package"], [/unit|on hand|entered/, "boxes"], [/new this/, "package-open"], [/open/, "life-buoy"],
  ];
  const PROP_RULES = [
    [/status/, "check-circle-2"], [/urgency/, "alert-triangle"], [/date|placed|started|arrival|ordered|expected|due|received at/, "calendar"],
    [/supplier|customer/, "users"], [/code|invoice #|reference|order$/, "scan-barcode"], [/cost|amount|terms|refund/, "trending-up"],
    [/type|department|issue/, "layers"], [/on hand|pallet|order qty|min order|components/, "boxes"], [/lead|cover|avg/, "clock"], [/carrier/, "truck"],
    [/safety/, "shield-check"], [/keeps/, "undo-2"], [/pallets|skus|frees/, "warehouse"], [/notes?/, "message-square"],
  ];
  const VIEW_RULES = [[/board/, "kanban"], [/timeline/, "gantt-chart"], [/calendar/, "calendar"], [/gallery/, "layout-grid"], [/grid|table|members/, "table-2"], [/\+ view/, "plus"], [/trend/, "trending-up"], [/access|roles/, "shield-check"], [/week/, "calendar-days"]];
  const BTN_RULES = [
    [/^\+/, "plus"], [/invite|add member/, "user-plus"], [/export|download/, "download"], [/import/, "upload"], [/paste/, "clipboard-paste"],
    [/copy/, "copy"], [/compare/, "layers"], [/bulk/, "list"], [/print/, "printer"], [/delete|reset/, "trash-2"],
    [/dispatch|scan/, "scan-barcode"], [/look up/, "search"], [/send/, "mail"], [/review/, "eye"], [/undo|reverse/, "undo-2"], [/retry/, "refresh-cw"],
    [/shipment|delivered|in transit|shipped/, "truck"], [/log movement|adjust/, "arrow-left-right"], [/order|suggest/, "shopping-cart"],
    [/production/, "printer"], [/today/, "calendar"], [/deduct/, "boxes"],
  ];

  function decorate(root) {
    root.querySelectorAll(".emoji").forEach(e => { e.classList.add("ico"); e.setAttribute("aria-hidden", "true"); e.innerHTML = ic(e.dataset.icon || PAGE_ICON[window.__wfPage] || "layout-dashboard", "lg"); });
    root.querySelectorAll(".callout .ci").forEach(e => {
      const c = e.parentElement.classList;
      e.innerHTML = ic(c.contains("warn") ? "alert-triangle" : c.contains("bad") ? "alert-octagon" : c.contains("ok") ? "check-circle-2" : "lightbulb");
    });
    root.querySelectorAll(".views").forEach(v => v.setAttribute("role", "tablist"));
    root.querySelectorAll(".views span:not(.pin)").forEach(e => {
      prepend(e, pick(e.textContent, VIEW_RULES, "list"), "sm");
      e.setAttribute("role", "tab"); e.tabIndex = 0; e.setAttribute("aria-selected", String(e.classList.contains("on")));
    });
    root.querySelectorAll(".chip").forEach(e => {
      const t = e.textContent.trim().toLowerCase();
      e.setAttribute("role", "button"); e.tabIndex = 0;
      if (t.startsWith("+ filter")) { e.textContent = "Filter"; prepend(e, "filter"); }
      else if (t.startsWith("sort")) prepend(e, "arrow-up-down");
      else if (t.startsWith("group")) prepend(e, "layers");
      else if (e.classList.contains("filter")) prepend(e, "sliders-horizontal");
    });
    root.querySelectorAll(".btn").forEach(e => {
      if (!e.matches("button, a")) { e.setAttribute("role", "button"); e.tabIndex = 0; }
      const t = e.textContent.trim();
      const only = { "‹": "chevron-left", "›": "chevron-right", "↻": "refresh-cw" };
      if (only[t]) { e.setAttribute("aria-label", t === "‹" ? "Previous" : t === "›" ? "Next" : "Refresh"); e.innerHTML = ic(only[t]); return; }
      if (t === "‹ ›") { e.setAttribute("aria-label", "Previous / next"); e.innerHTML = ic("chevron-left") + ic("chevron-right"); return; }
      const name = pick(t, BTN_RULES, null);
      if (!name) return;
      if (t.startsWith("+ ")) e.firstChild.textContent = e.firstChild.textContent.replace(/^\s*\+\s*/, "");
      prepend(e, name);
    });
    root.querySelectorAll(".input").forEach(e => { if (/search|type/i.test(e.textContent)) { e.style.display = "inline-flex"; e.style.gap = "6px"; e.style.alignItems = "center"; e.setAttribute("role", "searchbox"); e.tabIndex = 0; prepend(e, "search", "sm"); } });
    root.querySelectorAll(".card > .lbl").forEach(e => {
      const first = e.firstChild; if (!first || first.nodeType !== 3) return;
      const span = document.createElement("span"); span.className = "li";
      span.innerHTML = ic(pick(first.textContent, STAT_RULES, "bar-chart-3"), "sm") + first.textContent;
      e.replaceChild(span, first);
    });
    root.querySelectorAll(".props .k").forEach(e => prepend(e, pick(e.textContent, PROP_RULES, "list"), "sm"));
    root.querySelectorAll(".peek .ptop span").forEach(e => {
      const t = e.textContent.trim();
      const set = (html, label) => { e.innerHTML = html; e.setAttribute("role", "button"); e.tabIndex = 0; if (label) e.setAttribute("aria-label", label); e.style.display = "inline-flex"; e.style.gap = "4px"; e.style.cursor = "pointer"; };
      if (t.startsWith("⤢")) set(ic("maximize-2", "sm") + " Open as page");
      else if (t === "✕") { set(ic("x", "sm"), "Close panel"); e.addEventListener("click", () => e.closest(".peek").classList.add("closed")); }
      else if (t === "⋯") set(ic("more-horizontal", "sm"), "More");
      else if (t === "‹ ›") set(ic("chevron-left", "sm") + ic("chevron-right", "sm"), "Previous / next record");
      else if (t === "Copy link") set(ic("copy", "sm") + " Copy link");
    });
    root.querySelectorAll("td").forEach(e => {
      const t = e.textContent.trim();
      if (t === "⋯") e.innerHTML = `<button class="iconbtn" aria-label="Row actions">${ic("more-horizontal", "sm")}</button>`;
      if (t === "✕") e.innerHTML = `<button class="iconbtn" aria-label="Remove line">${ic("x", "sm")}</button>`;
      if (t === "⋮⋮") e.innerHTML = `<span aria-label="Drag to reorder" title="Drag to reorder">${ic("grip-vertical", "sm")}</span>`;
    });
    root.querySelectorAll(".card-h > span:not(.pin):not(.tag), .card .lbl > span:last-child").forEach(e => { if (e.textContent.trim() === "⋯") e.innerHTML = `<button class="iconbtn" aria-label="Card menu">${ic("more-horizontal", "sm")}</button>`; });
    // keyboard: Enter/Space on role=button
    root.querySelectorAll('[role="button"],[role="tab"]').forEach(e => e.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); e.click(); } }));
  }

  // ---------- data states (loading / empty / error) ----------
  function setupStates(content, cfg) {
    const target = content.querySelector("[data-st]") || content.querySelector(".grid, .board, .tl");
    if (!target) return;
    target.classList.add("st-target");
    const e = cfg.empty || {};
    const rows = Array.from({ length: 5 }, () => `<div class="skrow"><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div><div class="skel"></div></div>`).join("");
    target.insertAdjacentHTML("afterend",
      `<div class="st loading" role="status" aria-live="polite"><span class="small muted" style="position:absolute;left:-9999px">Loading…</span>${rows}</div>` +
      `<div class="st empty"><div class="empty">${ic(PAGE_ICON[cfg.page] || "list", "lg")}<div style="font-weight:600;margin:10px 0 4px;color:var(--txt)">${e.title || "Nothing here yet"}</div><div class="small">${e.body || "When there is data it will show here."}</div>${e.cta ? `<div style="margin-top:12px"><span class="btn pri" role="button" tabindex="0">${ic("plus")}${e.cta}</span></div>` : ""}</div></div>` +
      `<div class="st error"><div class="callout bad" role="alert"><span class="ci">${ic("alert-octagon")}</span><div><b>Couldn't load ${cfg.title || "this page"}.</b><br><span class="muted">Check your connection. Nothing you entered was lost.</span></div><span class="btn sm" style="margin-left:auto;align-self:center" role="button" tabindex="0" onclick="WF_state('normal')">${ic("refresh-cw")}Retry</span></div></div>`);
  }
  window.WF_state = s => {
    document.body.classList.remove("st-loading", "st-empty", "st-error");
    if (s !== "normal") document.body.classList.add("st-" + s);
    const sel = document.getElementById("wf-state"); if (sel) sel.value = s;
  };

  // ---------- confirm dialog + toast ----------
  function dialog(title, body, action, danger) {
    let d = document.getElementById("wf-dlg");
    if (!d) { d = document.createElement("div"); d.id = "wf-dlg"; d.className = "dlg"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.setAttribute("aria-labelledby", "wf-dlg-h"); document.body.appendChild(d); }
    d.innerHTML = `<div class="dbox"><div class="dh" id="wf-dlg-h">${title}</div><div class="db">${body}</div><div class="df"><button class="btn ghost" data-x>Cancel</button><button class="btn ${danger ? "" : "pri"}" style="${danger ? "color:var(--bad);border-color:var(--bad)" : ""}" data-ok>${action}</button></div></div>`;
    d.classList.add("open");
    const close = () => d.classList.remove("open");
    d.querySelector("[data-x]").onclick = close;
    d.querySelector("[data-ok]").onclick = () => { close(); toast(action + " · done", true); };
    d.onclick = ev => { if (ev.target === d) close(); };
    d.querySelector("[data-ok]").focus();
  }
  function toast(msg, undo) {
    let t = document.getElementById("wf-toast");
    if (t) t.remove();
    t = document.createElement("div"); t.id = "wf-toast"; t.className = "toast"; t.setAttribute("role", "status");
    t.innerHTML = `<span>${msg}</span>${undo ? `<button>Undo</button>` : ""}`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  window.WF_toast = toast;
  document.addEventListener("click", ev => {
    const c = ev.target.closest("[data-confirm]");
    if (c) { const [a, b, x, danger] = c.dataset.confirm.split("|"); dialog(a, b, x, danger === "danger"); return; }
    const t = ev.target.closest("[data-toast]");
    if (t) toast(t.dataset.toast, true);
    const row = ev.target.closest(".tb tr[data-peek], .kcard");
    if (row) { const p = document.querySelector(".peek"); if (p) p.classList.remove("closed"); }
  });

  // ---------- role preview ----------
  function applyRole(role) {
    const allowed = access(role);
    const [name, ini, label] = ROLES[role] || ROLES.owner;
    document.querySelectorAll(".nav a[data-key]").forEach(a => a.classList.toggle("hidden-role", !allowed.has(a.dataset.key)));
    document.querySelectorAll(".navgrp").forEach(g => g.classList.toggle("hidden-role", !g.querySelector(".nav a:not(.hidden-role)")));
    document.querySelectorAll("[data-roles]").forEach(el => el.classList.toggle("hidden-role", !el.dataset.roles.split(/[ ,]+/).includes(role)));
    document.querySelectorAll(".wf-first").forEach(e => (e.textContent = name.split(" ")[0]));
    const foot = document.querySelector(".foot");
    if (foot) foot.innerHTML = `<span class="av">${ini}</span><div><div style="color:var(--side-hi)">${name}</div><div style="font-size:11px">${label}</div></div><button class="iconbtn" aria-label="Sign out" style="margin-left:auto;color:inherit">${ic("log-out", "sm")}</button>`;
    // page gate, like <NavGate>
    const page = window.__wfPage;
    const gate = document.getElementById("wf-gate");
    const blocked = page && page !== "index" && !allowed.has(page);
    document.getElementById("content").classList.toggle("hidden-role", blocked);
    gate.classList.toggle("hidden-role", !blocked);
    if (blocked) gate.innerHTML = `<div class="noaccess">${ic("shield-check", "lg")}<h2 class="h" style="justify-content:center">You don't have access to ${window.__wfTitle}</h2><p class="muted">Your role (${label}) can't open this page. Ask an owner to add it under Team → Access.${page === "dashboard" ? " Dashboard shows financial data and is owner-only." : ""}</p><a class="btn" href="welcome.html">${ic("home")}Go to Home</a></div>`;
    // bell only for roles that can see stock and shipments
    const bell = document.getElementById("wf-bell");
    if (bell) bell.classList.toggle("hidden-role", !(allowed.has("skus") || allowed.has("shipments")));
    const sel = document.getElementById("wf-role"); if (sel) sel.value = role;
  }
  window.WF_role = r => { store.set("role", r); applyRole(r); };

  // ---------- alerts (mock of detectAlerts output) ----------
  const ALERTS = [
    ["alert-triangle", "<b>A2-WHT</b> runs out in 1.3 weeks", "Below safety stock · Paper Co lead 21d", false],
    ["truck", "<b>PO-2231</b> is 4 days late", "FrameWorks · expected 20 Nov", false],
    ["alert-triangle", "<b>A3-BLK</b> runs out before PO-2234 lands", "2.4 weeks cover", false],
    ["check-circle-2", "<b>PO-2228</b> delivered, stock applied", "+200 FR-OAK-A3", true],
  ];
  function alertsPop() {
    const unread = ALERTS.filter(a => !a[3]).length;
    return `<button class="iconbtn" id="wf-bell" aria-label="Alerts, ${unread} unread" aria-haspopup="true" aria-expanded="false" onclick="var p=document.getElementById('wf-pop');p.classList.toggle('open');this.setAttribute('aria-expanded',p.classList.contains('open'))">${ic("bell", "sm")}<span class="badge">${unread}</span></button>
      <div class="pop" id="wf-pop" role="dialog" aria-label="Alerts"><div class="ph2">Alerts <span class="btn ghost sm" role="button" tabindex="0">${ic("check-circle-2")}Mark all read</span></div>
      ${ALERTS.map(a => `<div class="al ${a[3] ? "read" : ""}">${ic(a[0], "sm")}<div>${a[1]}<div class="small muted">${a[2]}</div></div></div>`).join("")}
      <div class="small muted" style="padding:10px 14px">Same alerts feed the “Needs you today” box on Home.</div></div>`;
  }

  // ---------- command palette ----------
  const PALETTE = [
    ["Jump to", "package", "SKUs", "G then S", "skus.html"], ["Jump to", "truck", "Shipments", "G then H", "shipments.html"], ["Jump to", "life-buoy", "CS cases", "G then C", "cs-cases.html"],
    ["Records", "package", '<span class="mono">A2-WHT</span>&nbsp; A2 · White', "SKU", "skus.html"], ["Records", "truck", '<span class="mono">PO-2231</span>&nbsp; FrameWorks', "Shipment", "shipments.html"],
    ["Records", "calendar-days", "Black Friday", "Event", "demand-events.html"], ["Records", "users", "Paper Co", "Supplier", "skus.html"],
    ["Actions <span class=\"new\">New</span>", "plus", "New CS case", "C", "cs-cases.html"], ["Actions <span class=\"new\">New</span>", "arrow-left-right", "Log stock movement", "M", "movements.html"],
    ["Actions <span class=\"new\">New</span>", "moon", "Switch theme", "Ctrl Shift L", null],
  ];
  function buildPalette() {
    const cmdk = document.createElement("div");
    cmdk.className = "cmdk"; cmdk.setAttribute("role", "dialog"); cmdk.setAttribute("aria-modal", "true"); cmdk.setAttribute("aria-label", "Command palette");
    let last = "", html = "";
    PALETTE.forEach((p, i) => { if (p[0] !== last) { html += `<div class="grp2">${p[0]}</div>`; last = p[0]; } html += `<div class="it" role="option" data-i="${i}" ${p[4] ? `data-href="${p[4]}"` : ""}>${ic(p[1])}${p[2]}<kbd>${p[3]}</kbd></div>`; });
    cmdk.innerHTML = `<div class="box2"><div class="q" style="display:flex;gap:10px;align-items:center">${ic("search")}<span>Search SKUs, events, POs, suppliers… <span class="muted small">(/ or Ctrl K)</span></span></div><div role="listbox" id="wf-opts">${html}</div><div class="small muted" style="padding:8px 16px;border-top:1px solid var(--line)">↑ ↓ to move · Enter to open · Esc to close</div></div>`;
    document.body.appendChild(cmdk);
    let cur = 0;
    const items = () => Array.from(cmdk.querySelectorAll(".it"));
    const paint = () => items().forEach((el, i) => { el.classList.toggle("on", i === cur); el.setAttribute("aria-selected", String(i === cur)); });
    const run = el => { if (!el) return; if (el.dataset.href) location.href = el.dataset.href; else { WF_setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); close(); } };
    const open = () => { document.body.classList.add("cmdk-open"); cur = 0; paint(); };
    const close = () => document.body.classList.remove("cmdk-open");
    window.WF_palette = open;
    cmdk.addEventListener("click", e => { if (e.target === cmdk) close(); const it = e.target.closest(".it"); if (it) run(it); });
    document.addEventListener("keydown", e => {
      const inField = /input|textarea|select/i.test((e.target.tagName || ""));
      const isOpen = document.body.classList.contains("cmdk-open");
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !inField && !isOpen)) { e.preventDefault(); isOpen ? close() : open(); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); WF_setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); }
      else if (e.key === "Escape") { close(); document.body.classList.remove("nav-open"); const p = document.getElementById("wf-pop"); if (p) p.classList.remove("open"); }
      else if (isOpen && e.key === "ArrowDown") { e.preventDefault(); cur = Math.min(cur + 1, items().length - 1); paint(); }
      else if (isOpen && e.key === "ArrowUp") { e.preventDefault(); cur = Math.max(cur - 1, 0); paint(); }
      else if (isOpen && e.key === "Enter") { e.preventDefault(); run(items()[cur]); }
    });
  }

  function themeToggle() {
    const b = (t, icon, label) => `<button data-t="${t}" aria-label="${label}" title="${label}" aria-pressed="false" onclick="WF_setTheme('${t}')">${ic(icon, "sm")}</button>`;
    return `<span class="theme-btn" role="group" aria-label="Theme">${b("system", "monitor", "System theme")}${b("light", "sun", "Light theme")}${b("dark", "moon", "Dark theme")}</span>`;
  }

  // ---------- page shell ----------
  window.WF = function (cfg) {
    window.__wfPage = cfg.page; window.__wfTitle = cfg.title || cfg.page;
    const content = document.getElementById("content");
    content.setAttribute("role", "main"); content.id = "content"; content.tabIndex = -1;
    if (store.get("collapsed", "0") === "1") document.body.classList.add("collapsed");

    const nav = NAV.map(s =>
      `<div class="navgrp">${s.g ? `<div class="grp">${s.g}</div>` : `<div class="grp-gap" style="height:6px"></div>`}<div class="nav">` +
      s.items.map(([k, label, href, icon, ct, off]) =>
        `<a href="${href}" data-key="${k}" class="${k === cfg.page ? "on" : ""} ${off ? "off" : ""}" ${k === cfg.page ? 'aria-current="page"' : ""} title="${off ? "Order submission is out of scope for this redesign" : label}" ${off ? 'aria-disabled="true" tabindex="-1"' : ""}>${ic(icon)}<span class="lb">${label}</span>${ct ? `<span class="ct" aria-label="${ct} items">${ct}</span>` : ""}</a>`
      ).join("") + `</div></div>`
    ).join("");
    const crumb = (cfg.crumb || []).map((c, i, a) => i === a.length - 1 ? `<b>${c}</b>` : c).join(" &nbsp;/&nbsp; ");
    const dept = store.get("dept", "framed");

    const app = document.createElement("div");
    app.className = "app";
    app.innerHTML = `
      <a class="skip" href="#content">Skip to content</a>
      <aside class="side" aria-label="Main navigation">
        <div class="ws"><a href="index.html" title="Wireframe index"><img class="logo-img" src="assets/inka-arthouse-logo.png" alt="Inka Arthouse"></a>
          <select class="loc" aria-label="Switch location (reloads the app)" title="Switching location reloads the app"><option>AU</option><option>UK</option><option>US</option></select></div>
        <button class="search" style="font:inherit;color:inherit;background:none;cursor:pointer;width:calc(100% - 20px)" onclick="WF_palette()" aria-label="Search or jump to (slash or Ctrl K)"><span style="display:inline-flex;gap:6px;align-items:center">${ic("search", "sm")}<span class="stxt">Search or jump to…</span></span><kbd>/</kbd></button>
        <nav>${nav}</nav>
        <div class="foot"></div>
      </aside>
      <div class="scrim" onclick="document.body.classList.remove('nav-open')"></div>
      <section class="main">
        <header class="top">
          <button class="iconbtn hamb" aria-label="Open menu" onclick="document.body.classList.add('nav-open')">${ic("menu")}</button>
          <button class="iconbtn collapse-btn" aria-label="Collapse sidebar" aria-pressed="${document.body.classList.contains("collapsed")}" title="Collapse sidebar" onclick="document.body.classList.toggle('collapsed');this.setAttribute('aria-pressed',document.body.classList.contains('collapsed'));try{localStorage.setItem('wf-collapsed',document.body.classList.contains('collapsed')?'1':'0')}catch(e){}">${ic("panel-left-close", "sm")}</button>
          <span class="crumb">${crumb}</span>
          ${cfg.ownerOnly ? `<span class="owner-only">${ic("shield-check", "sm")}Owner only</span>` : ""}
          <span class="sp"></span>
          <span class="seg ${cfg.dept ? "" : "hide-md"}" role="group" aria-label="Department" data-roles="owner manager staff" title="Filters Sales entry, Dashboard, Order builder and forecasts">
            <button aria-pressed="${dept === "framed"}" onclick="WF_dept('framed')">Framed</button><button aria-pressed="${dept === "unframed"}" onclick="WF_dept('unframed')">Unframed</button></span>
          <label class="small hide-md" for="wf-scn" data-roles="owner manager">Scenario</label>
          <select id="wf-scn" class="sel-mini hide-md" data-roles="owner manager"><option>Base</option><option>+15%</option><option>−15%</option><option>Xmas plan (saved)</option></select>
          <span class="pill env hide-sm" style="display:inline-flex;gap:4px;align-items:center" title="Shown only outside production">${ic("database", "sm")}staging</span>
          <span class="hide-sm">${themeToggle()}</span>
          ${alertsPop()}
          <button class="iconbtn" aria-label="More" title="More">${ic("more-horizontal", "sm")}</button>
        </header>
        <div class="scroll" id="scroll"><div id="wf-gate" class="hidden-role"></div></div>
      </section>`;
    document.body.prepend(app);
    app.querySelector("#scroll").appendChild(content);
    decorate(content);
    setupStates(content, cfg);
    // narrow screens: side panel starts closed (opens when a row/card is clicked); notes start hidden on phones
    if (window.innerWidth < 1100) content.querySelectorAll(".peek").forEach(p => p.classList.add("closed"));
    const notesPref = store.get("notes", window.innerWidth < 768 ? "hide" : "show");
    if (notesPref === "hide") document.body.classList.add("hide-notes");
    buildPalette();
    applyTheme();

    // annotations
    if (cfg.notes && cfg.notes.length) {
      const n = document.createElement("aside");
      n.className = "notes"; n.setAttribute("aria-label", "Design notes");
      n.innerHTML = `<h5>Design notes <button onclick="document.body.classList.add('hide-notes');try{localStorage.setItem('wf-notes','hide')}catch(e){}" aria-label="Hide design notes">hide ✕</button></h5><ol>` +
        cfg.notes.map((t, i) => `<li><span class="pin">${i + 1}</span><span>${t}</span></li>`).join("") + `</ol>`;
      document.body.appendChild(n);
    }

    // wireframe-only controls
    const bar = document.createElement("div");
    bar.className = "wfbar"; bar.setAttribute("aria-label", "Wireframe controls");
    bar.innerHTML = `<b>WIREFRAME</b>
      <label>Preview as <select id="wf-role" onchange="WF_role(this.value)"><option value="owner">Owner</option><option value="manager">Manager</option><option value="staff">Staff</option><option value="cs">CS</option><option value="kiosk">Kiosk</option></select></label>
      <label>State <select id="wf-state" onchange="WF_state(this.value)"><option value="normal">Normal</option><option value="loading">Loading</option><option value="empty">Empty</option><option value="error">Error</option></select></label>
      <span class="hide-sm" style="display:none"></span>
      <button onclick="document.body.classList.toggle('hide-notes');try{localStorage.setItem('wf-notes',document.body.classList.contains('hide-notes')?'hide':'show')}catch(e){}">Notes</button>`;
    document.body.appendChild(bar);
    applyRole(store.get("role", "owner"));
  };
  window.WF_dept = d => { store.set("dept", d); document.querySelectorAll('.seg[aria-label="Department"] button').forEach((b, i) => b.setAttribute("aria-pressed", String((i === 0) === (d === "framed")))); toast("Showing " + (d === "framed" ? "Framed (China-supplied SKUs)" : "Unframed (A0–A4 prints)")); };

  // index page
  window.WF_index = function () {
    const top = document.querySelector(".index-top");
    if (top) top.insertAdjacentHTML("beforeend", themeToggle());
    document.querySelectorAll(".tile[data-icon]").forEach(t => { const b = t.querySelector("b"); b.style.display = "flex"; b.style.gap = "8px"; b.style.alignItems = "center"; prepend(b, t.dataset.icon); });
    decorate(document.body);
    applyTheme();
  };
})();
