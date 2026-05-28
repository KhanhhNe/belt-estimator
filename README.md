# belt-estimator

BELT attendance dashboard with an Express.js backend running directly on Cloudflare Workers.

## Prerequisites

- Node.js 18+ (recommended)

## Install

```bash
npm install
```

## Environment

Create a `.env` file from `.env.example` and fill in your Turso credentials.

Required keys:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `PASSWORD_HASH_SECRET`

For local Cloudflare Worker development, create `.dev.vars` from `.dev.vars.example`.

Required keys:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

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
npm run cf:secret:url
npm run cf:secret:token
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
