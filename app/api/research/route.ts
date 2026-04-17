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

      if (value.type === 'source') {
        sources.push({ title: value.title, url: value.url });
      }
    }
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
