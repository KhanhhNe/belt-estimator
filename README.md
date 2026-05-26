# belt-estimator

BELT attendance dashboard with Node.js local server and Cloudflare Workers deployment.

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
- `PORT`

For local Cloudflare Worker development, create `.dev.vars` from `.dev.vars.example`.

Required keys:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

## Run

```bash
npm run dev
```

The app starts on `http://localhost:3000` by default.

Database ping endpoint:

- `GET /db/ping`

## Production start

```bash
npm start
```

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

## Drizzle commands

```bash
npm run db:push
npm run db:generate
npm run db:migrate
npm run db:studio
```
