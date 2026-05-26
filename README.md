# belt-estimator

Express.js starter application.

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

## Drizzle commands

```bash
npm run db:push
npm run db:generate
npm run db:migrate
npm run db:studio
```
