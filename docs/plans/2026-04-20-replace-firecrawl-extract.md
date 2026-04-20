# Replace Firecrawl Extract/Scrape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Firecrawl dependency entirely by replacing `app.extract()` and `app.scrapeUrl()` with Mozilla Readability + our own reasoning model.

**Architecture:** Create `lib/extract.ts` with `extractPageContent()` (fetch + Readability for clean text) and `extractWithPrompt()` (clean text + LLM). Replace all three Firecrawl extract/scrape call sites. Remove `@mendable/firecrawl-js` and `FIRECRAWL_API_KEY`.

**Tech Stack:** `@mozilla/readability`, `linkedom`, Vercel AI SDK `generateText`, existing `customModel()` provider routing

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add new dependencies and remove Firecrawl**

```bash
pnpm add @mozilla/readability linkedom
pnpm remove @mendable/firecrawl-js
```

- [ ] **Step 2: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add readability and linkedom, remove firecrawl-js"
```

---

### Task 2: Create `lib/extract.ts`

**Files:**
- Create: `lib/extract.ts`

- [ ] **Step 1: Create the extraction module**

```typescript
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { generateText } from 'ai';
import { customModel } from '@/lib/ai';

const FETCH_TIMEOUT_MS = 15_000;

export interface ExtractResult {
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
}

export interface ExtractWithPromptResult {
  success: boolean;
  data?: string;
  error?: string;
}

export async function extractPageContent(
  url: string,
): Promise<ExtractResult> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; OpenDeepResearch/1.0; +https://github.com/nickscamara/open-deep-research)',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch ${url}: HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    const reader = new Readability(document);
    const article = reader.parse();

    if (article && article.textContent) {
      return {
        success: true,
        content: article.textContent.trim(),
        title: article.title,
      };
    }

    // Fallback: raw body text if Readability can't extract
    const bodyText = document.body?.textContent?.trim();
    if (bodyText) {
      return {
        success: true,
        content: bodyText,
        title: document.title || undefined,
      };
    }

    return {
      success: false,
      error: `Could not extract content from ${url}`,
    };
  } catch (error: any) {
    const message =
      error?.name === 'TimeoutError'
        ? `Fetch timed out after ${FETCH_TIMEOUT_MS}ms for ${url}`
        : `Extraction failed for ${url}: ${error.message}`;
    return { success: false, error: message };
  }
}

export async function extractWithPrompt(
  url: string,
  prompt: string,
  modelId: string,
): Promise<ExtractWithPromptResult> {
  const page = await extractPageContent(url);
  if (!page.success || !page.content) {
    return { success: false, error: page.error || 'No content extracted' };
  }

  try {
    const result = await generateText({
      model: customModel(modelId, true),
      prompt: `${prompt}\n\nPage content from ${url}:\n\n${page.content}`,
    });

    return { success: true, data: result.text };
  } catch (error: any) {
    return {
      success: false,
      error: `LLM extraction failed: ${error.message}`,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/extract.ts
git commit -m "feat: add extractPageContent and extractWithPrompt using Readability"
```

---

### Task 3: Wire extract into `lib/ai/deep-research.ts`

**Files:**
- Modify: `lib/ai/deep-research.ts:1-12` (imports and params)
- Modify: `lib/ai/deep-research.ts:55-63` (destructure and FirecrawlApp)
- Modify: `lib/ai/deep-research.ts:155-179` (extractFromUrls)

- [ ] **Step 1: Replace imports**

Remove:
```typescript
import FirecrawlApp from '@mendable/firecrawl-js';
```

Add:
```typescript
import { extractWithPrompt } from '@/lib/extract';
```

- [ ] **Step 2: Remove firecrawlApiKey from DeepResearchParams**

Change the interface from:
```typescript
export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;
  reasoningModelId: string;
  firecrawlApiKey: string;
  serperApiKey: string;
}
```

To:
```typescript
export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;
  reasoningModelId: string;
  serperApiKey: string;
}
```

- [ ] **Step 3: Remove FirecrawlApp instance from the generator**

In the destructure block (around line 53), remove `firecrawlApiKey`:

```typescript
const {
  topic: initialTopic,
  maxDepth = 7,
  reasoningModelId,
  serperApiKey,
} = params;
```

Remove the line:
```typescript
const app = new FirecrawlApp({ apiKey: firecrawlApiKey });
```

- [ ] **Step 4: Rewrite extractFromUrls**

Replace the entire `extractFromUrls` function (lines 155-179) with:

```typescript
const extractFromUrls = async (urls: string[]) => {
  const extractPromises = urls.map(async (url) => {
    try {
      const result = await extractWithPrompt(
        url,
        `Extract key information about ${originalTopic}. Focus on facts, data, and expert opinions. Analysis should be full of details and very comprehensive.`,
        reasoningModelId,
      );

      if (result.success && result.data) {
        return [{ text: result.data, source: url }];
      }
      return [];
    } catch {
      return [];
    }
  });

  const results = await Promise.all(extractPromises);
  return results.flat();
};
```

- [ ] **Step 5: Commit**

```bash
git add lib/ai/deep-research.ts
git commit -m "feat: replace Firecrawl extract with Readability + LLM in deep research"
```

---

### Task 4: Wire extract into chat route

**Files:**
- Modify: `app/(chat)/api/chat/route.ts:30-47` (imports, tools arrays, FirecrawlApp)
- Modify: `app/(chat)/api/chat/route.ts:217-290` (extract and scrape tools)
- Modify: `app/(chat)/api/chat/route.ts:298-308` (deepResearch tool params)

- [ ] **Step 1: Replace imports and remove FirecrawlApp**

Remove:
```typescript
import FirecrawlApp from '@mendable/firecrawl-js';
```

Add:
```typescript
import { extractPageContent, extractWithPrompt } from '@/lib/extract';
```

Remove the `FirecrawlApp` instance:
```typescript
const app = new FirecrawlApp({
  apiKey: process.env.FIRECRAWL_API_KEY || '',
});
```

Replace the tool arrays:
```typescript
const firecrawlTools: AllowedTools[] = ['search', 'extract', 'scrape'];
const allTools: AllowedTools[] = [...firecrawlTools, 'deepResearch'];
```

With:
```typescript
const standardTools: AllowedTools[] = ['search', 'extract', 'scrape'];
const allTools: AllowedTools[] = [...standardTools, 'deepResearch'];
```

And update the reference at line ~181:
```typescript
experimental_activeTools: experimental_deepResearch ? allTools : standardTools,
```

- [ ] **Step 2: Rewrite the extract tool**

Replace the `extract` tool execute function (lines 229-255) with:

```typescript
execute: async ({ urls, prompt }) => {
  try {
    const results = await Promise.all(
      urls.map((url: string) =>
        extractWithPrompt(url, prompt, reasoningModel.apiIdentifier),
      ),
    );

    const successful = results.filter((r) => r.success);
    if (successful.length === 0) {
      return {
        error: `Failed to extract data: ${results[0]?.error || 'unknown error'}`,
        success: false,
      };
    }

    return {
      data: successful.map((r) => r.data),
      success: true,
    };
  } catch (error: any) {
    console.error('Extraction error:', error);
    return {
      error: `Extraction failed: ${error.message}`,
      success: false,
    };
  }
},
```

- [ ] **Step 3: Rewrite the scrape tool**

Replace the `scrape` tool execute function (lines 263-289) with:

```typescript
execute: async ({ url }: { url: string }) => {
  try {
    const result = await extractPageContent(url);

    if (!result.success) {
      return {
        error: `Failed to scrape page: ${result.error}`,
        success: false,
      };
    }

    return {
      data: result.content ?? 'Could not get the page content, try using search or extract',
      success: true,
    };
  } catch (error: any) {
    console.error('Scrape error:', error);
    return {
      error: `Scrape failed: ${error.message}`,
      success: false,
    };
  }
},
```

- [ ] **Step 4: Remove firecrawlApiKey from deepResearch tool call**

In the `deepResearch` tool execute block, change the `runDeepResearch` params from:

```typescript
const generator = runDeepResearch({
  topic,
  maxDepth,
  reasoningModelId: reasoningModel.apiIdentifier,
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
  serperApiKey,
});
```

To:

```typescript
const generator = runDeepResearch({
  topic,
  maxDepth,
  reasoningModelId: reasoningModel.apiIdentifier,
  serperApiKey,
});
```

- [ ] **Step 5: Commit**

```bash
git add app/\(chat\)/api/chat/route.ts
git commit -m "feat: replace Firecrawl extract/scrape with Readability + LLM in chat route"
```

---

### Task 5: Remove firecrawlApiKey from research route

**Files:**
- Modify: `app/api/research/route.ts:45-77`

- [ ] **Step 1: Remove FIRECRAWL_API_KEY validation and param**

Remove these lines (45-48):
```typescript
const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
if (!firecrawlApiKey) {
  return Response.json({ error: 'FIRECRAWL_API_KEY not configured on server' }, { status: 500 });
}
```

Remove `firecrawlApiKey` from the params object:
```typescript
const params = {
  topic,
  maxDepth: maxDepth ?? 7,
  reasoningModelId: reasoningModelId ?? DEFAULT_REASONING_MODEL_ID,
  serperApiKey,
};
```

- [ ] **Step 2: Commit**

```bash
git add app/api/research/route.ts
git commit -m "feat: remove firecrawlApiKey from research route"
```

---

### Task 6: Update documentation and config

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.env.example`
- Modify: `docs/research-api.md`

- [ ] **Step 1: Update CLAUDE.md**

In Project Overview (line 7), change:
```
Open Deep Research — an open-source AI research chatbot that uses Serper (web search) and Firecrawl (extract/scrape) with reasoning models to perform deep web research.
```
To:
```
Open Deep Research — an open-source AI research chatbot that uses Serper (web search) and Mozilla Readability (content extraction) with reasoning models to perform deep web research.
```

In AI Flow (line 29), change:
```
- AI tools: `search` (Serper API), `extract`, `scrape` (Firecrawl), `deepResearch` (recursive, max 7 levels, 4.5min timeout)
```
To:
```
- AI tools: `search` (Serper API), `extract`, `scrape` (Readability + LLM), `deepResearch` (recursive, max 7 levels, 4.5min timeout)
```

In Environment Variables (line 52), change:
```
**Required:** `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `SERPER_API_KEY`, `AUTH_SECRET`, `POSTGRES_URL`
```
To:
```
**Required:** `OPENAI_API_KEY`, `SERPER_API_KEY`, `AUTH_SECRET`, `POSTGRES_URL`
```

- [ ] **Step 2: Update .env.example**

Remove these lines:
```bash
# Get your Firecrawl API Key here: https://www.firecrawl.dev/
FIRECRAWL_API_KEY=****
```

- [ ] **Step 3: Update docs/research-api.md**

In the setup section, remove:
```bash
FIRECRAWL_API_KEY=fc-...         # Firecrawl API key for page extraction
```

In the error table (line ~163), change:
```
| 500 | `API_KEY`, `FIRECRAWL_API_KEY`, or `SERPER_API_KEY` not configured, provider error |
```
To:
```
| 500 | `API_KEY` or `SERPER_API_KEY` not configured, provider error |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .env.example docs/research-api.md
git commit -m "docs: remove FIRECRAWL_API_KEY references, update to Readability"
```
