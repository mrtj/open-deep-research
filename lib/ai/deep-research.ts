import FirecrawlApp from '@mendable/firecrawl-js';
import { generateText } from 'ai';
import { customModel } from '@/lib/ai';

export interface DeepResearchParams {
  topic: string;
  maxDepth?: number;
  modelId: string;
  reasoningModelId: string;
  firecrawlApiKey: string;
}

export type DeepResearchEvent =
  | { type: 'progress-init'; maxDepth: number; totalSteps: number }
  | {
      type: 'activity';
      activityType:
        | 'search'
        | 'extract'
        | 'analyze'
        | 'reasoning'
        | 'synthesis'
        | 'thought';
      status: 'pending' | 'complete' | 'error';
      message: string;
      timestamp: string;
      depth: number;
      completedSteps: number;
      totalSteps: number;
    }
  | { type: 'source'; url: string; title: string; description: string }
  | {
      type: 'depth';
      current: number;
      max: number;
      completedSteps: number;
      totalSteps: number;
    }
  | { type: 'error'; message: string };

export interface DeepResearchResult {
  findings: Array<{ text: string; source: string }>;
  analysis: string;
  completedSteps: number;
  totalSteps: number;
}

export async function* runDeepResearch(
  params: DeepResearchParams,
): AsyncGenerator<DeepResearchEvent, DeepResearchResult> {
  const {
    topic: initialTopic,
    maxDepth = 7,
    reasoningModelId,
    firecrawlApiKey,
  } = params;

  let topic = initialTopic;
  const originalTopic = initialTopic;

  const app = new FirecrawlApp({ apiKey: firecrawlApiKey });

  const startTime = Date.now();
  const timeLimit = 4.5 * 60 * 1000; // 4 minutes 30 seconds

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

  const makeActivity = (
    activityType:
      | 'search'
      | 'extract'
      | 'analyze'
      | 'reasoning'
      | 'synthesis'
      | 'thought',
    status: 'pending' | 'complete' | 'error',
    message: string,
  ): DeepResearchEvent & { type: 'activity' } => {
    if (status === 'complete') {
      researchState.completedSteps++;
    }

    return {
      type: 'activity' as const,
      activityType,
      status,
      message,
      timestamp: new Date().toISOString(),
      depth: researchState.currentDepth,
      completedSteps: researchState.completedSteps,
      totalSteps: researchState.totalExpectedSteps,
    };
  };

  const analyzeAndPlan = async (
    findings: Array<{ text: string; source: string }>,
  ) => {
    try {
      const timeElapsed = Date.now() - startTime;
      const timeRemaining = timeLimit - timeElapsed;
      const timeRemainingMinutes =
        Math.round((timeRemaining / 1000 / 60) * 10) / 10;

      const result = await generateText({
        model: customModel(reasoningModelId, true),
        prompt: `You are a research agent analyzing findings about: ${topic}
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

  const extractFromUrls = async (urls: string[]) => {
    const extractPromises = urls.map(async (url) => {
      try {
        const result = await (app as any).extract([url], {
          prompt: `Extract key information about ${topic}. Focus on facts, data, and expert opinions. Analysis should be full of details and very comprehensive.`,
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

  // Initialize progress tracking
  yield {
    type: 'progress-init',
    maxDepth,
    totalSteps: researchState.totalExpectedSteps,
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

      if (!(searchResult as any).success) {
        yield makeActivity(
          'search',
          'error',
          `Search failed for "${searchTopic}"`,
        );

        researchState.failedAttempts++;
        if (
          researchState.failedAttempts >= researchState.maxFailedAttempts
        ) {
          break;
        }
        continue;
      }

      yield makeActivity(
        'search',
        'complete',
        `Found ${(searchResult as any).data.length} relevant results`,
      );

      // Add sources from search results
      for (const result of (searchResult as any).data) {
        yield {
          type: 'source' as const,
          url: result.url,
          title: result.title,
          description: result.description,
        };
      }

      // Extract phase - yield a single pending/complete pair around the batch
      const topUrls = (searchResult as any).data
        .slice(0, 3)
        .map((result: any) => result.url);

      yield makeActivity(
        'extract',
        'pending',
        `Extracting content from ${topUrls.length + 1} sources`,
      );

      const newFindings = await extractFromUrls([
        researchState.urlToSearch,
        ...topUrls,
      ]);
      researchState.findings.push(...newFindings);

      yield makeActivity(
        'extract',
        'complete',
        `Extracted from ${newFindings.length} sources`,
      );

      // Analysis phase
      yield makeActivity('analyze', 'pending', 'Analyzing findings');

      const analysis = await analyzeAndPlan(researchState.findings);
      researchState.nextSearchTopic = analysis?.nextSearchTopic || '';
      researchState.urlToSearch = analysis?.urlToSearch || '';
      researchState.summaries.push(analysis?.summary || '');

      console.log(analysis);
      if (!analysis) {
        yield makeActivity(
          'analyze',
          'error',
          'Failed to analyze findings',
        );

        researchState.failedAttempts++;
        if (
          researchState.failedAttempts >= researchState.maxFailedAttempts
        ) {
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

    yield makeActivity(
      'thought',
      'error',
      `Research failed: ${error.message}`,
    );

    return {
      findings: researchState.findings,
      analysis: '',
      completedSteps: researchState.completedSteps,
      totalSteps: researchState.totalExpectedSteps,
    };
  }
}
