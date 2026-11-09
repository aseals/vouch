# Vouch

Listing checks and dispute evidence for Whop sellers. A product of Together Engineering, LLC.

## Layout

- `app/` – v2 (in progress, running on the Railway test copy `vouch-v2-staging`)
  - `index.tsx` – the whole app: one Bun/TypeScript file, Postgres via `Bun.sql`
  - `test/run.ts` – integration tests (local Postgres + saved Whop page fixtures)
  - `test/unit.ts` – unit tests (claim flags, Whop token checks, link tokens)
  - `build-railway.sh` – builds `dist/index.railway.tsx`, a minified copy under Railway's function size limit
- `v1/index.tsx` – the version live on Railway service `vouch-app` until v2 replaces it

## Run tests

```sh
cd app
bun test/unit.ts
bun test/run.ts   # needs a local Postgres; see the top of the file
```

## Deploy (Railway function)

```sh
cd app && ./build-railway.sh   # writes dist/index.railway.tsx
```

Paste or push `dist/index.railway.tsx` as the function source. Secrets (Whop keys, admin and link secrets) live only in Railway variables, never in this repo.
