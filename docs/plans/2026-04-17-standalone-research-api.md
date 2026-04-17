# Standalone Research API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/research` endpoint for programmatic deep research access, with bearer token auth and streaming/non-streaming response modes.

**Architecture:** Extract the deep research loop from the chat route into `lib/ai/deep-research.ts` as an async generator that yields progress events and returns the final result. The chat route and the new API route both consume this generator. The new route handles auth via `API_KEY` env var and supports NDJSON streaming or buffered JSON responses.

**Tech Stack:** Next.js App Router, Vercel AI SDK (`generateText`), Firecrawl SDK, Zod, TypeScript

**Spec:** `docs/specs/2026-04-17-standalone-research-api-design.md`

---

### File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/ai/deep-research.ts` | Create | Async generator: `runDeepResearch()` + types |
| `app/api/research/route.ts` | Create | Standalone API route with bearer auth, streaming/non-streaming |
| `app/(chat)/api/chat/route.ts` | Modify | Replace inline deep research with import of `runDeepResearch()` |

---

### Task 1: Extract deep research into shared module

**Files:**
- Create: `lib/ai/deep-research.ts`

- [ ] **Step 1: Create `lib/ai/deep-research.ts` with types and the async generator**

```typescript
import FirecrawlApp from '@mendable/firecrawl-js';
import { generateText } from 'ai';
import { customModel } from '@/lib/ai';

// --- Types ---

export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;
  modelId: string;
  reasoningModelId: string;
  firecrawlApiKey: string;
}

export type DeepResearchEvent =
  | {
      type: 'progress-init';
      maxDepth: number;
      totalSteps: number;
    }
  | {
      type: 'activity';
      activityType: 'search' | 'extract' | 'analyze' | 'reasoning' | 'synthesis' | 'thought';
      status: 'pending' | 'complete' | 'error';
      message: string;
      timestamp: string;
      depth: number;
      completedSteps: number;
      totalSteps: number;
    }
  | {
      type: 'source';
      url: string;
      title: string;
      description: string;
    }
  | {
      type: 'depth';
      current: number;
      max: number;
      completedSteps: number;
      totalSteps: number;
    }
  | {
      type: 'error';
      message: string;
    };

export interface DeepResearchResult {
  findings: Array<{ text: string; source: string }>;
  analysis: string;
  completedSteps: number;
  totalSteps: number;
}

// --- Generator ---

export async function* runDeepResearch(
  params: DeepResearchParams,
): AsyncGenerator<DeepResearchEvent, DeepResearchResult> {
  const { topic: originalTopic, maxDepth = 7, modelId, reasoningModelId, firecrawlApiKey } = params;

  const app = new FirecrawlApp({ apiKey: firecrawlApiKey });
  let topic = originalTopic;

  const startTime = Date.now();
  const timeLimit = 4.5 * 60 * 1000;

  const researchState = {
    findings: [] as Array<{ text: string; source: string }>,
    summaries: [] as Array<string>,
    nextSearchTopic: '',
    urlToSearch: '',
    currentDepth: 0,
    failedAttempts: 0,
    maxFailedAttempts: 3,
    completedSteps: 0,
    totalExpectedSteps: maxDepth * 5,
  };

  yield {
    type: 'progress-init',
    maxDepth,
    totalSteps: researchState.totalExpectedSteps,
  };

  // Helper: yield an activity event, incrementing completedSteps on 'complete'
  function makeActivity(
    activityType: DeepResearchEvent & { type: 'activity' } extends infer T ? T extends { activityType: infer A } ? A : never : never,
    status: 'pending' | 'complete' | 'error',
    message: string,
  ): DeepResearchEvent & { type: 'activity' } {
    if (status === 'complete') {
      researchState.completedSteps++;
    }
    return {
      type: 'activity',
      activityType,
      status,
      message,
      timestamp: new Date().toISOString(),
      depth: researchState.currentDepth,
      completedSteps: researchState.completedSteps,
      totalSteps: researchState.totalExpectedSteps,
    };
  }

  const analyzeAndPlan = async (
    findings: Array<{ text: string; source: string }>,
  ) => {
    try {
      const timeElapsed = Date.now() - startTime;
      const timeRemaining = timeLimit - timeElapsed;
      const timeRemainingMinutes = Math.round((timeRemaining / 1000 / 60) * 10) / 10;

      const result = await generateText({
        model: customModel(reasoningModelId, true),
        prompt: `You are a research agent analyzing findings about: ${originalTopic}
                You have ${timeRemainingMinutes} minutes remaining to complete the research but you don't need to use all of it.
                Current findings: ${findings
            .map((f) => `[From ${f.source}]: ${f.text}`)
            .join('\n')}
                What has been learned? What gaps remain? What specific aspects should be investigated next if any?
                If you need to search for more information, include a nextSearchTopic.
                If you need to search for more information in a specific URL, include a urlToSearch.
                Important: If less than 1 minute remains, set shouldContinue to false to allow time for final synthesis.
                If I have enough information, set shouldContinue to false.
                
                Respond in this exact JSON format:
                {
                  "analysis": {
                    "summary": "summary of findings",
                    "gaps": ["gap1", "gap2"],
                    "nextSteps": ["step1", "step2"],
                    "shouldContinue": true/false,
                    "nextSearchTopic": "optional topic",
                    "urlToSearch": "optional url"
                  }
                }`,
      });

      try {
        const parsed = JSON.parse(result.text);
        return parsed.analysis;
      } catch (error) {
        console.error('Failed to parse JSON response:', error);
        return null;
      }
    } catch (error) {
      console.error('Analysis error:', error);
      return null;
    }
  };

  const extractFromUrls = async (urls: string[]): Promise<Array<{ text: string; source: string }>> => {
    const extractPromises = urls.map(async (url) => {
      try {
        const result = await app.extract([url], {
          prompt: `Extract key information about ${originalTopic}. Focus on facts, data, and expert opinions. Analysis should be full of details and very comprehensive.`,
        });

        if (result.success) {
          if (Array.isArray(result.data)) {
            return result.data.map((item: any) => ({
              text: item.data,
              source: url,
            }));
          }
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

  try {
    while (researchState.currentDepth < maxDepth) {
      const timeElapsed = Date.now() - startTime;
      if (timeElapsed >= timeLimit) {
        break;
      }

      researchState.currentDepth++;

      yield {
        type: 'depth',
        current: researchState.currentDepth,
        max: maxDepth,
        completedSteps: researchState.completedSteps,
        totalSteps: researchState.totalExpectedSteps,
      };

      // Search phase
      yield makeActivity('search', 'pending', `Searching for "${topic}"`);

      const searchTopic = researchState.nextSearchTopic || topic;
      const searchResult = await app.search(searchTopic);

      if (!searchResult.success) {
        yield makeActivity('search', 'error', `Search failed for "${searchTopic}"`);
        researchState.failedAttempts++;
        if (researchState.failedAttempts >= researchState.maxFailedAttempts) {
          break;
        }
        continue;
      }

      yield makeActivity('search', 'complete', `Found ${searchResult.data.length} relevant results`);

      // Yield sources
      for (const result of searchResult.data as any[]) {
        yield {
          type: 'source',
          url: result.url,
          title: result.title,
          description: result.description,
        };
      }

      // Extract phase
      const topUrls = (searchResult.data as any[]).slice(0, 3).map((r: any) => r.url);
      const urlsToExtract = [researchState.urlToSearch, ...topUrls].filter(Boolean);

      yield makeActivity('extract', 'pending', `Extracting from ${urlsToExtract.length} URLs`);
      const newFindings = await extractFromUrls(urlsToExtract);
      researchState.findings.push(...newFindings);
      yield makeActivity('extract', 'complete', `Extracted ${newFindings.length} findings`);

      // Analysis phase
      yield makeActivity('analyze', 'pending', 'Analyzing findings');

      const analysis = await analyzeAndPlan(researchState.findings);
      researchState.nextSearchTopic = analysis?.nextSearchTopic || '';
      researchState.urlToSearch = analysis?.urlToSearch || '';
      researchState.summaries.push(analysis?.summary || '');

      if (!analysis) {
        yield makeActivity('analyze', 'error', 'Failed to analyze findings');
        researchState.failedAttempts++;
        if (researchState.failedAttempts >= researchState.maxFailedAttempts) {
          break;
        }
        continue;
      }

      yield makeActivity('analyze', 'complete', analysis.summary);

      if (!analysis.shouldContinue || analysis.gaps.length === 0) {
        break;
      }

      topic = analysis.gaps.shift() || topic;
    }

    // Final synthesis
    yield makeActivity('synthesis', 'pending', 'Preparing final analysis');

    const finalAnalysis = await generateText({
      model: customModel(reasoningModelId, true),
      maxTokens: 16000,
      prompt: `Create a comprehensive long analysis of ${originalTopic} based on these findings:
              ${researchState.findings
          .map((f) => `[From ${f.source}]: ${f.text}`)
          .join('\n')}
              ${researchState.summaries
                .map((s) => `[Summary]: ${s}`)
                .join('\n')}
              Provide all the thoughts processes including findings details,key insights, conclusions, and any remaining uncertainties. Include citations to sources where appropriate. This analysis should be very comprehensive and full of details. It is expected to be very long, detailed and comprehensive.`,
    });

    yield makeActivity('synthesis', 'complete', 'Research completed');

    return {
      findings: researchState.findings,
      analysis: finalAnalysis.text,
      completedSteps: researchState.completedSteps,
      totalSteps: researchState.totalExpectedSteps,
    };
  } catch (error: any) {
    console.error('Deep research error:', error);

    yield {
      type: 'error',
      message: error.message,
    };

    return {
      findings: researchState.findings,
      analysis: '',
      completedSteps: researchState.completedSteps,
      totalSteps: researchState.totalExpectedSteps,
    };
  }
}
```

**IMPORTANT NOTE on the extract helper:** The original code yields per-URL extract activity events from inside `Promise.all`. An async generator cannot `yield` from within a callback passed to `Promise.all`. The plan restructures extract to yield a single pending/complete pair around the batch, matching the same information but in a generator-compatible way.

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit lib/ai/deep-research.ts 2>&1 | head -20`

Fix any type errors. The likely issues:
- Firecrawl `search()` return types — may need `as any` casts matching the existing code
- The `makeActivity` helper's type extraction is complex — simplify to a plain union literal type if TS complains

- [ ] **Step 3: Commit**

```bash
git add lib/ai/deep-research.ts
git commit -m "Extract deep research logic into shared module

Moves the research loop, state management, and synthesis from the chat
route into lib/ai/deep-research.ts as an async generator. This enables
reuse from both the chat route and the upcoming standalone API endpoint."
```

---

### Task 2: Rewire chat route to use extracted module

**Files:**
- Modify: `app/(chat)/api/chat/route.ts:312-668`

- [ ] **Step 1: Replace the inline `deepResearch` tool with one that consumes `runDeepResearch`**

In `app/(chat)/api/chat/route.ts`, replace the entire `deepResearch` tool execute function (lines 312-668) with:

```typescript
// At the top of the file, add import:
import { runDeepResearch } from '@/lib/ai/deep-research';

// Replace the deepResearch tool's execute function:
deepResearch: {
  description:
    'Perform deep research on a topic using an AI agent that coordinates search, extract, and analysis tools with reasoning steps.',
  parameters: z.object({
    topic: z.string().describe('The topic or question to research'),
  }),
  execute: async ({ topic, maxDepth = 7 }) => {
    const generator = runDeepResearch({
      topic,
      maxDepth,
      modelId: model.apiIdentifier,
      reasoningModelId: reasoningModel.apiIdentifier,
      firecrawlApiKey: process.env.FIRECRAWL_API_KEY || '',
    });

    // Consume generator, translating events to dataStream writes
    while (true) {
      const { value, done } = await generator.next();

      if (done) {
        // `value` is the DeepResearchResult
        const result = value;

        dataStream.writeData({
          type: 'finish',
          content: result.analysis,
        });

        return {
          success: true,
          data: {
            findings: result.findings,
            analysis: result.analysis,
            completedSteps: result.completedSteps,
            totalSteps: result.totalSteps,
          },
        };
      }

      // value is a DeepResearchEvent — translate to dataStream format
      const event = value;
      switch (event.type) {
        case 'progress-init':
          dataStream.writeData({
            type: 'progress-init',
            content: { maxDepth: event.maxDepth, totalSteps: event.totalSteps },
          });
          break;
        case 'activity':
          dataStream.writeData({
            type: 'activity-delta',
            content: {
              type: event.activityType,
              status: event.status,
              message: event.message,
              timestamp: event.timestamp,
              depth: event.depth,
              completedSteps: event.completedSteps,
              totalSteps: event.totalSteps,
            },
          });
          break;
        case 'source':
          dataStream.writeData({
            type: 'source-delta',
            content: { url: event.url, title: event.title, description: event.description },
          });
          break;
        case 'depth':
          dataStream.writeData({
            type: 'depth-delta',
            content: {
              current: event.current,
              max: event.max,
              completedSteps: event.completedSteps,
              totalSteps: event.totalSteps,
            },
          });
          break;
        case 'error':
          // Let it fall through to return
          return {
            success: false,
            error: event.message,
            data: { findings: [], completedSteps: 0, totalSteps: 0 },
          };
      }
    }
  },
},
```

Also remove the now-unused `FirecrawlApp` instantiation at line 52-54 (the `const app = new FirecrawlApp(...)`) since the extracted module creates its own instance.

- [ ] **Step 2: Verify the app builds**

Run: `pnpm build 2>&1 | tail -20`

Fix any build errors.

- [ ] **Step 3: Commit**

```bash
git add app/(chat)/api/chat/route.ts
git commit -m "Rewire chat route to use extracted deep research module

The deepResearch tool now imports runDeepResearch() from lib/ai/deep-research.ts
and translates generator events to dataStream writes. No behavior change for the
existing chat UI — same events, same format."
```

---

### Task 3: Create standalone API route

**Files:**
- Create: `app/api/research/route.ts`

- [ ] **Step 1: Create `app/api/research/route.ts`**

```typescript
import { NextRequest } from 'next/server';
import { runDeepResearch, type DeepResearchEvent, type DeepResearchResult } from '@/lib/ai/deep-research';

const DEFAULT_MODEL_ID = 'gpt-4o';
const DEFAULT_REASONING_MODEL_ID = process.env.REASONING_MODEL || 'o1-mini';

function unauthorized() {
  return Response.json({ error: 'Missing or invalid Authorization header. Expected: Bearer <API_KEY>' }, { status: 401 });
}

function validateAuth(request: NextRequest): boolean {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return false;

  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;

  const [scheme, token] = authHeader.split(' ');
  return scheme === 'Bearer' && token === apiKey;
}

export async function POST(request: NextRequest) {
  if (!validateAuth(request)) {
    return unauthorized();
  }

  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlApiKey) {
    return Response.json({ error: 'FIRECRAWL_API_KEY not configured on server' }, { status: 500 });
  }

  let body: { topic?: string; maxDepth?: number; modelId?: string; reasoningModelId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { topic, maxDepth, modelId, reasoningModelId } = body;

  if (!topic || typeof topic !== 'string') {
    return Response.json({ error: 'Missing required field: topic' }, { status: 400 });
  }

  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || maxDepth < 1 || maxDepth > 20)) {
    return Response.json({ error: 'maxDepth must be a number between 1 and 20' }, { status: 400 });
  }

  const params = {
    topic,
    maxDepth: maxDepth ?? 7,
    modelId: modelId ?? DEFAULT_MODEL_ID,
    reasoningModelId: reasoningModelId ?? DEFAULT_REASONING_MODEL_ID,
    firecrawlApiKey,
  };

  const streamParam = request.nextUrl.searchParams.get('stream');
  const shouldStream = streamParam !== 'false';

  if (shouldStream) {
    return streamingResponse(params);
  }
  return bufferedResponse(params);
}

function streamingResponse(params: Parameters<typeof runDeepResearch>[0]) {
  const encoder = new TextEncoder();
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const generator = runDeepResearch(params);

        while (true) {
          const { value, done } = await generator.next();

          if (done) {
            const result = value as DeepResearchResult;
            const finalLine = JSON.stringify({
              type: 'result',
              findings: result.findings,
              analysis: result.analysis,
              metadata: {
                depth: params.maxDepth,
                durationMs: Date.now() - startTime,
                steps: result.completedSteps,
              },
            });
            controller.enqueue(encoder.encode(finalLine + '\n'));
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'));
        }
      } catch (error: any) {
        const errorLine = JSON.stringify({ type: 'error', message: error.message });
        controller.enqueue(encoder.encode(errorLine + '\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/x-ndjson',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

async function bufferedResponse(params: Parameters<typeof runDeepResearch>[0]) {
  const startTime = Date.now();
  const sources: Array<{ title: string; url: string }> = [];

  try {
    const generator = runDeepResearch(params);

    while (true) {
      const { value, done } = await generator.next();

      if (done) {
        const result = value as DeepResearchResult;
        return Response.json({
          findings: result.findings,
          analysis: result.analysis,
          sources,
          metadata: {
            depth: params.maxDepth,
            durationMs: Date.now() - startTime,
            steps: result.completedSteps,
          },
        });
      }

      // Collect sources for the final response
      if (value.type === 'source') {
        sources.push({ title: value.title, url: value.url });
      }
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
```


- [ ] **Step 2: Verify the app builds**

Run: `pnpm build 2>&1 | tail -20`

Fix any build errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/research/route.ts
git commit -m "Add standalone POST /api/research endpoint

Bearer token auth via API_KEY env var. Supports streaming (NDJSON,
default) and non-streaming (?stream=false) response modes. Free-form
model IDs for eval benchmarking.

Closes #1"
```

---

### Task 4: Update CLAUDE.md and verify end-to-end

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add API endpoint docs to CLAUDE.md**

Append to the Environment Variables section:

```markdown
- `API_KEY` — bearer token for the `/api/research` endpoint
```

Add a new section after Environment Variables:

```markdown
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
```

- [ ] **Step 2: Manual smoke test**

Start the dev server and test both modes:

```bash
# Terminal 1: start dev server
API_KEY=test-key FIRECRAWL_API_KEY=<key> pnpm dev

# Terminal 2: test non-streaming
curl -s -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{"topic": "test", "maxDepth": 1}' \
  'http://localhost:3000/api/research?stream=false' | head -c 500

# Terminal 3: test streaming
curl -N -H "Authorization: Bearer test-key" \
  -H "Content-Type: application/json" \
  -d '{"topic": "test", "maxDepth": 1}' \
  http://localhost:3000/api/research | head -20

# Test auth rejection
curl -s http://localhost:3000/api/research -X POST \
  -H "Content-Type: application/json" \
  -d '{"topic": "test"}'
# Expected: {"error":"Missing or invalid Authorization header..."}
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document standalone research API in CLAUDE.md"
```
