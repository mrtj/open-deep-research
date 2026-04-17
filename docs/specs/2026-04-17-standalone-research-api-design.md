# Standalone Research API Endpoint

**Issue:** mrtj/open-deep-research#1
**Date:** 2026-04-17
**Status:** Draft

## Goal

Expose deep research as a standalone HTTP endpoint (`POST /api/research`) for programmatic access from eval pipelines and scripts. The existing chat UI continues to work unchanged.

## Approach

Extract the deep research logic from the chat route into a shared module, then build a new API route that consumes it with bearer token auth and both streaming and non-streaming response modes.

## 1. Extracted Module: `lib/ai/deep-research.ts`

The ~350 lines of deep research logic (currently inline in `app/(chat)/api/chat/route.ts`, lines 312-668) are extracted into an async generator:

```typescript
export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;          // default 7
  modelId: string;            // router model for tool orchestration
  reasoningModelId: string;   // reasoning model for analysis
  firecrawlApiKey: string;    // Firecrawl API key
}

export type DeepResearchEvent =
  | { type: 'progress-init'; maxDepth: number; totalSteps: number }
  | { type: 'activity'; status: string; message: string; timestamp: string }
  | { type: 'source'; title: string; url: string }
  | { type: 'depth'; current: number; max: number };

export interface DeepResearchResult {
  findings: Array<{ text: string; source: string }>;
  analysis: string;
}

export async function* runDeepResearch(
  params: DeepResearchParams
): AsyncGenerator<DeepResearchEvent, DeepResearchResult>;
```

The chat route is refactored to consume this generator, translating events into `dataStream.writeData()` calls. No behavior change for the existing UI.

## 2. API Route: `app/api/research/route.ts`

### Authentication

Bearer token checked against `API_KEY` environment variable.

```
Authorization: Bearer <API_KEY>
```

Returns 401 if missing or mismatched. No rate limiting (localhost eval use case).

### Request

```
POST /api/research
POST /api/research?stream=false
```

```json
{
  "topic": "string",
  "maxDepth": 7,
  "modelId": "gpt-4o",
  "reasoningModelId": "o3-mini"
}
```

| Field | Required | Default |
|-------|----------|---------|
| `topic` | yes | - |
| `maxDepth` | no | 7 |
| `modelId` | no | `gpt-4o` |
| `reasoningModelId` | no | `REASONING_MODEL` env var, or `o1-mini` |

Model IDs are free-form strings (no validation against a hardcoded list). This allows benchmarking arbitrary OpenRouter models without code changes. Invalid IDs fail at the provider level with a descriptive error.

### Streaming Response (default)

Content-Type: `text/x-ndjson`

Each line is a JSON object — one of the `DeepResearchEvent` types during research, followed by a final result line:

```json
{"type":"progress-init","maxDepth":7,"totalSteps":21}
{"type":"activity","status":"searching","message":"Searching for...","timestamp":"..."}
{"type":"source","title":"...","url":"..."}
{"type":"depth","current":2,"max":7}
...
{"type":"result","findings":[{"text":"...","source":"..."}],"analysis":"...","metadata":{"maxDepth":5,"durationMs":142000,"steps":15}}
```

### Non-Streaming Response (`?stream=false`)

Content-Type: `application/json`

Buffers all events internally, returns a single JSON object when research completes:

```json
{
  "findings": [{ "text": "...", "source": "..." }],
  "analysis": "...",
  "sources": [{ "title": "...", "url": "..." }],
  "metadata": {
    "maxDepth": 5,
    "durationMs": 142000,
    "steps": 15
  }
}
```

### Errors

Standard JSON error responses:

| Status | Condition |
|--------|-----------|
| 400 | Missing `topic`, invalid `maxDepth` |
| 401 | Missing or invalid `Authorization` header |
| 500 | Provider error, Firecrawl error, unexpected failure |

```json
{ "error": "descriptive message" }
```

## 3. Model Resolution

1. If `modelId` / `reasoningModelId` provided in request body, use those
2. Otherwise fall back to defaults: `gpt-4o` for router, `REASONING_MODEL` env var (or `o1-mini`) for reasoning

Provider routing via existing `customModel()` in `lib/ai/index.ts`: OpenRouter (if `OPENROUTER_API_KEY` set) > TogetherAI (for DeepSeek) > OpenAI.

## 4. Environment Variables

New:
- `API_KEY` — bearer token for the `/api/research` endpoint

Existing (unchanged):
- `FIRECRAWL_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `REASONING_MODEL`, `BYPASS_JSON_VALIDATION`, `MAX_DURATION`

## 5. What Changes

| File | Change |
|------|--------|
| `lib/ai/deep-research.ts` | **New** — extracted deep research generator |
| `app/api/research/route.ts` | **New** — standalone API endpoint |
| `app/(chat)/api/chat/route.ts` | **Modified** — imports and calls `runDeepResearch` instead of inline logic |

## Non-Goals

- No chat history or message persistence for API calls
- No document/block creation
- No NextAuth session support on this endpoint
- No rate limiting (localhost eval use case)
- No individual search/extract/scrape endpoints
