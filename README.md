# Inka Arthouse Hub

Recovered application source for the Inka Arthouse production and KPI app.

The app uses React, TypeScript, Vite, and Tailwind CSS. It supports a local
Dexie backend and a Supabase backend. Server endpoints in `api/` provide
Shopify order lookup, Dropbox artwork images, and daily reports.

## Local development

```sh
npm ci
npm run dev
```

Copy `.env.example` to `.env.local` to configure the backend. The example
defaults to local Dexie mode. Production screens that require Supabase need
the project URL, public anon key, and `VITE_BACKEND=supabase`.

`npm run dev` serves the Vite frontend. The `api/` endpoints require a Vercel
development environment or deployment, with their server environment variables
configured separately. Shopify and Dropbox credentials belong on the server.

## Build and existing tests

```sh
npm run build
npm run test -- --run
```

## Source layout

- `src/` contains the application screens, components, and data access code.
- `api/` contains Vercel server endpoints.
- `public/` contains application assets.
- `supabase/migrations/` contains the recovered SQL migration files.
- `vercel.json` contains routing and scheduled daily-report configuration.

The SQL files are a recovered snapshot. Reconcile them with the target
database's migration history before applying them.

## Recovery scope

This repository starts a new Git history from the recovered source. The local
recovery folder also contains historical patch scripts, duplicate files, and
recovery metadata, which are excluded from version control alongside credentials,
installed dependencies, and generated build output.

The barcode attribution redesign and PrintQueue/custom-print integration discussed
for the next release are planned work. This import preserves the recovered app.
