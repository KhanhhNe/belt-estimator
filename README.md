# belt-estimator

BELT attendance dashboard with an Express.js backend running directly on Cloudflare Workers.

## Prerequisites

- Node.js 18+ (recommended)

## Install

```bash
npm install
```

## Environment

Create a `.env` file from `.env.example`.

Required keys:

- `PASSWORD_HASH_SECRET`

For local Cloudflare Worker development, create `.dev.vars` from `.dev.vars.example`.

No local D1 credentials are required when `wrangler.jsonc` has
`d1_databases[].remote = true`.

## Run (local Worker)

```bash
npm run dev
```

The app starts on `http://localhost:8787` by default.

## Cloudflare Workers setup

Wrangler is installed locally in this project.

1. Authenticate with Cloudflare:

```bash
npx wrangler login
```

2. Set Worker secrets in Cloudflare:

```bash
npx wrangler secret put PASSWORD_HASH_SECRET
```

3. Run Worker locally:

```bash
npm run cf:dev
```

4. Deploy to Cloudflare:

```bash
npm run cf:deploy
```

Worker configuration lives in `wrangler.jsonc`.

## Backend architecture

- Backend logic is centralized in `src/worker.mjs`.
- The Worker uses Express via Cloudflare's Node.js HTTP bridge (`httpServerHandler`).

## Drizzle commands

```bash
npm run db:push
npm run db:generate
npm run db:migrate
npm run db:studio
```

## D1 migrations (Cloudflare)

Apply all SQL files in `drizzle/` to remote D1:

```bash
Get-ChildItem -Path drizzle -Filter *.sql | Sort-Object Name | ForEach-Object { npx wrangler d1 execute belt-estimator --remote --file "$($_.FullName)" --yes }
```
