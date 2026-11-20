# Plan: Clearer order screen

- Slug: `order-display` · Spec: `docs/specs/order-display.md`
- Branch: `feature/order-display`
- Status: approved by CJ on 2026-11-20

## Approach

Extract the visual portion of each Production order line into `OrderLineDisplay`. A pure `getOrderLinePresentation(sku, variantTitle)` helper will convert the existing parsed SKU into explicit style, size, and colour presentation data. `Production.tsx` will retain all event handlers and state; it will pass content and existing controls into the component so no workflow logic moves.

This follows the selected component-and-helper approach in the spec. It avoids adding dependencies and avoids growing the large Production page with more inline presentation rules.

## Global constraints

- Use the existing React 18, TypeScript, Tailwind, Vitest, and `skuRouting` helpers.
- Add no dependency, API, migration, query, storage access, or image request.
- Preserve all existing Production handlers and saved-event behaviour.
- Follow test-driven development: observe the new tests fail before production code is added.

## Review focus

- Black, white, and natural variants must have distinct labelled blocks in both themes.
- Unframed and canvas variants must not be labelled as framed colours.
- Picture-frame-only SKUs must show their colour without claiming to be a print.
- Unknown and legacy SKUs must retain fallback detail without invented attributes.
- Long product titles must wrap while Verify and Undo remain usable.

## Tasks

### [ ] Task 1: Add and integrate the order-line presentation

- Files: `src/components/production/OrderLineDisplay.tsx`, `src/components/production/orderLinePresentation.ts`, `src/components/production/__tests__/OrderLineDisplay.test.tsx`, `src/pages/Production.tsx`
- Interfaces:
  - `getOrderLinePresentation(sku: string, variantTitle: string | null): OrderLinePresentation`
  - `OrderLineDisplay` receives title, SKU, quantity, variant title, orientation, state flags, metadata badges, and existing verification controls as React nodes or callbacks.
- Do:
  1. Write table-driven tests with hand-derived expectations for `FB`, `FW`, `FN`, `UN`, `SC`, picture-frame variants, and an unknown SKU. Confirm the tests fail because the helper/component do not exist.
  2. Add the pure presentation helper. Reuse `parseSku` and `friendlySize`; return explicit kind, size label, style label, colour label, and a finite colour-tone key.
  3. Add server-rendered component tests that assert the user-visible title, size, framed state, colour text, artwork placeholder, quantity, and fallback description. Confirm they fail before the component exists.
  4. Implement `OrderLineDisplay` with a large wrapping title, bold size, large labelled colour block, accessible text, and a non-interactive placeholder. Keep responsive flex/grid behaviour and light/dark contrast.
  5. Replace only the current per-line visual markup in `Production.tsx`. Keep the existing list key, click behaviour, verification actions, badges, orientation, SKU text, and state styling.
  6. Run the focused tests, then `npm.cmd run test -- --run`, `npx.cmd tsc -b`, and `npm.cmd run build`.
  7. Commit the implementation and update this checkbox and the implementation log.
- Done when: the focused tests pass, all 353+ tests pass, type-check passes, build passes, and the diff contains no backend or dependency change.

## Hardening in the plan

- Bad or legacy SKU fallback: Task 1 helper table tests.
- Colour is not the only signal: Task 1 rendered text assertions.
- No external request or data mutation: Task 1 component boundary and final diff review.
- Existing workflow regression: Task 1 integration preserves handlers; full suite, type-check, build, and code review verify it.
- Performance: Task 1 uses only pure local parsing and no effects.

## Release and rollback

- Migrations: none.
- Rolling back the app leaves the database usable: yes, because the database is unchanged.
- Manual release steps for CJ: test the preview in light and dark mode, then use the normal frontend release process.
- Follow-up contract release: none. F3 can replace the placeholder later.

## Out of scope

- Artwork thumbnails, image loading, storage, order ingestion, SKU grammar changes, counting, and wider Production redesign.

## Open questions

- None.

## Implementation log

-
