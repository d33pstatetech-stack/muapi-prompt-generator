# MuAPI Prompt Generator

A browser-based prompt workshop and generation console for the full [MuAPI](https://muapi.ai) model catalog — image, video, audio, and 3D. It runs entirely on Cloudflare Workers: a React front end on the edge, a single Worker handling the API surface, a D1 SQLite catalog of every model and its parameter schema, and R2 for captured outputs.

The catalog currently holds **723 models across 14 categories and 131 model families**, with each model's parameter schema extracted from MuAPI's live OpenAPI spec rather than hand-maintained.

> **Scope note:** the *hosting layer* is free on Cloudflare's Free plan. The *generations themselves* are billed by MuAPI and are not free. See [What the free tier does not cover](#what-the-free-tier-does-not-cover).

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Why Cloudflare Workers, and what free hosting provides](#why-cloudflare-workers-and-what-free-hosting-provides)
- [Free tier budget](#free-tier-budget)
- [Where the free tier gets tight](#where-the-free-tier-gets-tight)
- [Data stores](#data-stores)
- [API reference](#api-reference)
- [Secrets and configuration](#secrets-and-configuration)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Rebuilding the catalog](#rebuilding-the-catalog)
- [Prompt enhancer](#prompt-enhancer)
- [LoRA library and compatibility filtering](#lora-library-and-compatibility-filtering)
- [Jev verifier pilot](#jev-verifier-pilot)
- [Companion local and Docker build](#companion-local-and-docker-build)
- [License](#license)

---

## Features

**Catalog and parameters**
- 723 models with per-model parameter schemas (types, enums, ranges, defaults) generated from the live OpenAPI spec
- Filter by category, family, media group, or free-text search
- One-click catalog re-sync when MuAPI ships new models
- Live cost estimate per model, including dynamic pricing

**Generation**
- Submit-then-poll against MuAPI; the client polls until `completed` or `failed`
- Reference image inputs — drag-and-drop, file picker, or URL — for `image_url`, `images_list`, and `last_image` parameters
- Multi-output gallery: every URL returned by a single job is surfaced, with a tab strip on the result card
- Output capture to R2, with a content-type fallback for objects stored as `application/octet-stream`
- Local run history plus a shared D1-backed run log, with per-run star rating

**AI prompt enhancer**
- Model-aware prompt rewriting with a provider fallback chain
- Server-sent-event streaming so text appears as it is produced
- Family-specific formatting presets (Seedance, Wan, MiniMax, Kling/Luma)
- Per-prompt persistence of raw text, enhanced text, model, params, and the LLM that produced it

**LoRA support**
- Browse Hugging Face and CivitAI, or resolve either from a pasted model-card URL
- Custom LoRA library persisted in D1, deduplicated by source + repo + file
- Three-tier compatibility filtering against the selected model, described below
- `Range` header forwarding and `206` passthrough so chunked weight downloads do not stall

**Interface**
- React 19 + Vite 8 + Tailwind 4, built to static assets and served from the edge
- Responsive down to mobile widths; the enhancer is part of the primary flow, not a desktop-only sidebar
- Prompt template library and saved-prompt library
- Settings modal for the enhancer's LLM chain, with keys redacted over the wire

---

## Architecture

```
client/           → React 19 + Vite + Tailwind 4 single-page app
  src/components/ → ModelPicker, ParamForm, Enhancer, LoraPicker, CloudPicker,
                    OutputCard, HistoryGrid, LibraryModal, SettingsModal, …
  src/hooks/      → useGeneration (submit + poll), useLlmConfig
  dist/           → build output, served as Worker static assets (git-ignored)
src/worker.js     → the Worker: every /api/* route, auth gate, proxying
migrations/       → 0001 catalog schema, 0002 generated seed, 0003 enhancer tables
scripts/          → parse-openapi-seed.js (catalog generator), venice-test.js (LLM smoke test)
public/           → legacy vanilla-JS front end, retained for reference
```

The Worker only ever handles `/api/*`. Static file serving is delegated to Cloudflare's asset pipeline via the `[assets]` binding in `wrangler.toml`, so front-end assets are served from the edge cache and never invoke Worker code.

Three bindings carry state:

| Binding | Resource | Purpose |
|---|---|---|
| `DB` | D1 `muapi-models` | Model catalog, parameter schemas, enhancer prompts, LLM config |
| `HISTORY` | D1 `genai-history` | Run log, enhancements, custom LoRA library, judge verdicts |
| `OUTPUTS_BUCKET` | R2 `genai-assets` | Captured generation outputs |

Keeping the catalog and the run log in separate databases is deliberate: catalog reads are high-volume and index-friendly, while run history and the LoRA library grow append-only and are queried differently. They can be scaled, exported, or reset independently.

---

## Why Cloudflare Workers, and what free hosting provides

This application is a good fit for the Workers Free plan for a structural reason, not an accidental one: **almost all of its work is waiting on someone else's network.** The Worker receives a request, forwards it to MuAPI or to an LLM provider, and streams the response back. Cloudflare does not count time spent waiting on a `fetch()` toward CPU time, so the 10 ms CPU ceiling that constrains compute-bound Workers barely registers here. The genuinely CPU-consuming parts — JSON serialization, schema transforms — are small and measured in single-digit milliseconds.

What that buys in practice:

**Zero infrastructure cost to run.** No server to rent, no container to size, no idle instance burning money between uses. A hobby project, a side tool, or a demo that nobody opens for a month costs nothing to keep online.

**A real global hostname with TLS.** Every deployment gets an `*.workers.dev` HTTPS endpoint, or can be attached to a custom domain with automatic certificate issuance and edge caching. There is no origin to secure, patch, or reboot.

**Deploys are atomic rollouts.** Publishing a new version is a single command. Traffic shifts to the new version when it is ready, and the previous version stays available for rollback. There is no in-flight state to drain because the Worker holds no session state — all state lives in D1 and R2.

**Cold starts are a subrequest, not a container boot.** There is no VM and no process to start, so the first request after idle is not materially slower than the thousandth. For a submit-and-poll workload this is a good trade: latency is dominated by the upstream model call anyway.

**Secrets never leave the platform.** API keys are stored as encrypted Worker secrets and are injected into the runtime at request time. They are not in the bundle, not in `wrangler.toml`, and not readable by the browser. The Worker also returns redacted configuration to the client, so a key entered in the settings modal round-trips as `***` rather than being echoed back.

**Authentication is handled at the edge, in the same place.** Cloudflare Access intercepts unauthenticated requests *before* they reach Worker code, so an unauthenticated request costs nothing and never touches the MuAPI key. The Worker keeps a redundant `Cf-Access-Jwt-Assertion` check as defense in depth and returns a clear JSON `401` for API clients rather than an HTML login page.

**Generous static asset hosting.** The built front end ships as static assets — up to 20,000 files per Worker version, 25 MiB each — served from Cloudflare's cache rather than from Worker invocations, so page loads do not consume the request budget in the same way dynamic routes do.

**One-click rollback and no state to reconcile.** Because nothing is stateful in the Worker, switching versions cannot leave a half-migrated instance behind. Reverting a bad deploy is deploying the previous version again.

---

## Free tier budget

Figures below are the Workers Free plan limits that this project's resource mix is measured against. They reset daily at 00:00 UTC unless noted.

| Resource | Free allowance | Relevance here |
|---|---|---|
| Worker requests | 100,000 / day | Each page load and each API call counts. Polling is the main consumer. |
| Worker CPU | 10 ms / request | Rarely a constraint — the Worker is I/O bound and network wait is not counted. |
| Worker memory | 128 MB | Comfortable; the Worker holds no large buffers. |
| Subrequests | 50 external / 1,000 to Cloudflare services per request | A single generate call uses a handful. |
| Worker size | 64 MiB | Not close — the Worker is plain JavaScript with no dependencies. |
| Static assets | 20,000 files, 25 MiB each per version | The Vite bundle is well inside this. |
| D1 rows read | 5,000,000 / day | Catalog listing dominates. |
| D1 rows written | 100,000 / day | Run log, prompts, custom LoRAs. |
| D1 storage | 5 GB total | The catalog plus parameter schemas is a small fraction. |
| D1 egress | none | D1 is never charged for data transfer. |
| R2 storage | 10 GB-month / month | Output captures accumulate here. |
| R2 operations | 1M Class A / 10M Class B per month | Writes on capture, reads on replay. |
| R2 egress | free | The single largest practical win — see below. |
| Access users | 50 seats | Ample for a private team tool. |

Two of these deserve emphasis.

**Free R2 egress.** Object storage egress is the line item that usually makes a media-heavy app expensive. Storing generated video and images in R2 and serving them back out costs nothing in bandwidth, which is what makes "keep every output in history" a viable default rather than a bill.

**D1 is free of transfer charges.** The catalog is read constantly and returned to every client, and D1 does not bill for that read traffic.

Since 1 September 2026, D1 on the Free plan *enforces* its daily row limits: queries return an error once the limit is reached rather than degrading quietly, and stored data is unaffected. Cloudflare sends an email when a limit is hit, and limits reset at midnight UTC.

---

## Where the free tier gets tight

Honest accounting, since these are the places a deployment on this plan can hit a wall:

- **Request count is the real ceiling, not CPU.** Polling a slow video job every 2.5 s for several minutes is dozens of requests for a single generation. A busy day of experimentation reaches 100,000 requests sooner than it reaches 10 ms of CPU on any one call.
- **`GET /api/models?limit=1000` is the heaviest single request.** It returns the whole catalog, so it scans on the order of the full model table and serializes a large response. Indexes on `category`, `family`, `group_of`, and `name` keep filtered queries cheap, but the unfiltered full-catalog fetch is the request most likely to press against the CPU limit. It is a good candidate for a CDN `Cache-Control` header if the catalog becomes hot.
- **D1 row reads scale with catalog size.** At 723 models, an uncached full-catalog listing is on the order of a thousand rows read. Against a 5M daily budget that allows several thousand such requests per day, so the request limit usually binds first — but the two are the same order of magnitude and worth watching together.
- **R2 storage fills at 10 GB-month.** Long-lived output archives are the thing most likely to outgrow the free allowance. A lifecycle rule that expires old objects, or a manual prune, keeps this predictable.
- **Access is capped at 50 seats.** Fine for a private tool, not a path to a public multi-tenant product without moving to a paid plan.
- **10 ms CPU is unforgiving for anything added later.** Any future feature doing image processing, large JSON transforms, or crypto in the Worker would likely need `cpu_ms` raised, which is a Workers Paid capability.

---

## Data stores

**`muapi-models` (D1)** — the catalog. `models` holds identity, category, family, media group, cost, and the upstream endpoint and estimate paths; `model_params` holds the JSON schema and defaults per model; `saved_prompts` and `catalog_meta` round out the schema. `prompts` and `llm_config` come from the enhancer migration.

**`genai-history` (D1)** — operational state, created defensively on first use so a fresh database needs no migration step:
- `runs` — request, model, LoRAs, status, cost hint, output URLs, R2 keys
- `enhancements` — raw and enhanced prompts with the LLM that produced them
- `custom_loras` — the shared LoRA library, unique on source + repo + file
- `judge_verdicts` — calibration data for the verifier pilot

**`genai-assets` (R2)** — captured outputs, replayed through the Worker with a long `Cache-Control` and an extension-based content-type fallback, since objects written as `application/octet-stream` otherwise download without a usable MIME type.

---

## API reference

The gate covers every route that spends a key, touches history, or can modify state. The read-only catalog routes (`/api/health`, `/api/models`, `/api/models/:id`, `/api/categories`, `/api/families`) and the Hugging Face file proxy (`/api/hf/file`) stay open so the model list can be browsed and cached without a session.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Model count, last sync time, key status, run counts *(public)* |
| GET | `/api/models` | Catalog listing — `?category=&family=&group_of=&q=&limit=` |
| GET | `/api/models/:id` | Single model plus parameter schema |
| GET | `/api/categories` | Category counts |
| GET | `/api/families` | Family counts |
| POST | `/api/sync` | Re-fetch the catalog from MuAPI into D1 |
| POST | `/api/generate` | Submit a job — `{modelId, params, enhancementId?}` → `{requestId, cost}` |
| GET | `/api/predictions/:id` | Poll a job for status and outputs |
| POST | `/api/estimate` | Cost estimate without generating |
| POST | `/api/upload` | Upload a reference file → hosted URL |
| GET | `/api/hf/file` | Proxy a Hugging Face file, forwarding `Range` and `206` |
| POST | `/api/enhance` | Stream an enhanced prompt (SSE) |
| POST | `/api/optimize` | Same as `/api/enhance`, buffered to JSON |
| GET/PUT | `/api/llm-config` | Read (redacted) or write the enhancer's LLM chain |
| GET/POST | `/api/prompts` | List or persist raw / enhanced / AI prompts |
| POST | `/api/lora/resolve` | Resolve a Hugging Face or CivitAI model-card URL to LoRA file(s) |
| GET/POST/DELETE | `/api/loras/custom` | Shared custom LoRA library |
| GET | `/api/cloud/list` | List the R2 output bucket |
| GET | `/api/cloud/file` | Fetch one R2 object |
| POST | `/api/cloud/resolve` | Rehost an R2 object through MuAPI for a fresh URL |
| POST | `/api/muapi/save-outputs` | Server-side fetch of output URLs into R2 |
| GET | `/api/muapi/file` | Stream an object back out of R2 |
| GET | `/api/history/runs` | Run log with filters |
| POST | `/api/history/link` | Attach an enhancement to a run |
| POST | `/api/history/rate` | Star-rate a run |
| POST | `/api/judge` | Proxy to the Jev verifier |
| POST | `/api/judge/log` | Record a verifier verdict for calibration |

All generation is submit-then-poll. LoRA downloads forward `Range` and pass `206 Partial Content` through, so chunked weight fetches resume instead of stalling.

---

## Secrets and configuration

| Name | Required | Purpose |
|---|---|---|
| `MUAPI_API_KEY` | yes | MuAPI calls: generation, polling, upload, estimate |
| `MUAPI_BASE_URL` | no | Override the API base (`[vars]`, defaults to `https://api.muapi.ai/api/v1`) |
| `OPENROUTER_API_KEY` | for enhancer | Default LLM provider |
| `VENICE_API_KEY` | optional | Alternative LLM provider in the fallback chain |
| `HUGGINGFACE_API_KEY` | optional | Raises Hugging Face rate limits for `/api/hf/file` |
| `CIVITAI_API_KEY` | optional | Authenticated CivitAI model lookups |
| `JEV_API_KEY` | for verifier | Jev `/api/judge` proxy |

Secrets are set with `wrangler secret put` and injected per request. For local development they live in `.dev.vars`, copied from `.dev.vars.example`. `.dev.vars` and `.env` are git-ignored; never commit a populated copy.

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # add MUAPI_API_KEY

# Front end (hot reload on :5173, talks to the Worker on :8787)
cd client
npm install
npm run dev

# Worker + local D1 (in a second terminal)
npx wrangler d1 execute muapi-models --local --file=migrations/0001_init.sql
npm run seed:parse
npx wrangler d1 execute muapi-models --local --file=migrations/0002_seed.sql
npx wrangler dev
```

`wrangler dev` serves on `127.0.0.1`, and the auth gate treats loopback as authenticated — so no Access setup is needed to develop locally. Linting for the client is `npm run lint` in `client/` (oxlint).

---

## Deployment

```bash
# Schema and catalog, once per environment
npx wrangler d1 execute muapi-models --remote --file=migrations/0001_init.sql
npm run seed:parse
npx wrangler d1 execute muapi-models --remote --file=migrations/0002_seed.sql
npx wrangler d1 execute muapi-models --remote --file=migrations/0003_enhancer.sql

# Build the front end into client/dist
cd client && npm run build && cd ..

# Secrets
npx wrangler secret put MUAPI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY

# Publish
npx wrangler deploy
```

**Access must be configured before the API is usable.** The Worker requires either a valid `Cf-Access-Jwt-Assertion` header or an `Cf-Access-Authenticated-User-Email` header on every protected prefix, and only exempts loopback. A deployment without a matching Access application returns `401` on `/api/generate` and the other protected routes even though the front end loads fine. Creating a self-hosted Access application over the `*.workers.dev` hostname is the missing step in any fresh fork.

Once Access is in place, requests without a valid session are rejected at the edge before reaching Worker code.

---

## Rebuilding the catalog

`scripts/parse-openapi-seed.js` fetches `https://api.muapi.ai/openapi.json` and `https://api.muapi.ai/api/v1/models`, matches each catalog entry to its OpenAPI schema, groups models into the 14 categories, and emits `migrations/0002_seed.sql`.

```bash
npm run seed:parse
npm run seed:local     # or seed:remote
```

An optional local markdown file supplies richer category metadata:

```bash
MUAPI_LLMSTXT_PATH=/path/to/MuAPI_llms.md npm run seed:parse
```

`POST /api/sync` performs the equivalent refresh against an already-running deployment and is what the Update control in the header calls.

---

## Prompt enhancer

The enhancer rewrites a prompt for the specific target model. It sends a system prompt built from a shared template plus a family-specific preset — Seedance gets screenplay structure and `@image1..@image9` omni-reference syntax, Wan gets resolution and duration guidance, MiniMax gets timecoded `[0s-3s]` structure, Kling and Luma get concise natural-language motion direction. It also adds sound-effect and dialogue cues when the target model generates audio, and timestamp directions for video models based on the requested duration.

Responses stream to the browser as server-sent events, and the full text is persisted once the stream completes.

Providers are tried in order until one succeeds:

1. `https://openrouter.ai/api/v1` — `liquid/lfm-2.5-2.6b:free`
2. `https://openrouter.ai/api/v1` — `openrouter/free`
3. `https://api.venice.ai/api/v1` — `venice-uncensored`

Venice model IDs change as their catalog rotates, so any Venice entry is worth confirming with `scripts/venice-test.js` before relying on it; a stale ID surfaces as a `404` that the chain then falls through.

The chain is stored in the `llm_config` D1 row when set through the settings modal, and falls back to the built-in defaults otherwise. Keys are resolved per provider from the matching environment secret and are always redacted on read.

The system prompt is deliberately framed as format optimization only, so the enhancer performs mechanical conversion for any subject matter and leaves content policy to the downstream generative model.

`scripts/venice-test.js` is a standalone smoke test that issues a single `/chat/completions` request against a chosen provider and model — useful for confirming a key and a model ID before wiring either into the chain:

```bash
node scripts/venice-test.js
```

---

## LoRA library and compatibility filtering

LoRAs can be browsed from Hugging Face and CivitAI, or resolved from a pasted model-card URL through `POST /api/lora/resolve`, which returns the weight file, base model, pipeline, and trigger words. CivitAI lookups use `CIVITAI_API_KEY` when present. Anything added by hand joins a shared library in D1, deduplicated on source + repo + file.

Picking a LoRA that the selected model cannot actually load wastes a generation, so the pickers filter by compatibility using a three-tier model in `client/src/lora-compat.js`:

- **Verified** (green) — the exact LoRA and model pair has completed a real run.
- **Likely** (yellow) — curated target, matching family and pipeline, tolerating minor version drift such as Wan 2.1 against 2.2.
- **Incompatible** (red) — family mismatch, pipeline mismatch, or a major version gap such as Wan 2.x against 3.x. Hidden unless show-all is enabled.

A Wan major-version rule hides cross-generation LoRAs outright, since those silently fail rather than degrade. Weight downloads go through the Worker with `Range` and `206` passthrough so interrupted multi-gigabyte fetches resume.

---

## Jev verifier pilot

`POST /api/judge` proxies to the Jev verifier at `api.typesafe.ai`, with an abort-based timeout clamped between 1 s and 30 s. Verdicts render as a badge on the enhancer result, and `POST /api/judge/log` records the probability, model, and latency of each check so the thresholds can be calibrated against real traffic before the signal is trusted. The tables are created on first write, so the pilot can be removed without a migration.

Without `JEV_API_KEY` the route returns a clear not-configured error and the rest of the application is unaffected.

---

## Companion local and Docker build

[muapi-prompt-generator-local](https://github.com/d33pstatetech-stack/muapi-prompt-generator-local) runs the same interface on Node with no Cloudflare account, no Access wall, and the API key confined to the host. The catalog lives in `data/catalog.json` instead of D1 and the run log in a flat file.

```bash
cp .env.example .env
node scripts/build-catalog.js
node server.js          # http://localhost:3000
```

A Dockerfile and `docker-compose.yml` are included for Linux and Windows via Docker Desktop with WSL2.

---

## License

MIT
