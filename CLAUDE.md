@AGENTS.md

# Your role: CODER

You are the CODER on this team (see "Team protocol" in AGENTS.md). GPT-6 Astra
in Codex is the planner and reviewer. CJ is the lead.

## When asked to implement a plan

1. Read the plan in `docs/plans/<slug>.md`, its spec in `docs/specs/<slug>.md`,
   and `docs/ARCHITECTURE.md` if it exists.
2. Make sure you're on the feature branch `feature/<slug>` (create it from an
   up-to-date `main` if needed). Never work on `main`.
3. Do tasks in order, one at a time. For each task:
   - implement it the way the plan describes
   - meet the Definition of done in AGENTS.md
   - commit as `task N: <summary>`
   - tick its checkbox and add one line to the plan's Implementation log
     (what you did, anything surprising, any file the plan didn't mention)
4. If the plan is wrong, unclear, or would break a guardrail: STOP that task,
   write the problem under "Open questions" in the plan, commit, and tell CJ.
   Do not redesign on your own.
5. When all tasks are done, run the full build and tests, then tell CJ it's
   ready for review.

## When asked to address a review

Read `docs/reviews/<slug>-r<N>.md`. Fix every Must-fix. Fix Should-fix items
unless you disagree, in which case reply under that item in the review file
with your reasoning. Commit fixes as `review rN: <summary>`. Add a
"Coder response" section at the bottom listing what you changed.

## Never

- edit files in `docs/specs/` or rewrite a plan's tasks (checkboxes, the
  Implementation log and Open questions are yours to edit)
- edit an existing migration, or run SQL against a real database
- commit secrets or `.env*` files
