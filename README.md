# LLMux: One API for Every LLM

![CI](https://github.com/SanskritiDevOps/LLMux/actions/workflows/ci.yml/badge.svg)

> A self-hosted LLM gateway. Send every request in one standard format, change only the `model` field, and LLMux routes it to OpenAI, Anthropic, Google Gemini, or a local model, translates the request and response, streams tokens back over HTTP or WebSocket, and adds caching, rate limiting, retries, fallback, and cost tracking on top.

**Status:** the MVP is built: four providers (Gemini, Ollama, OpenAI, Anthropic) with streaming, SSE and WebSocket, retries, fallback, a circuit breaker, caching, rate limits, usage and cost tracking, and the dashboard with its playground. 950 automated tests run in CI against real Postgres and Redis. Measured results are in [section 28](#28-benchmarking); a walkthrough is in [Demo](#demo).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [The Solution](#3-the-solution)
4. [Goals and Non-Goals](#4-goals-and-non-goals)
5. [Features](#5-features)
6. [Tech Stack](#6-tech-stack)
7. [System Architecture](#7-system-architecture)
8. [Unified API Format](#8-unified-api-format)
9. [Provider Adapters](#9-provider-adapters)
10. [Model Routing and Configuration](#10-model-routing-and-configuration)
11. [Streaming Design](#11-streaming-design)
12. [Caching](#12-caching)
13. [Rate Limiting](#13-rate-limiting)
14. [Retries, Fallback, and Circuit Breaker](#14-retries-fallback-and-circuit-breaker)
15. [Authentication and API Keys](#15-authentication-and-api-keys)
16. [Usage and Cost Tracking](#16-usage-and-cost-tracking)
17. [Database Design](#17-database-design)
18. [REST API Endpoints](#18-rest-api-endpoints)
19. [WebSocket Protocol](#19-websocket-protocol)
20. [Dashboard](#20-dashboard)
21. [Error Handling](#21-error-handling)
22. [Security](#22-security)
23. [Logging and Observability](#23-logging-and-observability)
24. [Folder Structure](#24-folder-structure)
25. [Environment Variables](#25-environment-variables)
26. [Local Setup](#26-local-setup)
27. [Code Quality and Testing](#27-code-quality-and-testing)
28. [Benchmarking](#28-benchmarking)
29. [CI Pipeline](#29-ci-pipeline)
30. [Deployment](#30-deployment)
31. [Build Roadmap](#31-build-roadmap)
32. [Projects Built on LLMux](#32-projects-built-on-llmux)
33. [Interview Talking Points](#33-interview-talking-points)
34. [Future Scope](#34-future-scope)

---

## 1. Overview

LLMux sits between your applications and AI model providers.

```
              ┌──────────────┐
Your App ───► │    LLMux     │ ───► OpenAI
Trip Planner  │  one format, │ ───► Anthropic (Claude)
PR Review Bot │  one key     │ ───► Google Gemini
              └──────────────┘ ───► Ollama (local models)
```

Applications talk to LLMux in **one fixed format** with **one API key**. LLMux decides which provider to call, converts the request into that provider's format, calls it, and converts the answer back. To switch from one model to another, a developer changes a single word: the `model` field.

**What it gives developers**

- One request and response format for every model
- Normal responses over HTTP, and live token streaming over Server-Sent Events (SSE) or WebSocket
- Automatic retries and fallback when a provider fails
- Response caching to save money and time
- Per-key rate limits
- A dashboard showing requests, latency, tokens, and cost

### Demo

A live deployment is set up from [`render.yaml`](render.yaml) and [`Frontend/vercel.json`](Frontend/vercel.json) (see [section 30](#30-deployment)). Locally, after [Local Setup](#26-local-setup), this five-minute walkthrough shows every feature:

1. **Dashboard:** open `http://localhost:5173`, register, then on **API Keys** create a key. The full key is shown once, with a Copy button.
2. **One format, any model:** send the same request with `"model": "local"` (Ollama) and then `"model": "fast"`; only the `model` field changes.
   ```bash
   curl http://localhost:5000/v1/chat \
     -H "Authorization: Bearer $LLMUX_KEY" -H "Content-Type: application/json" \
     -d '{"model":"local","messages":[{"role":"user","content":"Name one fort in Jaipur."}]}'
   ```
   The answer has the same shape for every provider, plus `X-LLMux-Provider`, `X-LLMux-Latency-Ms` and the other `X-LLMux-*` headers.
3. **Streaming:** add `"stream": true` and use `curl -N`: `start`, then `delta` events word by word, then `end` with usage. Press Ctrl+C mid-answer and the server cancels the provider call.
4. **Cache:** send a request with `"temperature": 0` twice. The second answers in milliseconds with `X-LLMux-Cache: HIT` and `"costUsd": 0`.
5. **Fallback:** set `GEMINI_API_KEY=not-a-real-key` and send `"model": "fast"`. Gemini refuses, Ollama answers, and the response says `X-LLMux-Fallback-Used: true`.
6. **Rate limit:** create a key limited to 2 a minute and send three requests: the third gets `429` with `Retry-After`.
7. **Playground:** on **Playground**, tick **Compare**, pick two models and run one prompt: both stream side by side, each with its time to first token, latency, tokens and cost.
8. **Overview, Logs and Providers:** every request above is now on the charts, in the logs table (click a row for the full record), and in each provider's health.

---

## 2. Problem Statement

There are many LLMs today: closed models from OpenAI, Anthropic, and Google, and open models (Llama, Mistral, Qwen, and others) that can run locally. Each provider has its own API, and they differ in small but painful ways.

| Difference | Example |
|---|---|
| Endpoint and auth | Different URLs, header names, and key formats |
| Request shape | One API uses `messages`, another uses `contents` with `parts` |
| System prompt | Some put it inside the messages list, others in a separate top-level field |
| Role names | `assistant` in one API, `model` in another |
| Required fields | Some providers require a max token limit, others don't |
| Response shape | The answer text and token counts live in different places |
| Streaming | Each provider sends a different sequence of stream events |
| Errors | Different status codes and error bodies for the same problem |

**What this costs a team**

- Separate integration code for every provider
- Switching models means rewriting code
- No single place to see total usage or spend
- When one provider goes down, the app goes down with it
- Every app re-implements retries, rate limits, and logging

---

## 3. The Solution

LLMux solves this with one small idea: **a standard format in the middle, plus one adapter per provider.**

Every request goes through four steps:

1. **Read the `model` field** and look up which provider serves it.
2. **Translate** the standard request into that provider's format using its adapter.
3. **Send** the request with the provider key stored on the server.
4. **Translate the response back** into the standard format and return it.

Around those four steps, LLMux adds the reliability and visibility features every AI app needs: caching, rate limiting, retries, fallback, usage logging, and a dashboard.

---

## 4. Goals and Non-Goals

### Goals
- One stable request, response, stream, and error format across at least three providers
- Streaming over both SSE and WebSocket
- Fallback to another model when a provider fails, without the client changing anything
- Accurate per-request logging of tokens, latency, and cost
- Measured performance: the gateway's added latency is benchmarked and published
- Easy to add a new provider by writing one adapter file
- Clean code, tests, documentation, and a live deployment

### Non-Goals
- Training, fine-tuning, or hosting models (LLMux only calls existing APIs)
- Supporting every feature of every provider (images, audio, and tool calling come later)
- Large-scale production infrastructure for thousands of customers
- Billing real customers or handling payments

---

## 5. Features

Build **P0 first**, then P1, then pick from P2 if time allows.

### P0: Core (must have)

#### 5.1 Unified Chat Endpoint
- `POST /v1/chat` accepts one standard request for every model
- Supports `messages`, a `system` prompt, `temperature`, `maxTokens`, and `stream`
- Returns one standard response with the text, finish reason, and token usage

#### 5.2 Provider Adapters
- At least **three providers**: OpenAI, Anthropic, and Google Gemini
- **Ollama** as a fourth for free local models (also useful for testing without cost)
- Each adapter converts requests, responses, stream events, and errors

#### 5.3 Model Routing
- A config file maps friendly model names (aliases) to a provider and the provider's real model ID
- `GET /v1/models` lists the available models

#### 5.4 Streaming
- **SSE** on `POST /v1/chat` when `stream: true`
- **WebSocket** endpoint for long-lived, two-way chat connections
- Every provider's stream is normalized into the same events: `start`, `delta`, `end`, `error`
- The client can cancel a stream, which aborts the upstream provider request

#### 5.5 API Keys for Gateway Users
- Users create gateway keys from the dashboard
- Keys are stored hashed and shown only once
- Each request is authenticated with `Authorization: Bearer <key>`

#### 5.6 Usage Logging
- Every request is logged: key, model, provider, input and output tokens, latency, cost, status, cache hit, and fallback used

#### 5.7 Error Normalization
- Every provider error is converted into one error format with a stable code (for example `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INVALID_REQUEST`)

### P1: Stand-Out Features

| Feature | Why it impresses |
|---|---|
| **Response caching** (Redis) | Saves cost and time; you can measure the savings |
| **Rate limiting** (token bucket in Redis) | Classic system-design topic |
| **Retries with exponential backoff and jitter** | Shows you understand transient failures |
| **Fallback chains** (`fast-model` → backup model) | Keeps apps working during outages |
| **Circuit breaker** per provider | Stops hammering a provider that is down |
| **Dashboard** (requests, latency, tokens, cost charts) | Makes the backend visible in a demo |
| **Benchmarks** published in the README | Real numbers for interviews |
| **Request IDs and structured logs** | Makes debugging traceable end to end |

### P2: Nice to Have

- Per-key monthly budgets that block requests after a spending limit
- Cost-based or latency-based routing (choose the cheapest or fastest healthy model)
- A small JavaScript client SDK (`npm` package) for the gateway
- Tool / function calling normalized across providers
- Embeddings endpoint
- Image input (vision) support
- Prompt templates stored on the gateway
- Admin role and multiple users per organization
- Prometheus metrics endpoint

---

## 6. Tech Stack

The project uses **JavaScript (ES modules)**, matching the trip planner. Runtime validation with **Zod** and a strict lint setup replace compile-time types.

### Backend (`Backend/`)

| Tool | Purpose |
|---|---|
| **Node.js 20+ and Express** | REST API and SSE streaming |
| **ws** | WebSocket server attached to the same HTTP server |
| **Native `fetch`** | Calling provider APIs directly (no provider SDKs, so you learn each format) |
| **Zod** | Validating requests, provider responses, config, and env variables |
| **Prisma + PostgreSQL** | Users, gateway keys, usage logs |
| **ioredis + Redis** | Cache, rate limiting, circuit breaker state |
| **bcryptjs / crypto** | Password hashing; SHA-256 hashing of gateway keys |
| **jsonwebtoken** | Dashboard login sessions |
| **Pino** | Structured JSON logging |
| **Helmet, CORS** | Security headers and origin control |

### Frontend Dashboard (`Frontend/`)

| Tool | Purpose |
|---|---|
| **React + Vite** (JavaScript) | Dashboard UI |
| **Tailwind CSS** | Styling |
| **TanStack Query** | Fetching and caching dashboard data |
| **Recharts** | Latency, token, and cost charts |
| **React Router** | Pages |

### Providers

| Provider | Role in the project | Cost to test |
|---|---|---|
| **Google Gemini** | Main cloud provider for development | Free tier available |
| **Ollama** | Local models; offline testing and fallback target | Free |
| **OpenAI** | Third provider adapter | Paid API credits |
| **Anthropic** | Fourth provider adapter | Paid API credits |

You can build and demo the full system with **Gemini plus Ollama** alone. Add OpenAI and Anthropic adapters and test them with a small amount of credit, or with recorded responses in tests.

### Testing and DevOps

| Tool | Purpose |
|---|---|
| **Vitest + Supertest** | Unit and API tests |
| **Mock provider server** | Fake provider responses and streams for tests (no real API calls) |
| **autocannon** | Load and latency benchmarks |
| **ESLint + Prettier** | Linting and formatting |
| **Docker + Docker Compose** | Postgres, Redis, and the app |
| **GitHub Actions** | CI: lint, test, build |
| **Render / Railway / Fly.io** | Backend hosting (must support streaming and WebSockets) |
| **Vercel / Netlify** | Dashboard hosting |

---

## 7. System Architecture

### High-level view

```
┌──────────────────────────────────────────────────────────────┐
│ Clients: apps, curl, Trip Planner, PR Bot, Dashboard (React)  │
└─────────────┬──────────────────────────┬─────────────────────┘
              │ HTTP / SSE               │ WebSocket
              ▼                          ▼
┌──────────────────────────────────────────────────────────────┐
│                     LLMux Server (Node.js)                    │
│                                                              │
│  Middleware: request ID → auth (gateway key) → rate limit    │
│              → validate (Zod)                                │
│                           │                                  │
│                           ▼                                  │
│                  Gateway service (core)                       │
│     cache check → router → retry/fallback → usage logger      │
│                           │                                  │
│                           ▼                                  │
│                    Model router                               │
│           (alias → provider + real model ID)                 │
│                           │                                  │
│          ┌────────────┬───┴────────┬─────────────┐           │
│          ▼            ▼            ▼             ▼           │
│     OpenAI       Anthropic      Gemini        Ollama         │
│     adapter      adapter        adapter       adapter        │
└──────────┬────────────┬────────────┬─────────────┬───────────┘
           ▼            ▼            ▼             ▼
       Provider APIs (HTTPS)                 Local Ollama

        ┌──────────────┐            ┌──────────────────────┐
        │  PostgreSQL  │            │        Redis         │
        │ users, keys, │            │ cache, rate limits,  │
        │ usage logs   │            │ circuit breakers     │
        └──────────────┘            └──────────────────────┘
```

### Layer responsibilities

| Layer | Does | Must not |
|---|---|---|
| Routes / WebSocket handler | Accept the request, start the response or stream | Contain provider logic |
| Middleware | Request ID, key auth, rate limiting, validation | Call providers |
| Gateway service | Orchestrates cache, routing, retries, fallback, logging | Know any provider's format |
| Router | Resolves a model alias to a provider and real model ID | Make network calls |
| Adapters | Translate requests, responses, stream events, and errors for one provider | Know about caching, keys, or users |
| Repositories | Database reads and writes | Contain business rules |

The key design rule: **only adapters know provider formats.** Everything else works on the unified format, so adding a provider never touches the core.

### Request lifecycle (non-streaming)

```
1. Client: POST /v1/chat  { model: "fast", messages: [...] }
2. Assign request ID
3. Authenticate gateway key (hash lookup, cached in Redis)
4. Rate limit check (token bucket) ─────────────► 429 if over limit
5. Validate body with Zod ──────────────────────► 400 if invalid
6. Cache lookup (if cacheable) ─────────────────► return cached response
7. Router: "fast" → [gemini:<model-id>, ollama:<model-id>]
8. For each target in the fallback chain:
     a. Skip if its circuit breaker is open
     b. Adapter converts unified request → provider request
     c. Call provider with timeout; retry transient errors with backoff
     d. Success → adapter converts response → unified response; stop
     e. Retryable failure → record failure, try next target
9. Store in cache (if cacheable)
10. Write usage log (async, does not delay the response)
11. Return unified response with headers: X-Request-Id, X-LLMux-Provider, X-LLMux-Cache
```

### Request lifecycle (streaming)

```
1-5. Same as above
6.  Router resolves the fallback chain
7.  Open the provider stream through the adapter
      - Fallback is allowed only BEFORE the first token is sent
8.  For every provider event: adapter → unified event → write to client
      (SSE "data:" line or WebSocket message)
9.  Client disconnects or sends cancel → abort upstream request (AbortController)
10. On end: send "end" event with finish reason and usage
11. Write usage log
```

---

## 8. Unified API Format

This is the contract every client relies on. It never changes when providers change.

### Request

```json
{
  "model": "fast",
  "system": "You are a helpful travel assistant.",
  "messages": [
    { "role": "user", "content": "Plan one day in Jaipur." }
  ],
  "temperature": 0.7,
  "maxTokens": 800,
  "stream": false,
  "cache": true,
  "metadata": { "app": "trip-planner" }
}
```

| Field | Required | Notes |
|---|---|---|
| `model` | Yes | A model alias from `/v1/models` |
| `messages` | Yes | Roles: `user`, `assistant` |
| `system` | No | Kept separate, so each adapter places it correctly |
| `temperature` | No | 0 to 2, default 0.7 |
| `maxTokens` | No | Default from model config |
| `stream` | No | `true` returns SSE events |
| `cache` | No | Opt out of caching with `false` |
| `metadata` | No | Free-form tags for usage filtering |

### Response

```json
{
  "id": "req_8f2c1a",
  "model": "fast",
  "provider": "gemini",
  "providerModel": "<provider-model-id>",
  "content": "Morning: Amber Fort...",
  "finishReason": "stop",
  "usage": { "inputTokens": 42, "outputTokens": 310, "totalTokens": 352 },
  "costUsd": 0.000105,
  "latencyMs": 1830,
  "cached": false,
  "fallbackUsed": false
}
```

`finishReason` is normalized to one of: `stop`, `length`, `content_filter`, `error`.

### Stream events

Every stream, from every provider, produces the same sequence:

```
start  → { "id": "req_8f2c1a", "model": "fast", "provider": "gemini" }
delta  → { "text": "Morning: " }
delta  → { "text": "Amber Fort..." }
end    → { "finishReason": "stop", "usage": {...}, "latencyMs": 1830 }
```

Or, if something fails mid-stream:

```
error  → { "code": "PROVIDER_ERROR", "message": "..." }
```

### Error

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded. Retry after 12 seconds.",
    "requestId": "req_8f2c1a",
    "provider": null,
    "retryable": true
  }
}
```

---

## 9. Provider Adapters

### The adapter interface

Every adapter is one file that exports the same functions:

```js
/**
 * @typedef {Object} ProviderAdapter
 * @property {string} name
 * @property {(req: UnifiedRequest, target: Target) => {url: string, headers: object, body: object}} buildRequest
 * @property {(json: object) => UnifiedResponse} parseResponse
 * @property {(raw: string) => UnifiedStreamEvent[]} parseStreamChunk
 * @property {(status: number, body: object) => GatewayError} mapError
 */
```

Plus one shared helper that runs the HTTP call, timeouts, and stream reading, so adapters stay pure translation code and are easy to unit test.

### What each adapter translates

The table shows the *kind* of differences each adapter handles. Exact field names and endpoints change over time, so always check each provider's current API reference while writing the adapter.

| Concern | OpenAI | Anthropic | Gemini | Ollama |
|---|---|---|---|---|
| Auth | Bearer token header | API key header + version header | API key | None (local) |
| System prompt | A message with the `system` role | Separate top-level field | Separate system instruction field | A message with the `system` role |
| Assistant role name | `assistant` | `assistant` | `model` | `assistant` |
| Message text | `content` string | `content` string or blocks | `parts` list | `content` string |
| Max tokens | Optional | Required | Optional, in a generation config | Optional, in options |
| Where the answer is | `choices` list | `content` blocks | `candidates` list | `message` object |
| Token usage | `usage` object | `usage` object | Usage metadata object | Token counts on the final message |
| Streaming format | SSE chunks | SSE with typed events | SSE chunks | Newline-delimited JSON |

### Adding a new provider

1. Create `Backend/src/providers/<name>.adapter.js` implementing the interface.
2. Register it in `providers/index.js`.
3. Add its models to `config/models.js` with prices.
4. Add its key to `.env.example`.
5. Add unit tests with recorded sample responses.

No other file changes. This is the main proof that the architecture is clean.

---

## 10. Model Routing and Configuration

Clients use **aliases**, not provider model IDs. Aliases can be changed on the server without any client change.

```js
// Backend/src/config/models.js
// Model IDs and prices below are placeholders. Copy current values
// from each provider's documentation and pricing page.
export const models = {
  fast: {
    targets: [
      { provider: "gemini", model: "<gemini-fast-model-id>" },
      { provider: "ollama", model: "<local-model-name>" },
    ],
    defaultMaxTokens: 1024,
  },
  smart: {
    targets: [
      { provider: "anthropic", model: "<claude-model-id>" },
      { provider: "openai", model: "<openai-model-id>" },
      { provider: "gemini", model: "<gemini-pro-model-id>" },
    ],
    defaultMaxTokens: 2048,
  },
  local: {
    targets: [{ provider: "ollama", model: "<local-model-name>" }],
    defaultMaxTokens: 1024,
  },
};

// Price per 1 million tokens, stored in micro-dollars (integers).
export const pricing = {
  "<gemini-fast-model-id>": { inputPerMTok: 0, outputPerMTok: 0 },
  "<claude-model-id>": { inputPerMTok: 0, outputPerMTok: 0 },
};
```

- `targets[0]` is the primary; the rest form the **fallback chain**.
- Clients may also call a provider model directly with `provider:model` (for example `ollama:<local-model-name>`), which skips fallback.
- The config is validated with Zod at startup, so a typo stops the server immediately instead of failing at request time.

---

## 11. Streaming Design

### Two transports, one internal stream

Adapters turn provider output into a single internal stream of unified events. The transport layer only decides how to deliver them.

```
Provider stream ──► Adapter.parseStreamChunk ──► unified events ──┬─► SSE writer
                                                                  └─► WebSocket writer
```

### SSE (on `POST /v1/chat` with `stream: true`)

- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Each event is written as `event: delta` and `data: {...}`, followed by a blank line
- Best for one-off streaming requests; works with plain `fetch` on the client

### WebSocket (`/v1/ws`)

- Best for chat UIs that send many messages over one connection
- Supports multiple in-flight requests on one socket, matched by a client-provided `requestId`
- Supports explicit cancel messages
- See [WebSocket Protocol](#19-websocket-protocol)

### Rules that keep streaming correct

| Problem | Solution |
|---|---|
| Provider chunks split JSON across network packets | Buffer text and parse only complete lines or events |
| Client closes the tab mid-stream | Listen for `close` and call `AbortController.abort()` on the provider request |
| Provider fails after tokens were sent | Do **not** fall back (the user already saw partial text); send an `error` event |
| Provider fails before any token | Fall back to the next target transparently |
| Slow client, fast provider | Respect `res.write()` returning `false` and wait for `drain` (backpressure) |
| Usage numbers for streams | Use the provider's final usage data when it sends it; otherwise estimate and mark `usageEstimated: true` |
| Idle proxies closing connections | Send a heartbeat comment every 15 seconds |

---

## 12. Caching

Identical requests with deterministic settings return a stored response instead of calling a provider again.

**Cache key**

```
cache:v1:<sha256 of normalized { model, system, messages, temperature, maxTokens }>
```

Normalization (sorted keys, trimmed text) makes logically identical requests produce the same key.

**Rules**

- Cache only when `cache` is not `false`
- Cache only when `temperature` is `0` by default (random outputs shouldn't be reused); configurable
- Cache only successful, complete responses (`finishReason: stop`)
- TTL defaults to 1 hour (configurable)
- Cached responses return `cached: true`, `costUsd: 0`, and header `X-LLMux-Cache: HIT`
- Streaming requests can be served from cache by replaying the stored text as a short stream (P1 stretch)

**What to measure:** cache hit rate and cost saved, both shown on the dashboard.

---

## 13. Rate Limiting

Each gateway key gets a request budget enforced in Redis with a **token bucket**.

**How the token bucket works**

- Each key has a bucket with a capacity (for example 60 tokens) that refills at a fixed rate (for example 1 token per second).
- Each request removes 1 token. If the bucket is empty, the request is rejected with `429`.
- Short bursts are allowed up to the capacity, while the long-term rate stays fixed.

**Why a Lua script:** reading the bucket, refilling, and taking a token must happen as **one atomic step**, or two parallel requests could both take the last token. Running the logic as a Redis Lua script makes it atomic.

**Response headers**

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 41
Retry-After: 12        (only on 429)
```

**Two separate limits**

| Limit | Protects |
|---|---|
| Per gateway key | Fair use between your users |
| Per provider (optional) | Staying under each provider's own rate limit |

---

## 14. Retries, Fallback, and Circuit Breaker

### Which errors are retryable

| Error | Retry same target? | Fall back to next target? |
|---|---|---|
| Timeout, network error | Yes | Yes |
| `429` from provider | Yes (after `Retry-After` if given) | Yes |
| `5xx` from provider | Yes | Yes |
| `400` invalid request | No | No (the next provider would fail too) |
| `401` / `403` bad provider key | No | Yes (and alert in logs) |

### Retries

- Up to 2 retries per target
- **Exponential backoff with jitter:** wait about 250 ms, then 500 ms, each with a random offset so many clients don't retry at the same instant
- An overall request deadline (for example 60 seconds) caps total time across retries and fallbacks

### Fallback

- Walk the alias's `targets` list in order
- Record `fallbackUsed: true` and the provider that finally answered
- For streams, only before the first token is sent

### Circuit breaker (per provider)

```
CLOSED ──(5 failures in 30s)──► OPEN ──(after 30s)──► HALF-OPEN
   ▲                                                      │
   └──────────(test request succeeds)─────────────────────┘
                (test request fails) ──► back to OPEN
```

- **Closed:** requests flow normally
- **Open:** the provider is skipped immediately, so the fallback answers fast instead of waiting for timeouts
- **Half-open:** one test request checks whether the provider recovered

State lives in Redis so every server instance shares it.

---

## 15. Authentication and API Keys

### Two kinds of auth

| Who | Method | Used for |
|---|---|---|
| Dashboard users | Email + password, JWT session | Managing keys, viewing usage |
| Apps calling the gateway | Gateway API key in `Authorization: Bearer` | `/v1/*` endpoints |

### Gateway key design

- Format: `llmux_` + 32 random bytes encoded as text, for example `llmux_sk_9f3a...`
- The full key is shown **once** at creation
- The database stores only a **SHA-256 hash** plus a short visible prefix (for example `llmux_sk_9f3a`) so users can recognize keys in the dashboard
- Lookup: hash the incoming key and find the matching row (cached in Redis for a few minutes)
- Keys can be named, given a custom rate limit, and revoked instantly

**Why SHA-256 here instead of bcrypt:** gateway keys are long random strings, so they can't be guessed by brute force, and the check runs on every request, where bcrypt would add noticeable latency. Passwords are short and human-chosen, so they still use bcrypt.

### Provider keys

- Provider keys (OpenAI, Anthropic, Gemini) live only in server environment variables
- They are never returned by any endpoint or written to logs

---

## 16. Usage and Cost Tracking

Every request writes one row to `usage_logs`.

**Cost calculation**

```
cost = (inputTokens × inputPricePerMillion + outputTokens × outputPricePerMillion) / 1,000,000
```

- Prices come from `config/models.js`
- Stored as **integer micro-dollars** (1 USD = 1,000,000) to avoid floating-point errors
- Cached responses cost 0 and record the cost they *would have* had, so the dashboard can show money saved
- Local Ollama models cost 0

**Logging must not slow requests:** the log write happens after the response is sent. If the database is briefly unavailable, logs are buffered in memory and flushed in batches.

---

## 17. Database Design

### Tables

**users**
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| email | text | unique |
| password_hash | text | bcrypt |
| name | text | |
| created_at | timestamp | |

**api_keys**
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| user_id | UUID (FK → users) | |
| name | text | e.g. "trip-planner-prod" |
| key_prefix | text | visible part, e.g. `llmux_sk_9f3a` |
| key_hash | text | SHA-256, **unique** |
| rate_limit_per_min | int | nullable = default |
| monthly_budget_micro_usd | bigint | nullable (P2) |
| last_used_at | timestamp | |
| revoked_at | timestamp | nullable |
| created_at | timestamp | |

**usage_logs**
| Column | Type | Notes |
|---|---|---|
| id | UUID (PK) | |
| request_id | text | unique |
| api_key_id | UUID (FK) | |
| model_alias | text | e.g. `fast` |
| provider | text | provider that answered |
| provider_model | text | real model ID |
| input_tokens | int | |
| output_tokens | int | |
| usage_estimated | boolean | |
| cost_micro_usd | bigint | |
| saved_micro_usd | bigint | cost avoided by cache hits |
| latency_ms | int | total time |
| time_to_first_token_ms | int | streams only |
| status | text | `success` / `error` |
| error_code | text | nullable |
| cached | boolean | |
| fallback_used | boolean | |
| attempts | int | retries + fallbacks |
| streamed | boolean | |
| transport | text | `http` / `sse` / `ws` |
| metadata | jsonb | client tags |
| created_at | timestamp | indexed |

**Indexes:** `(api_key_id, created_at)`, `(provider, created_at)`, `(model_alias, created_at)`.

**Message content is not stored by default**, for privacy and storage reasons. An optional debug mode can store truncated prompts for local development only.

### What Redis holds

| Key pattern | Purpose | TTL |
|---|---|---|
| `cache:v1:<hash>` | Cached responses | 1 hour |
| `rl:<keyId>` | Token bucket state | Auto-expire when idle |
| `cb:<provider>` | Circuit breaker state and failure count | Short |
| `key:<hash>` | Cached key lookup | 5 minutes |

---

## 18. REST API Endpoints

### Gateway endpoints (auth: gateway API key)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/v1/chat` | Chat completion; SSE stream when `stream: true` |
| GET | `/v1/models` | List model aliases and their providers |
| GET | `/v1/ws` | WebSocket upgrade (key sent in the first message or query) |

### Dashboard endpoints (auth: JWT)

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Log in |
| POST | `/api/auth/logout` | Log out |
| GET | `/api/auth/me` | Current user |
| GET | `/api/keys` | List my keys (prefix only) |
| POST | `/api/keys` | Create a key (returns full key once) |
| PATCH | `/api/keys/:id` | Rename or change rate limit |
| DELETE | `/api/keys/:id` | Revoke a key |
| GET | `/api/usage/summary?from=&to=` | Totals: requests, tokens, cost, saved, error rate |
| GET | `/api/usage/timeseries?metric=&interval=` | Chart data |
| GET | `/api/usage/breakdown?by=model\|provider\|key` | Grouped totals |
| GET | `/api/usage/logs?page=` | Recent requests table |
| GET | `/api/providers/health` | Circuit breaker state per provider |
| POST | `/api/playground/chat` | Test a model from the dashboard |

### System

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Liveness: server is up |
| GET | `/ready` | Readiness: Postgres and Redis reachable |

### Example calls

```bash
# Normal request
curl -X POST http://localhost:5000/v1/chat \
  -H "Authorization: Bearer llmux_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","messages":[{"role":"user","content":"Hello"}]}'

# Streaming request (SSE)
curl -N -X POST http://localhost:5000/v1/chat \
  -H "Authorization: Bearer llmux_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"fast","stream":true,"messages":[{"role":"user","content":"Tell me a story"}]}'
```

---

## 19. WebSocket Protocol

All messages are JSON with a `type` field.

### Client → Server

```json
{ "type": "auth", "apiKey": "llmux_sk_..." }

{ "type": "chat", "requestId": "c1", "model": "fast",
  "messages": [{ "role": "user", "content": "Hi" }] }

{ "type": "cancel", "requestId": "c1" }

{ "type": "ping" }
```

### Server → Client

```json
{ "type": "auth_ok" }
{ "type": "start", "requestId": "c1", "provider": "gemini" }
{ "type": "delta", "requestId": "c1", "text": "Hello" }
{ "type": "end",   "requestId": "c1", "finishReason": "stop", "usage": { } }
{ "type": "error", "requestId": "c1", "code": "PROVIDER_ERROR", "message": "..." }
{ "type": "pong" }
```

### Rules

- The first message must be `auth` within 5 seconds, or the server closes the socket
- Every `chat` must carry a unique `requestId`, which lets several requests stream on one socket at once
- A maximum number of in-flight requests per socket (for example 3)
- Rate limiting applies per `chat` message, the same as HTTP
- Closing the socket cancels all of its in-flight provider requests
- Heartbeat pings detect dead connections

---

## 20. Dashboard

A React app for gateway users.

| Page | Shows |
|---|---|
| **Overview** | Requests today, total tokens, total cost, money saved by cache, error rate, p50 / p95 latency |
| **Charts** | Requests over time, cost by model, latency by provider, cache hit rate |
| **Logs** | Table of recent requests: time, model, provider, tokens, cost, latency, status, cached, fallback |
| **API Keys** | Create, rename, set limits, revoke; full key shown once in a copy box |
| **Providers** | Health and circuit breaker state for each provider |
| **Playground** | Pick a model, type a prompt, watch the stream live, and compare two models side by side |

The playground is the best demo moment: the same prompt streaming from two providers next to each other, with latency and cost shown under each.

---

## 21. Error Handling

### Error codes

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | No | Body failed validation |
| `UNKNOWN_MODEL` | 400 | No | Alias not in config |
| `UNAUTHORIZED` | 401 | No | Missing or invalid gateway key |
| `KEY_REVOKED` | 401 | No | Key was revoked |
| `RATE_LIMITED` | 429 | Yes | Gateway rate limit hit |
| `BUDGET_EXCEEDED` | 402 | No | Monthly budget reached (P2) |
| `PROVIDER_RATE_LIMITED` | 503 | Yes | All targets were rate-limited |
| `PROVIDER_UNAVAILABLE` | 503 | Yes | All targets failed or circuits open |
| `PROVIDER_ERROR` | 502 | Maybe | Provider returned an unexpected error |
| `TIMEOUT` | 504 | Yes | Deadline exceeded |
| `INTERNAL_ERROR` | 500 | Maybe | Bug in the gateway |

### Principles

- One central Express error handler converts everything into the error format from [section 8](#8-unified-api-format)
- Every error includes the `requestId`, so a user can report it and you can find it in the logs
- Provider error bodies are logged but never passed raw to the client (they can leak internal details)

---

## 22. Security

| Area | Measure |
|---|---|
| Gateway keys | SHA-256 hashed, shown once, revocable, prefix-only display |
| Passwords | bcrypt |
| Provider keys | Server env variables only; never logged or returned |
| Input | Zod validation, max message count and max body size (for example 1 MB) |
| Abuse | Per-key rate limits, max tokens cap per request, max WebSocket in-flight requests |
| Logs | Prompts and responses not stored by default; `Authorization` headers redacted |
| Transport | HTTPS in production; strict CORS allowlist for the dashboard |
| Headers | Helmet |
| Dependencies | `npm audit` in CI |

---

## 23. Logging and Observability

- Every request gets an `X-Request-Id` (generated or accepted from the client), attached to all logs and responses
- Pino writes structured JSON logs: request ID, key ID, model, provider, attempt number, latency, status
- Key timings recorded per request: total latency, provider latency, **gateway overhead** (total minus provider time), and time to first token for streams
- `/health` and `/ready` endpoints for the hosting platform
- (P2) A `/metrics` endpoint in Prometheus format

---

## 24. Folder Structure

```
llmux/
├── Backend/                       # Gateway server (JavaScript, ES modules)
│   ├── prisma/
│   │   └── schema.prisma
│   ├── src/
│   │   ├── config/
│   │   │   ├── env.js             # Zod-validated environment
│   │   │   ├── models.js          # aliases, fallback chains, pricing
│   │   │   ├── db.js
│   │   │   └── redis.js
│   │   ├── middleware/
│   │   │   ├── requestId.js
│   │   │   ├── apiKeyAuth.js
│   │   │   ├── jwtAuth.js
│   │   │   ├── rateLimit.js
│   │   │   ├── validate.js
│   │   │   └── errorHandler.js
│   │   ├── providers/
│   │   │   ├── index.js           # adapter registry
│   │   │   ├── httpClient.js      # fetch, timeouts, stream reading
│   │   │   ├── openai.adapter.js
│   │   │   ├── anthropic.adapter.js
│   │   │   ├── gemini.adapter.js
│   │   │   └── ollama.adapter.js
│   │   ├── gateway/
│   │   │   ├── gateway.service.js # orchestration
│   │   │   ├── router.js          # alias → targets
│   │   │   ├── retry.js           # backoff + jitter
│   │   │   ├── circuitBreaker.js
│   │   │   ├── cache.js
│   │   │   └── cost.js
│   │   ├── transports/
│   │   │   ├── sse.js
│   │   │   └── websocket.js
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── keys/
│   │   │   ├── usage/
│   │   │   └── playground/
│   │   ├── routes/
│   │   │   ├── v1.routes.js       # /v1/chat, /v1/models
│   │   │   └── api.routes.js      # dashboard API
│   │   ├── scripts/
│   │   │   └── rateLimit.lua
│   │   ├── utils/
│   │   ├── app.js
│   │   └── server.js
│   ├── tests/
│   │   ├── unit/                  # adapters, cost, retry, cache key
│   │   ├── integration/           # endpoints with mock provider
│   │   ├── fixtures/              # recorded provider responses and streams
│   │   └── mockProvider.js
│   ├── bench/
│   │   └── overhead.bench.js      # autocannon scripts
│   ├── .env.example
│   ├── eslint.config.js
│   └── package.json
│
├── Frontend/                      # Dashboard (React, JavaScript)
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── overview/
│   │   │   ├── logs/
│   │   │   ├── keys/
│   │   │   ├── providers/
│   │   │   └── playground/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── .env.example
│   ├── eslint.config.js
│   └── package.json
│
├── .github/workflows/ci.yml
├── docker-compose.yml             # Postgres + Redis (+ optional Ollama)
├── .gitignore
├── .prettierrc
└── README.md
```

---

## 25. Environment Variables

**Backend/.env**
```
NODE_ENV=development
PORT=5000
DASHBOARD_URL=http://localhost:5173

DATABASE_URL=postgresql://llmux:llmux@localhost:5432/llmux
REDIS_URL=redis://localhost:6379

JWT_SECRET=change-me

# Provider keys (leave empty to disable a provider)
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434

# Gateway behavior
DEFAULT_RATE_LIMIT_PER_MIN=60
REQUEST_TIMEOUT_MS=30000
REQUEST_DEADLINE_MS=60000
MAX_RETRIES=2
CACHE_TTL_SECONDS=3600
CACHE_ONLY_DETERMINISTIC=true
MAX_BODY_SIZE=1mb
LOG_LEVEL=info

# Production: proxies in front of the server (1 on Render), so the per-IP
# login limit sees real client addresses. Keep 0 locally.
TRUST_PROXY=0
```

**Frontend/.env**
```
VITE_API_URL=http://localhost:5000
VITE_WS_URL=ws://localhost:5000/v1/ws
```

A provider with an empty key is disabled at startup, and its models are hidden from `/v1/models`.

---

## 26. Local Setup

**Requirements:** Node.js 20+, Git, Docker Desktop, and optionally Ollama for local models.

```bash
# 1. Clone
git clone https://github.com/SanskritiDevOps/LLMux.git
cd LLMux

# 2. Start Postgres and Redis
docker compose up -d

# 3. (Optional) Pull the small local model the `fast` and `local` aliases use
ollama pull llama3.2:1b

# 4. Backend
cd Backend
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
npm install
npx prisma migrate dev
npm run dev

# 5. Dashboard (new terminal, from the repo root)
cd Frontend
cp .env.example .env
npm install
npm run dev
```

Then open the dashboard at `http://localhost:5173`, create an account, create a gateway key, and try the playground.

**Before step 4's `npm run dev`:** in `Backend/.env`, set `JWT_SECRET` to a random value of at least 32 characters (the command is in `.env.example`; the server refuses to start otherwise), and set at least one provider: `OLLAMA_BASE_URL` (already set for a local Ollama) or a `GEMINI_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`. Without any, every alias answers `UNKNOWN_MODEL`.

**Check it:** `curl http://localhost:5000/ready` should answer `{"status":"ready","checks":{"database":"ok","redis":"ok"}}`. Tests: `npm test` in `Backend/` (no Docker needed), or the same as CI with `TEST_REAL_DEPS=1 npm test`. More checks and common problems: [docs/Setup-and-Initialisation.md](docs/Setup-and-Initialisation.md), if you have the docs folder.

### Backend scripts

```json
"type": "module",
"scripts": {
  "dev": "node --watch src/server.js",
  "start": "node src/server.js",
  "lint": "eslint .",
  "test": "vitest run --passWithNoTests",
  "bench": "node bench/overhead.bench.js"
}
```

---

## 27. Code Quality and Testing

### Code quality

- ESLint and Prettier in both folders
- Zod at every boundary: env, config, request bodies, WebSocket messages, and provider responses
- JSDoc types on the adapter interface and core functions
- Adapters are pure functions (input → output), which makes them easy to test

### Testing strategy

**Tests never call real providers.** They use recorded responses (fixtures) and a mock provider server, so tests are free, fast, and repeatable.

| Area | Type | What to verify |
|---|---|---|
| Each adapter | Unit | Request translation, response parsing, stream parsing (including chunks split mid-JSON), error mapping |
| Router | Unit | Aliases resolve correctly; unknown model errors |
| Cost | Unit | Integer micro-dollar math; cached and local cost is 0 |
| Cache key | Unit | Same logical request gives the same key; different temperature gives a different key |
| Retry | Unit | Backoff timing, retryable vs non-retryable errors |
| Circuit breaker | Unit | Closed → open → half-open → closed transitions |
| Rate limiter | Integration | Burst allowed up to capacity, then `429` with `Retry-After` |
| Fallback | Integration | Primary returns 500, secondary answers, `fallbackUsed: true` |
| Streaming | Integration | SSE events arrive in order; client disconnect aborts the upstream request |
| Auth | Integration | Missing, invalid, and revoked keys are rejected |
| WebSocket | Integration | Auth timeout, two parallel requests, cancel |

### Mock provider

`tests/mockProvider.js` is a tiny Express server that can be told to: answer normally, stream slowly, fail with a given status, time out, or drop the connection mid-stream. It is the main tool for testing retries, fallback, and streaming edge cases.

---

## 28. Benchmarking

Claims in this README and on a resume must come from real measurements. This section explains how to produce them.

### What to measure

| Metric | How |
|---|---|
| **Gateway overhead** | Point LLMux at the mock provider with a fixed 0 ms response, run autocannon, and report p50 / p95 / p99 latency added by the gateway |
| **Throughput** | Requests per second the gateway handles against the mock provider |
| **Streaming overhead** | Time to first token through LLMux vs calling the mock directly |
| **Cache benefit** | Latency of a cache hit vs a real provider call; cost saved over a repeated-prompt workload |
| **Fallback time** | Time to answer when the primary is down, with and without an open circuit breaker |

### How it's measured

`npm run bench` in `Backend/` (needs Docker for Postgres and Redis). Three processes, so none competes with another for its thread:
- **a mock provider** (`tests/mockProvider.js`) that answers instantly
- **the real LLMux app** (`bench/gatewayServer.js`) with the full production path: gateway key check (cached in Redis), the rate limit (the Redis Lua script), validation, routing, the adapter, the HTTP call, cost, and a usage row written to Postgres
- **the load generator** (`bench/overhead.bench.js`): sequential timings, and autocannon for load

Since only the provider is fake, every millisecond measured is LLMux's own. The script uses the `llmux_test` database and Redis database 2, and removes everything it creates.

### Results

Measured 2026-10-30 on a laptop: Intel Core i5-12450H (12 threads), 16 GB RAM, Windows 11, Node 22.14, with Postgres 16 and Redis 7 in Docker Desktop. Two full runs back to back; where they differ, both are shown.

| Metric | Result | Setup |
|---|---|---|
| **Gateway overhead** (median, one request at a time) | **4.4–4.9 ms** | 200 requests each: LLMux 5.4–5.8 ms vs the provider called directly 0.9–1.0 ms |
| Gateway overhead (p95, one request at a time) | 8.3–10.1 ms vs 1.2–1.4 ms direct | same |
| **Cache hit** (median, one request at a time) | **4.2–7.5 ms**, and **0 provider calls** | `temperature: 0`, answered from Redis |
| Throughput through LLMux, no cache | 221–302 requests/s (p50 153–214 ms) | 50 connections × 10 s |
| Throughput through LLMux, cache hits | 419–651 requests/s | 50 connections × 10 s |
| This machine's ceiling: LLMux `GET /health` | 850–3,003 requests/s | an endpoint that does no work, same load |
| **Time to first token** (median of 100 streams) | **16.0 ms** through LLMux vs 13.5 ms direct (**+2.6 ms**) | the mock's first event includes a 1 ms timer, which Windows rounds to its ~15 ms clock tick |
| **Fallback, primary down** (Gemini answering 503) | **0.7–0.9 s** for the first request (3 tries with backoff, then Ollama); **9.7–10.6 ms** once the circuit is open | 30 requests in a row |

**How to read these:**
- **The overhead is the headline:** about 4–5 ms added to each request, measured one request at a time, where the machine matters least. Next to a real model call (hundreds of milliseconds to seconds), it's small.
- **The throughput numbers are this laptop's, not LLMux's limit.** Even `/health`, which does nothing, varied from 850 to 3,003 requests a second between the two runs, because of whatever else the machine was doing. Run it on a Linux server for capacity numbers.
- **The circuit breaker is what makes fallback fast:** once Gemini had failed 5 times, LLMux stopped trying it and answered from Ollama in about 10 ms instead of 0.7–0.9 s.
- **Not measured yet:** real providers (no keys were set), and production hardware.

Always record the machine and settings next to each number, as above.

---

## 29. CI Pipeline

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull request, as two jobs:

| Job | Steps |
|---|---|
| **Backend** (lint + test) | `npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run lint` → `npm test`, with **Postgres 16 and Redis 7 service containers** and `TEST_REAL_DEPS=1`, so the database and Redis tests run too (950 tests) |
| **Frontend** (lint + build) | `npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run lint` → `npm run build` |

- The tests use their own `llmux_test` database, migrated by the test setup with `prisma migrate deploy`, the same command a deploy runs.
- **The audit covers production dependencies only** (dev tools never run in production), and fails on high or critical advisories. Moderate ones are reviewed by hand.
- **CI never uses real provider keys:** every provider is tested against recorded or documented responses and a mock provider server.

---

## 30. Deployment

| Piece | Host | Config |
|---|---|---|
| Gateway (Backend) | Render web service | [`render.yaml`](render.yaml): build runs `npm ci` and `npx prisma migrate deploy`, start runs `npm start`, health check `/health`, `TRUST_PROXY=1` |
| PostgreSQL | Render Postgres | same Blueprint; `DATABASE_URL` is wired in automatically |
| Redis | Render Key Value | same Blueprint; `REDIS_URL` is wired in automatically, eviction `volatile-lru` (every LLMux key has an expiry) |
| Dashboard (Frontend) | Vercel, root directory `Frontend` | [`Frontend/vercel.json`](Frontend/vercel.json): Vite build, and every path served by `index.html` so routes like `/logs` work on reload |
| Ollama | Local only | Hosted deployments use cloud providers |

**Steps:**
1. **Backend:** Render → New → Blueprint → this repository. When asked, fill in `DASHBOARD_URL` (the Vercel URL from step 2; it can be set after) and at least one provider key. `JWT_SECRET` is generated by Render.
2. **Dashboard:** Vercel → New Project → this repository, root directory `Frontend`. Set `VITE_API_URL` to the Render service's URL (for example `https://llmux-api.onrender.com`) and `VITE_WS_URL` to the same with `wss://` and `/v1/ws`.
3. Set `DASHBOARD_URL` on Render to the exact Vercel URL (no trailing slash), and redeploy the backend.
4. **Check:** `https://<api>/ready` answers `ready`; register on the dashboard; create a key; run a chat in the playground.

**Free-plan limits to know** (Render): the web service sleeps after 15 minutes idle, so the first request after that takes a while; free Postgres expires after 30 days; free Key Value keeps data in memory only, so the cache and rate-limit buckets reset on a restart (LLMux treats that as a miss, never an error).

**Cross-site cookies:** the dashboard (`*.vercel.app`) and the API (`*.onrender.com`) are different sites, so the session cookie is sent as `SameSite=None; Secure` (already set in production). Browsers that block third-party cookies, such as Safari by default, won't keep the session. The fix is one custom domain for both, for example `app.example.com` and `api.example.com`, which makes them the same site.

**Checklist**
- Provider keys set as secret env variables on the host
- `npx prisma migrate deploy` runs on deploy
- CORS allows only the dashboard URL
- Health checks point to `/health`
- Proxy or platform timeouts are long enough for streaming responses
- A demo gateway key with a low rate limit, so you can share the live demo safely
- `TRUST_PROXY` set to the number of proxies in front of the server (1 on Render), so the per-IP login limit sees real client addresses
- `npm audit --omit=dev` clean (CI fails on high or critical advisories)

---

## 31. Build Roadmap

About **25 days at 4-5 hours a day**. Build the small version first, then add reliability features.

| Days | Focus | Output |
|---|---|---|
| 1-2 | Repo, Docker, Prisma schema, Express skeleton, env validation, ESLint, CI | Server and CI running |
| 3-5 | Unified schema, router, Gemini and Ollama adapters, `POST /v1/chat` (non-streaming) | Same request works with two providers |
| 6-7 | Gateway API keys (hashed), dashboard auth endpoints | Requests require a valid key |
| 8-10 | SSE streaming, stream parsing for both adapters, cancel on disconnect | Live token streaming |
| 11-12 | WebSocket transport and protocol | Streaming chat over WebSocket |
| 13 | Usage logging and cost calculation | Every request logged with tokens and cost |
| 14-15 | Redis caching and token-bucket rate limiting | Cache hits and `429`s working |
| 16-17 | Retries, fallback chains, circuit breaker; OpenAI and Anthropic adapters | Survives a provider outage |
| 18-21 | Dashboard: overview, charts, logs, keys, playground | Visual demo ready; **deploy** |
| 22-23 | Mock provider, tests for adapters, streaming, fallback, rate limits | Green CI with real coverage |
| 24 | Benchmarks; fill the results table | Real numbers |
| 25 | Connect the trip planner, README polish, demo video | Resume-ready |

**Rule:** if the dashboard runs late, cut pages (keep overview, logs, and playground). Never cut tests for adapters and fallback.

---

## 32. Projects Built on LLMux

LLMux is the platform; these products use it.

| Project | How it uses LLMux |
|---|---|
| **Group Trip Planner** | `generateItinerary()` calls `POST /v1/chat` with model `smart` instead of a provider directly |
| **AI PR Review Bot** (next) | All review calls go through LLMux, using `fast` for small diffs and `smart` for large ones |

Switching either product to a different model is now a one-word config change, and their usage and cost appear in the LLMux dashboard.

---

## 33. Interview Talking Points

1. **Adapter pattern:** Why do only adapters know provider formats? How long does adding a provider take?
2. **Streaming:** How do you normalize four different stream formats? What happens with partial JSON chunks, slow clients (backpressure), and disconnects?
3. **SSE vs WebSocket:** When is each the better choice, and why support both?
4. **Fallback rules:** Why never fall back after the first token is streamed? Why not fall back on a `400`?
5. **Rate limiting:** How does a token bucket work, and why must it run atomically in Redis (Lua)?
6. **Circuit breaker:** What problem does it solve that retries alone don't?
7. **Retries:** Why exponential backoff with jitter?
8. **Caching:** What makes a request safe to cache? How is the cache key built?
9. **Key security:** Why SHA-256 for gateway keys but bcrypt for passwords?
10. **Cost tracking:** Why store money as integer micro-dollars? How do you get token counts for streams?
11. **Performance:** How did you measure gateway overhead, and what were the numbers?
12. **Testing:** How do you test retries, fallback, and streaming without paying for real API calls? (Mock provider and fixtures.)
13. **Scaling:** What changes with several gateway instances? (Shared Redis state, stateless servers, WebSocket connections pinned to one instance.)

---

## 34. Future Scope

- Tool / function calling normalized across providers
- Embeddings and image input
- Latency-based or cost-based smart routing
- Per-key monthly budgets and alerts
- Prompt templates and versioning
- Semantic caching (reuse answers for similar, not just identical, prompts)
- Published JavaScript SDK
- Prometheus metrics and Grafana dashboards
- Multi-user organizations with roles
- Migration to TypeScript

---

## License

MIT
