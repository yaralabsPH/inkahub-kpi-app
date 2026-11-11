# Workflow playbook (for CJ)

How to run a feature through the planner (GPT-6 Astra in Codex) and the coder
(Claude Opus in Claude Code). The rules both agents follow are in `AGENTS.md`;
this page is the human side, with prompts to copy and paste.

## One-time setup

1. Clone or pull this repo onto your computer and open the SAME folder in both
   the Codex desktop app and Claude Code (Claude desktop app).
2. In Codex, pick GPT-6 Astra with high reasoning effort.
3. In Claude Code, pick Opus 5.5.
4. Onboard the planner. In Codex:

   > Read AGENTS.md, then read this whole codebase. Write docs/ARCHITECTURE.md
   > covering: the screens and what each does, the data flow from page →
   > hook → Repository → Dexie/Supabase, the database tables and which
   > migrations create them, roles and permissions, the api/ endpoints and
   > crons, and a "Risky or messy areas" section. Don't change any other file.
   > Commit it on a branch `docs/architecture`.

   Read it yourself, merge it. Every future plan gets better because of it.

## The loop for each feature

Pick a short slug, e.g. `barcode-attribution`.

**1. Spec — you + Codex/Astra**

> I want to [describe feature]. Read AGENTS.md and docs/ARCHITECTURE.md. Ask me
> questions until it's clear, then write docs/specs/<slug>.md using
> docs/templates/spec.md.

Read it. Edit or push back until it says exactly what you want. Mark it approved.

**2. Plan — Codex/Astra**

> Write docs/plans/<slug>.md from docs/templates/plan.md for the approved spec
> docs/specs/<slug>.md. Small tasks, one commit each, with files, approach and a
> "done when" check per task. Respect the guardrails in AGENTS.md. Create
> branch feature/<slug> and commit the spec and plan there.

Read the plan. This is the cheapest moment to catch a wrong direction.

**3. Build — Claude Code/Opus**

> Implement docs/plans/<slug>.md on branch feature/<slug>, task by task.

If it stops with an Open question, answer it in the plan (or ask Astra to),
then tell Opus to continue.

**4. Review — Codex/Astra**

> Review branch feature/<slug> against main. Check it against
> docs/specs/<slug>.md, docs/plans/<slug>.md and the AGENTS.md guardrails. Run
> the type-check, tests and build. Write docs/reviews/<slug>-r1.md from
> docs/templates/review.md and commit it. Don't change app code.

**5. Fix — Claude Code/Opus**

> Address docs/reviews/<slug>-r1.md.

Repeat 4 → 5 (r2, r3…) until the verdict is "approved".

**6. Ship — you**

Open a pull request from `feature/<slug>` to `main`. Then follow
`docs/RELEASING.md`: CI green, test the Vercel preview against staging, run
the smoke test, merge at a quiet time, watch, and roll back in Vercel if
anything goes wrong. The app is live, so never skip this step.

## Rules of thumb

- Only one agent works at a time. Wait for one to finish and commit before
  starting the other.
- If an agent is confused, the fix is usually a better document, not a longer
  chat. Update the spec, plan or AGENTS.md.
- Database migrations are written by the coder but applied to Supabase by you,
  after checking them.
- When an agent learns a lasting fact about the project (a gotcha, a
  convention), add it to AGENTS.md so both agents know it next time.
