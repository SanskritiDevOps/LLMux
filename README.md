# LLMux

![CI](https://github.com/SanskritiDevOps/LLMux/actions/workflows/ci.yml/badge.svg)

A self-hosted LLM gateway. Applications send every chat request in one format, with one key, and LLMux routes it to Google Gemini, Groq, OpenAI, Anthropic or a local Ollama model. It translates the request and the answer, streams tokens over SSE or WebSocket, and adds retries, fallback, a circuit breaker, caching, rate limits and per-request cost tracking. A React dashboard shows usage, logs, keys and provider health, and has a playground for comparing two models side by side.

Switching an application from one model to another means changing the `model` field, nothing else.

## Contents

- [Features](#features)
- [How a request flows](#how-a-request-flows)
- [Quick start](#quick-start)
- [API](#api)
- [Models and providers](#models-and-providers)
- [Design decisions](#design-decisions)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Benchmarks](#benchmarks)
- [Deployment](#deployment)
- [Limitations](#limitations)

## Features

**Gateway (`/v1`)**
- `POST /v1/chat`: one request and response format for every provider, as JSON or as an SSE stream
- `/v1/ws`: a WebSocket protocol with several chats in progress per socket, and `cancel`
- Adapters for Gemini, Groq, OpenAI (Chat Completions), Anthropic (Messages) and Ollama, each translating requests, responses, stream events and errors
- Model aliases (`fast`, `smart`, `local`) with fallback chains, or a direct `provider:model` call
- Retries with exponential backoff and jitter, `Retry-After`, and one deadline across all attempts
- Fallback to the next provider in the chain, for streams too, as long as no token has been sent
- A circuit breaker per provider, shared by every instance through Redis
- A response cache for deterministic requests (`temperature: 0`), scoped to each account
- A token-bucket rate limit per gateway key, shared by HTTP and WebSocket, as an atomic Redis Lua script
- One usage row per request: tokens, cost in integer micro-dollars, latency, time to first token, status, cache hit, fallback

**Dashboard**
- Accounts with an httpOnly session cookie, and gateway keys that are stored hashed and shown once
- Overview: totals, p50/p95 latency and charts for 24 hours, 7 days or 30 days
- Logs: a filterable, cursor-paginated table of every request
- Providers: circuit state, error rate and latency per provider
- Playground: stream one prompt from one or two models, with time to first token and cost

## How a request flows

```
POST /v1/chat
  → request ID → gateway key check (Redis-cached) → rate limit (Redis Lua) → validation (Zod)
  → response cache (temperature 0 only)
  → router: alias → [gemini:…, ollama:…]
  → for each target: skip if its circuit is open; adapter builds the request;
                     call with a timeout; retry or move on, within the deadline
  → adapter parses the answer → cost → response, with X-LLMux-* headers
  → usage row written in a batch, after the response
```

Only the adapters in `Backend/src/providers/` know any provider's format. Everything else works on the unified format, so adding a provider doesn't touch the gateway, the routes or the transports.

## Quick start

Requirements: Node.js 20.19 or later, Docker, and optionally [Ollama](https://ollama.com) for a free local model.

```bash
git clone https://github.com/SanskritiDevOps/LLMux.git
cd LLMux
docker compose up -d                  # Postgres and Redis
ollama pull llama3.2:1b               # optional: the model behind `local` and `fast`'s fallback

cd Backend
cp .env.example .env                  # then set JWT_SECRET (32+ characters)
npm install
npx prisma migrate dev
npm run dev                           # http://localhost:5000

cd ../Frontend                        # in a second terminal
cp .env.example .env
npm install
npm run dev                           # http://localhost:5173
```

At least one provider must be configured: `OLLAMA_BASE_URL` (set in `.env.example` for a local Ollama), or `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Gemini and Groq both have free tiers. Every setting is listed, with its default, in [`Backend/.env.example`](Backend/.env.example) and validated at startup by [`src/config/env.js`](Backend/src/config/env.js).

Open the dashboard, register, create a key on **API Keys**, and send a request:

```bash
curl http://localhost:5000/v1/chat \
  -H "Authorization: Bearer $LLMUX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"Name one fort in Jaipur."}]}'
```

`curl http://localhost:5000/ready` checks that Postgres and Redis are reachable.

## API

### Chat request

```json
{
  "model": "fast",
  "system": "You are a helpful travel assistant.",
  "messages": [{ "role": "user", "content": "Plan one day in Jaipur." }],
  "temperature": 0,
  "maxTokens": 800,
  "stream": false,
  "cache": true,
  "metadata": { "app": "trip-planner" }
}
```

Only `model` and `messages` are required. The schema is strict, so an unknown field (such as `max_tokens`) is rejected rather than ignored. `maxTokens` is capped at each target model's limit, and `metadata` is up to 20 flat tags, stored with the usage row.

### Response

A real answer from a local Ollama:

```json
{
  "id": "req_ca164799db776649a9173188",
  "model": "local",
  "provider": "ollama",
  "providerModel": "llama3.2:1b",
  "content": "The Amber Fort is a famous fort in Jaipur.",
  "finishReason": "stop",
  "usage": { "inputTokens": 39, "outputTokens": 12, "totalTokens": 51 },
  "costUsd": 0,
  "latencyMs": 547,
  "cached": false,
  "fallbackUsed": false
}
```

`finishReason` is one of `stop`, `length`, `content_filter` or `error`, whatever the provider called it. The response also carries `X-Request-Id`, `X-LLMux-Provider`, `X-LLMux-Cache`, `X-LLMux-Attempts`, `X-LLMux-Fallback-Used`, `X-LLMux-Latency-Ms`, and the `X-RateLimit-*` headers.

### Streaming

With `"stream": true`, the response is Server-Sent Events:

```
event: start   data: {"id":"req_…","model":"fast","provider":"gemini"}
event: delta   data: {"text":"Morning: "}
event: end     data: {"finishReason":"stop","usage":{…},"latencyMs":1830}
```

A failure before the first token is a normal JSON error with its HTTP status; after it, an `error` event. Closing the connection cancels the provider request.

The WebSocket at `/v1/ws` sends the same events, tagged with a client-chosen `requestId`. The first message must be `{ "type": "auth", "apiKey": "…" }` within 5 seconds; the key is never accepted in the URL. A socket can have 3 chats in progress, and `{ "type": "cancel", "requestId": "…" }` stops one.

### Errors

Every error has the same body:

```json
{ "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded. Retry after 12 seconds.",
             "requestId": "req_…", "provider": null, "retryable": true } }
```

| Code | Status | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | The body or query failed validation |
| `UNKNOWN_MODEL` | 400 | Unknown alias, model not in the catalog, or provider not configured |
| `UNAUTHORIZED`, `KEY_REVOKED` | 401 | Missing, invalid or revoked key or session |
| `FORBIDDEN` | 403 | A state-changing dashboard request from another site's origin |
| `NOT_FOUND` | 404 | Unknown route, or a key that isn't yours |
| `PAYLOAD_TOO_LARGE` | 413 | Body larger than `MAX_BODY_SIZE` |
| `RATE_LIMITED` | 429 | The key's rate limit, with `Retry-After` |
| `PROVIDER_ERROR` | 502 | The provider failed, or its answer couldn't be read |
| `PROVIDER_UNAVAILABLE`, `PROVIDER_RATE_LIMITED` | 503 | Every target failed, was rate-limited, or has an open circuit |
| `TIMEOUT` | 504 | No provider answered within the deadline |
| `INTERNAL_ERROR` | 500 | A bug; the details are only in the logs |

A provider's own error text is never forwarded, because it can contain account details.

### Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/chat` | gateway key | Chat, as JSON or SSE |
| `GET /v1/models` | gateway key | Aliases usable right now |
| `GET /v1/ws` | gateway key, in the first message | WebSocket chat |
| `POST /api/auth/register`, `/login`, `/logout`; `GET /api/auth/me` | none / session | Dashboard accounts |
| `GET`, `POST /api/keys`; `PATCH`, `DELETE /api/keys/:id` | session | Manage your gateway keys |
| `GET /api/usage/summary`, `/timeseries`, `/breakdown`, `/logs` | session | Your usage; logs are cursor-paginated |
| `GET /api/providers/health` | session | Circuit state and recent health per provider |
| `GET /api/playground/models`; `POST /api/playground/chat` | session | The playground, which runs as one of your keys |
| `GET /health`, `GET /ready` | none | Liveness, and readiness (Postgres and Redis) |

## Models and providers

Clients use aliases; the server decides what's behind them ([`src/config/models.js`](Backend/src/config/models.js)):

| Alias | Targets, in fallback order |
|---|---|
| `fast` | `gemini:gemini-3.5-flash-lite` → `groq:openai/gpt-oss-20b` → `ollama:llama3.2:1b` |
| `smart` | `anthropic:claude-sonnet-5-5` → `openai:gpt-6.1-sol` → `gemini:gemini-2.5-pro` → `groq:openai/gpt-oss-120b` |
| `local` | `ollama:llama3.2:1b` |

Providers without a key are left out of every chain. Ollama runs only where its server is, so a hosted deployment uses Gemini and Groq: `fast` then answers from Gemini and falls back to Groq. A direct `provider:model` name, such as `ollama:llama3.2:1b`, calls exactly that model with no fallback. Prices live in the same file, in micro-dollars per million tokens, and the whole file is validated at startup.

**Adding a provider:** write `Backend/src/providers/<name>/` with `request.js`, `response.js`, `stream.js`, `errors.js` and `index.js` (see any existing provider), register it in `src/providers/index.js`, add its key to `src/config/env.js`, `src/gateway/providerSettings.js` and `getEnabledProviders` in `src/gateway/router.js`, add its models to `src/config/models.js`, and add fixture tests. The gateway, routes and transports don't change. Groq is an example: it speaks OpenAI's format, so its adapter reuses the OpenAI code with its own name, address and error mapping.

## Design decisions

- **Adapters are pure functions.** They build a request, parse a response or a stream event, and map an error; one shared HTTP client does the I/O, timeouts and cancellation. That keeps them testable against recorded responses, with no network.
- **Streams fall back only before the first token.** Once a client has seen text, another provider can't continue the same answer. So a stream is read up to its first token inside the retry loop, and only then committed.
- **Not every error is retried or falls back.** A `400` would fail at the next provider too, so it does neither; a `401` from a provider means our key is wrong, so it falls back without retrying and logs an alert; `429` and `5xx` are retried with jittered backoff, then fall back; a timeout falls back at once (it has already used a whole attempt's time), and is retried only on the last provider ([`errorPolicy.js`](Backend/src/gateway/errorPolicy.js)).
- **The circuit breaker and rate limit live in Redis**, so several gateway instances agree. The token bucket is one Lua script, because reading, refilling and taking a token must be atomic. If Redis is down, both fail open: requests are slower or unlimited, never refused.
- **Gateway keys are hashed with SHA-256, passwords with bcrypt.** A key is 256 random bits and checked on every request, where bcrypt's deliberate slowness would add a quarter of a second; a password is short and chosen by a person.
- **Money is integer micro-dollars.** Costs are summed in SQL as `bigint`, and only converted to dollars for display, so totals never drift.
- **Cache entries are per account.** The key is a SHA-256 of the normalized request plus the account, so two customers never share an answer, and only `temperature: 0` requests are cached by default.
- **Usage is written after the response, in batches**, and kept in memory if Postgres is briefly unavailable, so logging never slows a request down.
- **Logs are paged with a cursor** on `(created_at, id)`, not `OFFSET`, because the table only grows: offset pages get slower and shift as rows arrive.
- **Prompts and answers are never stored**, only counts, cost, timings and the client's own `metadata` tags.

## Project structure

```
Backend/
  src/
    config/        env and model config, validated at startup; Prisma and Redis clients
    routes/        /v1 (chat, models) and /health, /ready
    transports/    SSE writer, WebSocket server and protocol
    gateway/       the core: router, retries, deadline, fallback, circuit breaker, cache, cost
    providers/     adapter contract, HTTP client, stream reader; gemini/ groq/ ollama/ openai/ anthropic/
    middleware/    request ID, logging, key and session auth, origin check, rate limits, errors
    modules/       dashboard API: auth, keys, usage, providers, playground, rate limiter
    scripts/       rateLimit.lua
  prisma/          schema and migrations
  tests/           unit/, integration/, fixtures/ (provider responses), mockProvider.js
  bench/           the benchmark (npm run bench)
Frontend/
  src/
    api/           the fetch wrapper
    features/      one folder per page: auth, overview, logs, playground, keys, providers
    components/    shared UI
    hooks/, lib/   session, formatting, SSE reader, chart styling
  tests/
render.yaml        Render Blueprint for the backend, Postgres and Redis
```

## Testing

Tests never call a real provider. Adapters are tested against recorded or documented provider responses, and the gateway, transports and dashboard API against a mock provider server (`Backend/tests/mockProvider.js`) that can answer, stream slowly, fail with any status, hang, or drop the connection.

```bash
cd Backend && npm test                      # 893 tests, no Docker needed
cd Backend && TEST_REAL_DEPS=1 npm test     # 950: adds real Postgres and Redis (as CI does)
cd Frontend && npm test                     # 45 tests for the SSE reader, formatting and forms
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm audit --omit=dev`, lint and the tests for both folders on every push, with Postgres 16 and Redis 7 service containers, and builds the dashboard.

## Benchmarks

`npm run bench` in `Backend/` runs three processes, so none competes with another for its thread: the mock provider, the real LLMux app (key check, rate limit, routing, adapter, cost, and a usage row in Postgres), and the load generator. Only the provider is fake, so the time measured is LLMux's own.

Measured on a laptop (Intel Core i5-12450H, 16 GB, Windows 11, Node 22.14, Postgres and Redis in Docker Desktop), two runs:

| Metric | Result |
|---|---|
| Gateway overhead, median, one request at a time | **4.4–4.9 ms** (5.4–5.8 ms through LLMux vs 0.9–1.0 ms direct) |
| Cache hit, median | 4.2–7.5 ms, with no provider call |
| Time to first token, median of 100 streams | +2.6 ms over a direct call |
| Fallback with the primary provider down | 0.7–0.9 s for the first request (retries, then the next provider); about 10 ms once its circuit is open |
| Throughput, 50 connections | 221–302 requests/s through LLMux; the same machine served `/health` at 850–3,003 requests/s |

The throughput numbers describe this laptop more than LLMux: even `/health`, which does nothing, varied almost fourfold between runs. The per-request overhead is the meaningful figure.

## Deployment

[`render.yaml`](render.yaml) describes the backend, its Postgres and its Redis as a Render Blueprint: the build runs `prisma migrate deploy`, the health check is `/health`, and `CLIENT_IP_HEADER=cf-connecting-ip` lets the per-IP login limit see real client addresses behind Cloudflare and Render's proxies. The dashboard deploys to Vercel from `Frontend/` ([`vercel.json`](Frontend/vercel.json)), with `VITE_API_URL` set to the backend's URL. On the backend, set `DASHBOARD_URL` to the dashboard's exact URL (CORS allows only that origin) and at least one provider key.

## Limitations

- Only the Ollama adapter has been run against the real service. Gemini, Groq, OpenAI and Anthropic are tested against responses written from their API references, because no keys were available.
- Text chat only: no tool calling, images or embeddings.
- On the default `*.vercel.app` and `*.onrender.com` domains the session cookie is cross-site, which Safari blocks by default; one custom domain for both fixes that.
- No live deployment yet.

## License

MIT
