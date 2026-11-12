# Plan: <feature name>

- Slug: `<slug>` · Spec: `docs/specs/<slug>.md`
- Branch: `feature/<slug>`
- Status: draft | approved by CJ on <date>

## Approach

A few paragraphs: the design, why this approach over alternatives, and how it
fits the existing code (name the files and patterns it follows).

## Tasks

Each task is one commit. Keep them small enough that the diff is easy to review.

### [ ] Task 1: <title>

- Files: `src/...`
- Do: what to change, concretely
- Done when: the test or check that proves it (e.g. "new test in
  `src/lib/domain/__tests__/x.test.ts` covers A and B")

### [ ] Task 2: <title>

- Files:
- Do:
- Done when:

## Hardening in the plan

For each relevant `docs/HARDENING.md` item, name the task that handles it
(for example "idempotent retry → Task 3, test in Task 4").

## Release and rollback

- Migration(s) and why each is backward-compatible (expand-then-contract):
- Does rolling back the app leave the database usable by the old code? yes / no + why:
- Manual steps CJ must do at release (env vars, SQL, Shopify settings):
- Follow-up "contract" release needed later? (e.g. drop the old column)

## Out of scope

- ...

## Open questions

Coder writes here when it hits something the plan didn't foresee. Planner or
CJ answers inline.

-

## Implementation log

Coder adds one line per task.

-
