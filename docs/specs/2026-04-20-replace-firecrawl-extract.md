# Replace Firecrawl Extract/Scrape with Readability

**Issue:** mrtj/open-deep-research#4
**Date:** 2026-04-20
**Status:** Draft

## Goal

Remove the Firecrawl dependency for page extraction and scraping. Replace it with Mozilla Readability (article extraction) + linkedom (server-side DOM) + our own reasoning model (for prompt-based extraction). After this change, `FIRECRAWL_API_KEY` is no longer needed.

## Approach

Create `lib/extract.ts` with two functions that replace the three Firecrawl call sites. Use `fetch` + `linkedom` + `@mozilla/readability` for HTML-to-clean-text, and `generateText()` with our reasoning model for prompt-directed extraction.

## 1. New Module: `lib/extract.ts`

### `extractPageContent(url: string)`

Replaces `app.scrapeUrl(url)`.

1. Fetch the URL with a 15s timeout (`AbortSignal.timeout`)
2. Parse HTML with `linkedom` (lightweight server-side DOM)
3. Run through `@mozilla/readability` Readability to extract article content
4. Return `{ success: true, content: article.textContent, title: article.title }` or `{ success: false, error }` on failure
5. If Readability fails to extract (returns null), fall back to returning the raw text content from the body

```typescript
export async function extractPageContent(url: string): Promise<{
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}>
```

### `extractWithPrompt(url: string, prompt: string, modelId: string)`

Replaces `app.extract([url], { prompt })`.

1. Call `extractPageContent(url)` to get clean text
2. Pass the text + prompt to `generateText()` using `customModel(modelId, true)`
3. Return `{ success: true, data: result.text }` or `{ success: false, error }` on failure

```typescript
export async function extractWithPrompt(
  url: string,
  prompt: string,
  modelId: string,
): Promise<{
  success: boolean;
  data?: string;
  error?: string;
}>
```

## 2. Changes to Existing Files

### `lib/ai/deep-research.ts`

- Remove `import FirecrawlApp from '@mendable/firecrawl-js'`
- Remove `firecrawlApiKey` from `DeepResearchParams`
- Remove `const app = new FirecrawlApp(...)` instance
- Import `extractWithPrompt` from `@/lib/extract`
- Rewrite `extractFromUrls` to call `extractWithPrompt(url, prompt, reasoningModelId)` for each URL
- The prompt stays the same: `Extract key information about ${originalTopic}...`

### `app/(chat)/api/chat/route.ts`

- Remove `import FirecrawlApp from '@mendable/firecrawl-js'`
- Remove `const app = new FirecrawlApp(...)` instance
- Remove `firecrawlTools` array and `allTools` — simplify to a single tools list
- Import `extractPageContent`, `extractWithPrompt` from `@/lib/extract`
- `extract` tool: call `extractWithPrompt(url, prompt, reasoningModelId)` for each URL
- `scrape` tool: call `extractPageContent(url)`, return `content` as the result
- `deepResearch` tool: remove `firecrawlApiKey` from params

### `app/api/research/route.ts`

- Remove `FIRECRAWL_API_KEY` validation and env lookup
- Remove `firecrawlApiKey` from the params object

### Documentation and config

- `CLAUDE.md`: Remove `FIRECRAWL_API_KEY` from Required env vars, update Project Overview and AI Flow
- `.env.example`: Remove `FIRECRAWL_API_KEY` line
- `docs/research-api.md`: Remove `FIRECRAWL_API_KEY` from setup, update error table
- `package.json`: Add `@mozilla/readability` and `linkedom`, remove `@mendable/firecrawl-js`

## 3. New Dependencies

- `@mozilla/readability` — article content extraction (Firefox Reader View algorithm)
- `linkedom` — lightweight server-side DOM implementation (needed by Readability)

Removed:
- `@mendable/firecrawl-js` — no longer needed

## 4. Environment Variables

Removed:
- `FIRECRAWL_API_KEY` — no longer needed for any functionality

Unchanged:
- `SERPER_API_KEY` — still required for web search
- `OPENAI_API_KEY` / `OPENROUTER_API_KEY` — extract uses `customModel(modelId, true)` which routes through the existing provider priority (OpenRouter → TogetherAI → OpenAI)

## 5. What Does NOT Change

- Search — already handled by Serper (issue #3)
- Streaming event types, API response shapes, UI behavior — identical
- The `search` tool in the chat route — untouched

## 6. File Summary

| File | Change |
|------|--------|
| `lib/extract.ts` | **New** — `extractPageContent()` and `extractWithPrompt()` |
| `lib/ai/deep-research.ts` | **Modified** — remove Firecrawl, use `extractWithPrompt` |
| `app/(chat)/api/chat/route.ts` | **Modified** — remove Firecrawl, use new extract functions |
| `app/api/research/route.ts` | **Modified** — remove `firecrawlApiKey` |
| `package.json` | **Modified** — add readability/linkedom, remove firecrawl-js |
| `CLAUDE.md` | **Modified** — remove `FIRECRAWL_API_KEY` |
| `.env.example` | **Modified** — remove `FIRECRAWL_API_KEY` |
| `docs/research-api.md` | **Modified** — remove `FIRECRAWL_API_KEY` |
