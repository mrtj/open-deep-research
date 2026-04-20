# Replace Firecrawl Search with Serper API

**Issue:** mrtj/open-deep-research#3
**Date:** 2026-04-20
**Status:** Draft

## Goal

Replace all Firecrawl `app.search()` calls with Serper API calls. Firecrawl remains for extract/scrape only.

## Approach

Create a single `serperSearch()` function in `lib/search.ts` that calls the Serper Google Search API and returns results in the same shape both existing call sites expect. No SDK dependency — plain `fetch`.

## 1. New Module: `lib/search.ts`

```typescript
export async function serperSearch(
  query: string,
  apiKey: string,
  maxResults?: number,
): Promise<{
  success: boolean;
  data: Array<{ url: string; title: string; description: string }>;
  error?: string;
}>
```

Calls `POST https://google.serper.dev/search` with body `{ q: query, num: maxResults }` and header `X-API-KEY: <apiKey>`.

Maps the Serper response:
- `organic[].link` -> `data[].url`
- `organic[].title` -> `data[].title`
- `organic[].snippet` -> `data[].description`

Returns `{ success: true, data: [...] }` on success, `{ success: false, data: [], error: "..." }` on failure.

## 2. Changes to Existing Files

### `lib/ai/deep-research.ts`

- Add `serperApiKey: string` to `DeepResearchParams` (alongside existing `firecrawlApiKey`).
- Replace `app.search(searchTopic)` (line 206) with `serperSearch(searchTopic, serperApiKey)`.
- The `FirecrawlApp` instance stays — it's still used by `extractFromUrls`.

### `app/(chat)/api/chat/route.ts`

- Replace `app.search(query)` (line 197) in the `search` tool with `serperSearch(query, process.env.SERPER_API_KEY!)`.
- The `FirecrawlApp` instance stays — it's still used by `extract` and `scrape` tools.
- `maxResults` parameter (already defined in the tool schema) is passed through to `serperSearch`.

### `app/api/research/route.ts`

- Read `SERPER_API_KEY` from env, return 500 if missing.
- Pass `serperApiKey` in the params object to `runDeepResearch`.

### `CLAUDE.md`

- Add `SERPER_API_KEY` to environment variables section.

### `docs/research-api.md`

- Add `SERPER_API_KEY` to the setup section.

## 3. Environment Variables

New:
- `SERPER_API_KEY` — required for web search (both chat and `/api/research`)

Unchanged:
- `FIRECRAWL_API_KEY` — still required for extract/scrape

## 4. What Does NOT Change

- Firecrawl extract (`app.extract()`) and scrape (`app.scrape()`) — untouched
- All streaming event types, API response shapes, and UI behavior — identical
- No new dependencies added to `package.json`

## 5. File Summary

| File | Change |
|------|--------|
| `lib/search.ts` | **New** — `serperSearch()` function |
| `lib/ai/deep-research.ts` | **Modified** — add `serperApiKey` param, replace `app.search()` |
| `app/(chat)/api/chat/route.ts` | **Modified** — replace `app.search()` in search tool |
| `app/api/research/route.ts` | **Modified** — validate and pass `serperApiKey` |
| `CLAUDE.md` | **Modified** — add `SERPER_API_KEY` |
| `docs/research-api.md` | **Modified** — add `SERPER_API_KEY` to setup |
