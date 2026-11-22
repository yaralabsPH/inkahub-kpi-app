# Plan: Station order screen redesign

- Slug: `station-screen-redesign` · Spec: none (CJ approved building directly from this plan, 2026-11-22)
- Branch: `feature/station-screen-redesign`
- Status: approved by CJ on 2026-11-22
- Brief: CJ's `IMPLEMENTATION_PROMPT.md` + `framing-station-reference.html` (UI reference prototype, light theme)

## Approach

Rebuild the signed-in station screen (waiting-for-order and working-on-order
states) to match the reference: a fixed 340px sidebar (order, progress
segments, done list, Complete / Scrap) and an item list with its own scroll,
grouped into TO FRAME / PACK FLAT, with fixed-height cards, a glowing
"current" card, solid-green done cards and a confirmation toast.

Presentation only. The new `StationOrderScreen` receives the same data and
handlers `ActiveScreen` already gets (verify, unverify, complete, scrap,
clear, manual lookup, packages, clock-out). No query, endpoint, table, event
type or dependency changes. Frame/size labels come from the existing F2
helper `getOrderLinePresentation`; pure screen logic (grouping, current line,
progress, piece counting, done-list order) lives in a tested module.

The old screen stays in the code. `Production.tsx` picks the screen through
one switch, `useStationUi()`: new by default, classic when
`VITE_STATION_UI=classic` (build-time, rollback) or `?ui=classic` (per tab,
for side-by-side testing).

## CJ decisions (2026-11-22)

- A. Complete order is locked until every line this station must check is
  verified ("No verify needed" lines count as done). Classic screen keeps the
  old "at least one verified" rule, so rolling back restores it.
- B. Framed, A0 Framed and Unframed get the new screen (box panel kept in the
  sidebar where the station needs it). Dispatch keeps the classic screen
  until F7.
- C. No separate spec; Astra reviews the finished branch.

## Gaps vs the reference (accepted)

1. No scan-to-check: scans are lanyard / box / order only. The "or scan
   barcode" hint is dropped.
2. Quantity > 1: piece counts are screen-only state; the existing per-line
   verify is called on the last piece. A reload mid-line resets the piece
   count; verified lines stay verified.
3. No artwork thumbnails until F3: placeholder inside a frame-coloured border.
4. No per-order "completed today" list or Reopen: sidebar shows the existing
   counts only.
5. "Scanner live" reflects whether the page has keyboard focus (scans are
   lost without it), not hardware state.
6. Kept although the reference doesn't show them: box panel, CS replacement
   banner, order notes, other-department lines, "No verify needed" lines,
   set badges, errors, dark mode, Clock out.

## Tasks

### [ ] Task 1: Screen logic module

- Files: `src/components/production/station/stationScreenModel.ts`,
  `src/components/production/station/__tests__/stationScreenModel.test.ts`
- Do: line view (group, short size, frame label/colour, needs-check),
  progress (required / checked / remaining / current / pieces / group
  counts), piece counting, done-list ordering, `useStationUi` switch logic.
- Done when: tests cover framed/unframed/canvas/frame-only/gift/legacy
  lines, other-department lines, qty > 1 pieces, current-line selection and
  the classic switch.

### [ ] Task 2: Design tokens and fonts

- Files: `tailwind.config.js`, `index.html`
- Do: add the reference colours, radii and Inter / JetBrains Mono families;
  load fonts from Google Fonts with system fallbacks.
- Done when: build passes; existing pages unchanged (tokens are additive).

### [ ] Task 3: New station screen

- Files: `src/components/production/station/StationOrderScreen.tsx`,
  `src/components/production/station/__tests__/StationOrderScreen.test.tsx`
- Do: top bar, sidebar (working + idle), grouped list, cards and states,
  inline scrap confirm, toast, auto-scroll, reduced motion, dark mode.
- Done when: render tests cover the groups, current/done/partial states,
  locked/ready Complete and the idle screen.

### [ ] Task 4: Wire the switch and Complete rule

- Files: `src/pages/Production.tsx`
- Do: render `StationOrderScreen` for non-dispatch stations unless classic;
  share the clock-out write; gate Complete on all required lines when the new
  screen is active.
- Done when: type-check, tests and build pass; classic screen still renders
  with `?ui=classic`.

## Hardening in the plan

- No data writes change; every write still goes through the existing
  handlers (Task 4 only reorders which component calls them).
- Complete gating is UI + handler side, never weaker than today.
- Rollback: `VITE_STATION_UI=classic` + redeploy, or revert the branch.

## Release and rollback

- Migrations: none.
- Rolling back leaves the database untouched (no schema or data change).
- Manual steps at release: none required. Optional rollback env var
  `VITE_STATION_UI=classic`.
- Follow-up: remove the classic screen once the new one has run a few weeks.

## Out of scope

- Scan-to-check items, thumbnails (F3), dispatch screen (F7), lanyard screen.

## Open questions

-

## Implementation log

-
