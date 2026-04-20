# Serper Search Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all Firecrawl `app.search()` calls with Serper API calls, keeping Firecrawl for extract/scrape only.

**Architecture:** Create a `serperSearch()` function in `lib/search.ts` that POSTs to `https://google.serper.dev/search` and returns results in the same `{ success, data: [{ url, title, description }] }` shape both call sites expect. Swap both call sites (deep-research.ts, chat route) to use it. Add `serperApiKey` to `DeepResearchParams`.

**Tech Stack:** TypeScript, native `fetch`, Serper REST API (`POST https://google.serper.dev/search`, `X-API-KEY` header)

---

### Task 1: Create `lib/search.ts`

**Files:**
- Create: `lib/search.ts`

- [ ] **Step 1: Create the serperSearch function**

```typescript
export interface SearchResult {
  url: string;
  title: string;
  description: string;
}

export interface SearchResponse {
  success: boolean;
  data: SearchResult[];
  error?: string;
}

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperResponse {
  organic: SerperOrganicResult[];
}

export async function serperSearch(
  query: string,
  apiKey: string,
  maxResults: number = 10,
): Promise<SearchResponse> {
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: maxResults }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        data: [],
        error: `Serper API error ${response.status}: ${text}`,
      };
    }

    const json: SerperResponse = await response.json();

    const data: SearchResult[] = (json.organic || []).map((r) => ({
      url: r.link,
      title: r.title,
      description: r.snippet,
    }));

    return { success: true, data };
  } catch (error: any) {
    return {
      success: false,
      data: [],
      error: `Serper search failed: ${error.message}`,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/search.ts
git commit -m "feat: add serperSearch function for Serper API integration"
```

---

### Task 2: Wire Serper into `lib/ai/deep-research.ts`

**Files:**
- Modify: `lib/ai/deep-research.ts:1-10` (imports and params)
- Modify: `lib/ai/deep-research.ts:206` (search call)

- [ ] **Step 1: Add serperApiKey to DeepResearchParams and import serperSearch**

At the top of the file, add the import:

```typescript
import { serperSearch } from '@/lib/search';
```

Add `serperApiKey` to `DeepResearchParams`:

```typescript
export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;
  reasoningModelId: string;
  firecrawlApiKey: string;
  serperApiKey: string;
}
```

- [ ] **Step 2: Destructure serperApiKey in the generator**

In `runDeepResearch`, add `serperApiKey` to the destructured params (around line 54):

```typescript
const {
  topic: initialTopic,
  maxDepth = 7,
  reasoningModelId,
  firecrawlApiKey,
  serperApiKey,
} = params;
```

- [ ] **Step 3: Replace app.search() with serperSearch()**

Replace line 206:

```typescript
// Before:
const searchResult = await app.search(searchTopic);
// After:
const searchResult = await serperSearch(searchTopic, serperApiKey);
```

The rest of the code already reads `searchResult.success`, `searchResult.data[].url`, `.title`, `.description` — which matches the `SearchResponse` type exactly. No other changes needed.

- [ ] **Step 4: Commit**

```bash
git add lib/ai/deep-research.ts
git commit -m "feat: replace Firecrawl search with Serper in deep research generator"
```

---

### Task 3: Wire Serper into `app/(chat)/api/chat/route.ts`

**Files:**
- Modify: `app/(chat)/api/chat/route.ts:30` (imports)
- Modify: `app/(chat)/api/chat/route.ts:195-227` (search tool execute)

- [ ] **Step 1: Add serperSearch import**

Add at the top of the file alongside existing imports:

```typescript
import { serperSearch } from '@/lib/search';
```

- [ ] **Step 2: Replace app.search() in the search tool**

Replace the execute function of the `search` tool (lines 195-228). The current code:

```typescript
execute: async ({ query, maxResults = 5 }) => {
  try {
    const searchResult = await app.search(query);
    if (!searchResult.success) {
      return { error: `Search failed: ${searchResult.error}`, success: false };
    }
    const resultsWithFavicons = searchResult.data.map((result: any) => {
      const url = new URL(result.url);
      const favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
      return { ...result, favicon };
    });
    searchResult.data = resultsWithFavicons;
    return { data: searchResult.data, success: true };
  } catch (error: any) {
    return { error: `Search failed: ${error.message}`, success: false };
  }
},
```

Replace with:

```typescript
execute: async ({ query, maxResults = 5 }) => {
  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey) {
    return { error: 'SERPER_API_KEY not configured', success: false };
  }
  try {
    const searchResult = await serperSearch(query, serperApiKey, maxResults);
    if (!searchResult.success) {
      return { error: `Search failed: ${searchResult.error}`, success: false };
    }
    const resultsWithFavicons = searchResult.data.map((result) => {
      const url = new URL(result.url);
      const favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`;
      return { ...result, favicon };
    });
    return { data: resultsWithFavicons, success: true };
  } catch (error: any) {
    return { error: `Search failed: ${error.message}`, success: false };
  }
},
```

- [ ] **Step 3: Commit**

```bash
git add app/\(chat\)/api/chat/route.ts
git commit -m "feat: replace Firecrawl search with Serper in chat route search tool"
```

---

### Task 4: Wire Serper into `app/api/research/route.ts` and update docs

**Files:**
- Modify: `app/api/research/route.ts:45-72` (env validation and params)
- Modify: `CLAUDE.md`
- Modify: `docs/research-api.md`

- [ ] **Step 1: Add SERPER_API_KEY validation and pass it through**

In `app/api/research/route.ts`, after the `firecrawlApiKey` check (line 48), add:

```typescript
const serperApiKey = process.env.SERPER_API_KEY;
if (!serperApiKey) {
  return Response.json({ error: 'SERPER_API_KEY not configured on server' }, { status: 500 });
}
```

In the `params` object (around line 67), add `serperApiKey`:

```typescript
const params = {
  topic,
  maxDepth: maxDepth ?? 7,
  reasoningModelId: reasoningModelId ?? DEFAULT_REASONING_MODEL_ID,
  firecrawlApiKey,
  serperApiKey,
};
```

- [ ] **Step 2: Update CLAUDE.md**

In the Environment Variables section, add `SERPER_API_KEY` to the Required list:

```
**Required:** `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `SERPER_API_KEY`, `AUTH_SECRET`, `POSTGRES_URL`
```

In the Standalone Research API section's curl examples, no changes needed (they don't show env vars).

- [ ] **Step 3: Update docs/research-api.md**

In the Setup section's environment variables block, add:

```bash
SERPER_API_KEY=...               # Serper API key for web search
```

And update the `FIRECRAWL_API_KEY` comment:

```bash
FIRECRAWL_API_KEY=fc-...         # Firecrawl API key for page extraction
```

- [ ] **Step 4: Commit**

```bash
git add app/api/research/route.ts CLAUDE.md docs/research-api.md
git commit -m "feat: validate SERPER_API_KEY in research route, update docs"
```

---

### Task 5: Pass serperApiKey from chat route to deep research

**Files:**
- Modify: `app/(chat)/api/chat/route.ts:315` (deep research params)

- [ ] **Step 1: Add serperApiKey to the runDeepResearch call**

In the chat route, find the `runDeepResearch` call (around line 315) and add `serperApiKey`:

```typescript
const generator = runDeepResearch({
  topic: args.topic,
  maxDepth: args.maxDepth,
  reasoningModelId,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
  serperApiKey: process.env.SERPER_API_KEY || '',
});
```

- [ ] **Step 2: Commit**

```bash
git add app/\(chat\)/api/chat/route.ts
git commit -m "feat: pass serperApiKey to deep research from chat route"
```
