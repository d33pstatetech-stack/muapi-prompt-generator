# MuAPI Prompt Generator

A prompt generator and generation playground for all [MuAPI](https://muapi.ai) models — image, video, audio, and 3D. Browse 600+ models, configure model-specific parameters, upload reference images, and generate directly through a Cloudflare Worker proxy.

**Live demo:** `https://muapi-prompt-generator.<your-subdomain>.workers.dev`

## Features

- **609 models** with full parameter schemas (types, enums, ranges, defaults) extracted from the live OpenAPI spec
- **Cloudflare D1** (SQLite) catalog — categories, families, pricing, parameter schemas
- **Worker proxy** — hides the MuAPI key, handles CORS, proxies generation + polling + file upload
- **Reference image support** — drag-and-drop / file picker / URL for `image_url`, `images_list`, `last_image`
- **Prompt templates** — product, portrait, landscape, cinematic, anime, logo, etc.
- **Saved prompts & history** — localStorage-backed
- **Live cost estimate** per model

## Architecture

```
public/          → Static frontend (Tailwind CDN, vanilla JS)
src/worker.js    → Cloudflare Worker (Static Assets + D1 + proxy)
migrations/      → D1 schema + seed
scripts/         → Seed generator (OpenAPI → D1 SQL)
```

## Quick Start

```bash
npm install

# 1. Create D1
npx wrangler d1 create muapi-models
# → paste database_id into wrangler.toml

# 2. Apply schema + seed
npx wrangler d1 execute muapi-models --local --file=migrations/0001_init.sql
node scripts/parse-openapi-seed.js
npx wrangler d1 execute muapi-models --local --file=migrations/0002_seed.sql

# 3. Set API key (local dev)
cp .dev.vars.example .dev.vars
# edit .dev.vars with your MUAPI_API_KEY

# 4. Dev
npx wrangler dev

# 5. Deploy
npx wrangler d1 execute muapi-models --remote --file=migrations/0001_init.sql
npx wrangler d1 execute muapi-models --remote --file=migrations/0002_seed.sql
npx wrangler secret put MUAPI_API_KEY
npx wrangler deploy
```

## Seed Script

`scripts/parse-openapi-seed.js` fetches `https://api.muapi.ai/openapi.json` (968 paths, 619 schemas) and `https://api.muapi.ai/api/v1/models` (live catalog), matches each catalog model to its OpenAPI schema, and emits `migrations/0002_seed.sql`. Optionally reads a local markdown file for category metadata via `MUAPI_LLMSTXT_PATH`.

```bash
# With local markdown for richer categories
MUAPI_LLMSTXT_PATH=/path/to/MuAPI_llms.md node scripts/parse-openapi-seed.js
```

## API (Worker)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Model count + key status |
| GET | `/api/models` | List models (`?category=&family=&group_of=&q=&limit=`) |
| GET | `/api/models/:id` | Model + param schema |
| GET | `/api/categories` | Category counts |
| GET | `/api/families` | Family counts |
| POST | `/api/generate` | Proxy to MuAPI (`{modelId, params}`) → `{requestId, cost}` |
| GET | `/api/predictions/:id` | Poll result |
| POST | `/api/estimate` | Cost estimate |
| POST | `/api/upload` | File upload → hosted URL |
| POST | `/api/sync` | Re-fetch catalog into D1 |

All generation uses submit-then-poll. The frontend polls every 2.5s until `completed`/`failed`.

## Environment

- `MUAPI_API_KEY` — MuAPI API key (set via `wrangler secret put` for deploy, `.dev.vars` for local)
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` — only needed for `wrangler d1` / `deploy`

## License

MIT
