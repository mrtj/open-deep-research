# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Open Deep Research — an open-source AI research chatbot that uses Firecrawl (search/extract/scrape) with reasoning models to perform deep web research. Built on Next.js 15 App Router with React 19, Vercel AI SDK, Drizzle ORM (PostgreSQL), and NextAuth v5.

## Commands

```bash
pnpm dev              # Start dev server (Turbo)
pnpm build            # Production build
pnpm lint             # ESLint + Biome
pnpm lint:fix         # Auto-fix lint issues
pnpm format           # Biome formatter
pnpm db:migrate       # Run database migrations
pnpm db:generate      # Generate Drizzle migrations after schema changes
pnpm db:studio        # Open Drizzle Studio (DB viewer)
pnpm db:push          # Push schema directly to DB (no migration file)
```

## Architecture

### AI Flow
- **Router model** (gpt-4o / gpt-4o-mini) handles request routing and tool orchestration
- **Reasoning model** (configurable: o1, o3-mini, DeepSeek-R1) handles complex analysis
- Provider priority: OpenRouter key → TogetherAI (DeepSeek) → OpenAI (default)
- AI tools: `search`, `extract`, `scrape`, `deepResearch` (recursive, max 7 levels, 4.5min timeout)
- Streaming via `createDataStreamResponse` from Vercel AI SDK

### Key Directories
- `app/(chat)/api/` — API routes (chat, vote, document, suggestions, history, files)
- `app/(auth)/` — Authentication routes (login, register)
- `components/` — React components; `components/ui/` is shadcn/ui primitives
- `lib/ai/` — Model configuration, prompts, tool definitions
- `lib/db/` — Drizzle schema (`schema.ts`), migrations, query helpers
- `lib/editor/` — ProseMirror editor configuration
- `hooks/` — Custom React hooks (scroll, deep research state)

### Database (Drizzle + PostgreSQL)
Tables: User, Chat, Message (JSON content), Vote, Document (text/code/spreadsheet), Suggestion. Schema lives in `lib/db/schema.ts`. After changes, run `pnpm db:generate` then `pnpm db:migrate`.

### Authentication
NextAuth v5 with email/password. Supports anonymous auto-created sessions. Middleware in `middleware.ts`.

### Rate Limiting
Upstash Redis sliding window: 5 requests / 60 seconds per user.

## Environment Variables

**Required:** `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `AUTH_SECRET`, `POSTGRES_URL`

**Optional:** `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

**Config:** `REASONING_MODEL` (default: o1-mini), `BYPASS_JSON_VALIDATION` (for non-OpenAI models), `MAX_DURATION` (serverless timeout, default 300s), `API_KEY` (bearer token for `/api/research` endpoint)

## Conventions

- Code formatting: Biome (2-space indent, 80-char width). Run `pnpm format` before committing.
- Path alias: `@/*` maps to project root.
- Server/client split: `"use client"` for frontend components, `"server-only"` for backend logic.
- Message content is stored as JSON in the database with tool invocation tracking.
- Only gpt-4o/gpt-4o-mini natively support JSON schema output; other models need `BYPASS_JSON_VALIDATION=true`.

## Standalone Research API

`POST /api/research` — programmatic deep research endpoint (no session required).

```bash
# Streaming (NDJSON)
curl -N -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "quantum computing advances 2025", "maxDepth": 3}' \
  http://localhost:3000/api/research

# Non-streaming
curl -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic": "quantum computing advances 2025", "maxDepth": 3}' \
  'http://localhost:3000/api/research?stream=false'
```

Body: `{ topic, maxDepth?, modelId?, reasoningModelId? }`. Model IDs are free-form strings routed via the same provider logic as the chat endpoint.
