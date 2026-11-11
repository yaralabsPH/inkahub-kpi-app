# Spec: <feature name>

- Slug: `<slug>`
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

## Risks and open questions

- ...
