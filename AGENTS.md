# AGENTS.md — Inka Arthouse Hub

Shared instructions for every AI agent working in this repo. Codex reads this
file automatically; Claude Code reads it through `CLAUDE.md`.

## 1. What this app is

Inka Arthouse Hub is the production, stock and KPI app for Inka Print House
(Inka Arthouse). It covers SKUs and stock, weekly sales, shipments, warehouse
layout, paper usage, customer-service cases and returns, production
tracking (kiosk, clock in/out, benchmarks), team permissions and reports.

The source was recovered from a local folder and imported into git
(see README "Recovery scope"). Treat unfamiliar code as load-bearing until
proven otherwise.

## 2. Stack

- React 18 + TypeScript (strict) + Vite 5 + Tailwind 3
- Routing: react-router-dom 6 · Server state: TanStack Query 5 · Client state: zustand
- Validation: zod (`src/lib/domain/schemas.ts`)
- Data backends, switched by `VITE_BACKEND`:
  - `dexie` — local browser IndexedDB (default, single user, no auth)
  - `supabase` — Postgres + auth + RLS, used in production
- Server endpoints: Vercel functions in `api/` (Shopify, Dropbox artwork, daily digest email via Resend)
- Scheduled jobs: `vercel.json` crons hit `/api/reports/daily-digest` per location (au/uk/us)
- Tests: vitest

## 3. Commands

```sh
npm ci                 # install
npm run dev            # Vite dev server (frontend only; api/ needs `vercel dev`)
npx tsc -b             # type-check
npm run build          # type-check + production build
npm run test -- --run  # run tests once
```

Baseline on import: type-check clean, build passes, 35/35 tests pass.
Keep it that way.

## 4. Map of the code

- `src/pages/` — one file per screen (routes declared in `src/App.tsx`)
- `src/components/` — feature cards/modals; `ui/` primitives; `layout/` shell
- `src/lib/domain/` — types, zod schemas, pure business logic (best place for tests)
- `src/lib/repository/` — the data layer:
  - `Repository.ts` — storage-agnostic interface
  - `dexie/DexieRepo.ts` and `supabase/SupabaseRepo.ts` — the two implementations
- `src/lib/hooks/` — TanStack Query hooks used by pages
- `src/lib/auth/` — Supabase auth + role/nav permissions (`allowed_nav`)
- `src/lib/forecasting/` — demand forecasting
- `api/` — Vercel serverless endpoints (NOT covered by `tsc -b`; `tsconfig.json` includes only `src`)
- `supabase/migrations/` — numbered SQL migrations (recovered snapshot)

`docs/ARCHITECTURE.md` holds the deeper map once the planner writes it.

## 5. Guardrails (read before changing anything)

1. **Two backends, one interface.** Any change to `Repository.ts` must be
   implemented in BOTH `DexieRepo.ts` and `SupabaseRepo.ts`, or the plan must
   state why one is out of scope.
2. **Migrations are append-only.** Never edit an existing file in
   `supabase/migrations/`. Add the next number (`0034_...sql`). Note: `0027` is
   missing from the recovered set. Never apply SQL to a live database; that
   is a human step.
3. **RLS and roles matter.** Roles are owner, manager, staff, kiosk and cs (see migrations 0001, 0028, 0032). New tables
   need RLS policies and grants consistent with existing migrations.
4. **Secrets stay server-side.** Only `VITE_*` values reach the browser.
   Shopify, Dropbox, Resend and the Supabase service-role key belong in `api/`
   via `process.env`. Never commit `.env*` files (other than `.env.example`).
5. **`.gitignore` is a whitelist.** It ignores everything at the root except
   listed paths. A new top-level file or folder must be added to the
   whitelist or git will silently skip it.
6. **Inventory math is money.** Stock deduction, idempotency and ledger code
   (see migrations 0025, 0026, 0031) need tests for any behavior change.
7. Don't add dependencies without saying why in the plan.
8. **Production is live.** Real staff use this app all day. Every change must
   be safe to roll back:
   - Migrations follow expand-then-contract (see `docs/RELEASING.md`): add
     tables, nullable columns, indexes; never drop, rename, retype or add
     NOT NULL in the same release as the code that needs it. Old code must
     keep working on the new schema. CI rejects edits to existing migrations.
   - Never point anything at the production database during development or
     testing. Testing uses Dexie or the staging Supabase project.
   - Every spec includes a staging test plan; every plan includes release and
     rollback notes.
   - Agents never merge to `main`, deploy, or apply SQL. Those are CJ's steps.

## 6. Team protocol (planner + coder)

| Role | Who | Writes | Never |
|---|---|---|---|
| PLANNER / reviewer | GPT-6 Astra in Codex | `docs/specs/`, `docs/plans/`, `docs/reviews/`, `docs/ARCHITECTURE.md` | edits app code |
| CODER | Claude Opus in Claude Code | app code, tests, checkboxes and log in the active plan | changes the plan's scope on its own |
| LEAD | CJ (human) | approves specs and plans, tests, merges | — |

Rules:

- **The plan is the contract.** If the coder hits something the plan didn't
  foresee, it stops and writes it under "Open questions" in the plan. It does
  not improvise a different design.
- **One writer at a time.** Only one agent edits the repo at once. Commit before
  every handoff.
- **One feature = one branch** named `feature/<slug>`. Never commit to `main`
  directly.
- **Files, not chat.** Decisions go into the spec or plan. Chat context is lost;
  the docs are what the other agent reads.
- **Automated loop.** When the coder runs `/loop <slug>`, it calls the
  planner through `codex exec`. In that mode the planner writes only the file
  it was asked for and does not commit; the coder commits it. CJ still
  approves the spec and the plan, and still does every release step.
- File names: `docs/specs/<slug>.md`, `docs/plans/<slug>.md`,
  `docs/reviews/<slug>-r<N>.md`. Templates live in `docs/templates/`.

## 7. Definition of done (every task)

- [ ] `npx tsc -b` passes
- [ ] `npm run test -- --run` passes, with new tests for new logic
- [ ] `npm run build` passes (run at least once per feature, before review)
- [ ] One commit per task: `task N: <summary>`
- [ ] CI green on the pull request (`.github/workflows/ci.yml`)
- [ ] Plan checkbox ticked and one line added to the plan's Implementation log
