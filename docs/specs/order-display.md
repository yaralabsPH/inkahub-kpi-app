# Spec: Clearer order screen

- Slug: `order-display` · Roadmap ID: `F2` (see `docs/ROADMAP.md`)
- Status: approved by CJ on 2026-11-20
- Author: planner (Codex)

## Problem

Production workers must read each order line quickly from about one metre away. The current line card uses small text and a small colour chip, so the product, size, and frame colour are easy to miss.

## Goals

- Make the product title, size, framed state, and frame colour easy to scan.
- Make black, white, and natural frames unmistakable in light and dark mode.
- Reserve a stable artwork-thumbnail area for F3 without loading an image.
- Keep all existing verification, routing, orientation, quantity, and completion behaviour.

## Non-goals

- Do not fetch, generate, store, or backfill artwork images. That is F3.
- Do not change order ingestion, SKU routing, item counting, APIs, database schema, or permissions.
- Do not redesign the rest of the Production page.

## Approaches

1. Enlarge the existing inline markup. This makes the smallest diff, but keeps presentation logic inside the already large `Production.tsx` and is difficult to test directly.
2. Extract a focused order-line display component and a pure SKU-to-display helper. This is selected because it isolates the visual change, reuses the current parser, and permits fast tests without changing order behaviour.
3. Redesign the complete Production page. This is rejected because it expands the scope and increases shop-floor regression risk.

## User stories / flows

- As a production worker, I can identify the product, size, framed state, and frame colour at a glance.
- As a production worker, I can distinguish frame colours by both colour and text.
- As a production worker, I see a clear placeholder where the future artwork image will appear.

## Acceptance criteria

- [ ] Each order line shows the product title as the main, wrapping heading.
- [ ] Each parsed print line shows `Framed` or `Unframed` and shows its size in bold.
- [ ] Black, white, and natural variants use large labelled colour blocks with sufficient contrast in light and dark mode.
- [ ] Unframed and canvas lines use clearly labelled neutral blocks and never imply a frame colour.
- [ ] Picture-frame-only variants show their actual colour and do not claim to be a print.
- [ ] Unknown or legacy SKUs keep the Shopify variant description visible and do not guess a colour.
- [ ] Every line includes a non-interactive artwork placeholder. It performs no network request.
- [ ] Quantity, orientation, SKU, department, verification status, Verify, and Undo remain available and behave as before.
- [ ] Long titles wrap instead of hiding important text.
- [ ] The layout remains readable in light and dark mode and at the existing tablet breakpoint.

## Data and backend impact

- Tables / migrations needed: none.
- Repository interface changes (both Dexie and Supabase): none.
- `api/` endpoints touched: none.
- RLS / role access: unchanged.

## Staging test plan

1. Open the staging Production page on the tablet-sized viewport.
2. Scan or load an order containing black, white, natural, and unframed examples when available.
3. Confirm the title, framed state, bold size, large labelled colour block, quantity, and future-image placeholder.
4. Switch light and dark mode. Confirm that white has a visible border and all labels remain readable.
5. Use Verify and Undo on a line. Confirm the state and controls still work.
6. Check a long product title and a legacy SKU. Confirm no required order detail disappears.
7. Run the standard Production smoke test from `docs/RELEASING.md`.

## Hardening

- Failure modes: no new network or write path. Unknown and legacy SKUs show existing fallback text and an `Unknown style` block instead of guessed data.
- Data correctness: presentation derives from the existing shared SKU parser. It does not change counts, routing, attribution, events, or history.
- Security: no endpoint, table, permission, secret, or user-provided HTML is added.
- Release and rollback: code-only, backward-compatible UI change. Rollback is the previous frontend build. No feature flag is needed because no workflow or saved data changes.
- Performance: pure local derivation per rendered line. No query, external request, image request, or new dependency.
- Operations: existing Production workflow remains the fallback. A frontend rollback restores the old cards. No ongoing maintenance is added.
- Tests: unit tests cover each current variant family, unknown/legacy fallback, labels, and accessible rendered content. The existing full suite, type-check, and build must pass.

## Roadmap decisions honoured

- Product title is large: it is the card heading and wraps.
- Framed or unframed is explicit: it is shown as text, not inferred from colour.
- Size is bold: it has a dedicated bold label.
- Frame colour is the most important visual: framed lines use a large labelled colour block.
- Natural, black, and white are unmistakable in dark mode: each has a distinct fill, border where needed, and a text label.
- Images come from F3: this feature reserves a placeholder only.

## Risks and open questions

- A legacy Shopify variant title can be inconsistent. The UI preserves it and does not infer a colour unless the current SKU parser returns a supported variant.

