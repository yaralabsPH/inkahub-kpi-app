# Spec: <feature name>

- Slug: `<slug>` · Roadmap ID: `<F#>` (see `docs/ROADMAP.md`)
- Status: draft | approved by CJ on <date>
- Author: planner (GPT-6 Astra)

## Problem

What's wrong or missing today, and who feels it (owner, manager, staff, kiosk, cs)?

## Goals

- ...

## Non-goals

What we are deliberately NOT doing in this feature.

- ...

## User stories / flows

- As a <role>, I want <action> so that <outcome>.

## Acceptance criteria

Concrete, checkable statements. CJ tests against these before merging.

- [ ] ...

## Data and backend impact

- Tables / migrations needed:
- Repository interface changes (both Dexie and Supabase):
- `api/` endpoints touched:
- RLS / role access:

## Staging test plan

How CJ will prove this works on the Vercel preview (staging database) before
release. List the steps per role, plus which parts of the smoke test in
`docs/RELEASING.md` are most at risk.

- ...

## Hardening

Answer every section of `docs/HARDENING.md` for this feature (failure modes,
data correctness, security, release and rollback, performance, operations,
tests). Write "n/a" with a reason where a section doesn't apply.

## Roadmap decisions honoured

List each Decided point from this feature's section of `docs/ROADMAP.md` and
how the spec meets it.

## Risks and open questions

- ...
