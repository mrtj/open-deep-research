import type { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';
import { runDeepResearch, type DeepResearchResult } from '@/lib/ai/deep-research';

const DEFAULT_REASONING_MODEL_ID = process.env.REASONING_MODEL || 'o1-mini';

function validateAuth(request: NextRequest): 'ok' | 'no-key' | 'bad-token' {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return 'no-key';

  const authHeader = request.headers.get('authorization');
  if (!authHeader) return 'bad-token';

  const spaceIndex = authHeader.indexOf(' ');
  if (spaceIndex === -1) return 'bad-token';

  const scheme = authHeader.slice(0, spaceIndex);
  const token = authHeader.slice(spaceIndex + 1);

  if (scheme.toLowerCase() !== 'bearer') return 'bad-token';

  // HMAC both values to get fixed-length digests, avoiding length leaks
  const hmacKey = 'open-deep-research-auth';
  const tokenDigest = createHmac('sha256', hmacKey).update(token).digest();
  const apiKeyDigest = createHmac('sha256', hmacKey).update(apiKey).digest();
  const match = tokenDigest.every((b, i) => b === apiKeyDigest[i]);
  return match ? 'ok' : 'bad-token';
}

export async function POST(request: NextRequest) {
  const authResult = validateAuth(request);
  if (authResult === 'no-key') {
    return Response.json(
      { error: 'API_KEY environment variable not configured on server' },
      { status: 500 },
    );
  }
  if (authResult === 'bad-token') {
    return Response.json(
      { error: 'Missing or invalid Authorization header. Expected: Bearer <API_KEY>' },
      { status: 401 },
    );
  }

  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlApiKey) {
    return Response.json({ error: 'FIRECRAWL_API_KEY not configured on server' }, { status: 500 });
  }

  let body: { topic?: string; maxDepth?: number; reasoningModelId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { topic, maxDepth, reasoningModelId } = body;

  if (!topic || typeof topic !== 'string') {
    return Response.json({ error: 'Missing required field: topic' }, { status: 400 });
  }

  if (maxDepth !== undefined && (typeof maxDepth !== 'number' || maxDepth < 1 || maxDepth > 20)) {
    return Response.json({ error: 'maxDepth must be a number between 1 and 20' }, { status: 400 });
  }

  const params = {
    topic,
    maxDepth: maxDepth ?? 7,
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
      const generator = runDeepResearch(params);
      try {
        while (true) {
          const { value, done } = await generator.next();

          if (done) {
            const result = value as DeepResearchResult;
            const finalLine = JSON.stringify({
              type: 'result',
              findings: result.findings,
              analysis: result.analysis,
              metadata: {
                maxDepth: params.maxDepth,
                durationMs: Date.now() - startTime,
                steps: result.completedSteps,
              },
            });
            controller.enqueue(encoder.encode(`${finalLine}\n`));
            controller.close();
            return;
          }

          // On error event, drain generator for partial results and close
          if (value.type === 'error') {
            const next = await generator.next();
            const partial = next.done
              ? (next.value as DeepResearchResult)
              : undefined;
            const errorLine = JSON.stringify({
              type: 'error',
              message: value.message,
              findings: partial?.findings ?? [],
              metadata: {
                maxDepth: params.maxDepth,
                durationMs: Date.now() - startTime,
                steps: partial?.completedSteps ?? 0,
              },
            });
            controller.enqueue(encoder.encode(`${errorLine}\n`));
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        }
      } catch (error: any) {
        await generator.return(undefined as any);
        const errorLine = JSON.stringify({
          type: 'error',
          message: error?.message ?? 'Unknown error',
        });
        controller.enqueue(encoder.encode(`${errorLine}\n`));
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
  const generator = runDeepResearch(params);

  try {
    while (true) {
      const { value, done } = await generator.next();

      if (done) {
        const result = value as DeepResearchResult;
        return Response.json({
          findings: result.findings,
          analysis: result.analysis,
          sources,
          metadata: {
            maxDepth: params.maxDepth,
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
    await generator.return(undefined as any);
    return Response.json(
      { error: error?.message ?? 'Unknown error' },
      { status: 500 },
    );
  }
}
