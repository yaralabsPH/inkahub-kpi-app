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

## Automated loop (started by `/loop <slug>`)

In this mode you drive the whole loop and call Astra yourself through the
Codex CLI. CJ approves the spec before you start and the plan in the middle.

### How to call Astra

Run Codex from the repo root, in the background (it can take many minutes),
and wait for it to finish before you continue:

```sh
codex exec -m gpt-6-astra -c model_reasoning_effort="high" --sandbox workspace-write "<prompt>"
```

Every prompt to Astra starts with: "You are the PLANNER in this repo. Read
AGENTS.md and docs/ARCHITECTURE.md. Only write the file named below. Do not
edit app code. Do not commit, push, or run git commands that change state."
After Astra finishes, check `git status`: if it changed anything other than
the file you asked for, revert those changes and tell CJ. Then you commit
Astra's file yourself.

If the `codex` command is missing or fails twice, STOP and tell CJ the exact
error. Do not do the planner's work yourself.

### Steps

1. **Check the spec.** `docs/specs/<slug>.md` must exist and say
   "approved by CJ". If not, STOP and tell CJ to finish the spec with Astra
   in the Codex app first.
2. **Branch.** `git fetch origin main`, then create or switch to
   `feature/<slug>` from `origin/main`. Commit the spec there if it's new.
3. **Plan.** Ask Astra to write `docs/plans/<slug>.md` from
   `docs/templates/plan.md`, based on the approved spec. Commit it as
   `plan: <slug>`.
4. **CJ approves the plan.** Show CJ a short summary: the approach, the task
   list, any migration, and the release steps. Then STOP and wait. Continue
   only when CJ says the plan is approved. If CJ asks for changes, ask Astra
   to update the plan and show it again.
5. **Build.** Implement the plan as in "When asked to implement a plan" above.
6. **Review.** Ask Astra to review branch `feature/<slug>` against `main`, the
   spec, the plan and the AGENTS.md guardrails, run the type-check, tests and
   build, and write `docs/reviews/<slug>-r<N>.md` from
   `docs/templates/review.md`. Commit it as `review rN: Astra review`.
7. **Fix.** If the verdict is "changes required", address the review as in
   "When asked to address a review" above, then go back to step 6 with N+1.
8. **Round limit.** Stop after 3 review rounds. If round 3 is still not
   approved, tell CJ what's unresolved and wait.
9. **Hand over.** When the verdict is "approved": push `feature/<slug>`, open a
   pull request to `main` with a summary and the spec's staging test plan,
   and tell CJ it's ready for the release steps in `docs/RELEASING.md`.

Never merge, deploy, or apply SQL, even when the review is approved.

## Never

- edit files in `docs/specs/` or rewrite a plan's tasks (checkboxes, the
  Implementation log and Open questions are yours to edit)
- edit an existing migration, or run SQL against a real database
- commit secrets or `.env*` files
