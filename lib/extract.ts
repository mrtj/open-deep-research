import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { generateText } from 'ai';
import { customModel } from '@/lib/ai';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 35_000;

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

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/xhtml')) {
      return {
        success: false,
        error: `Unsupported content type for ${url}: ${contentType}`,
      };
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    const reader = new Readability(document);
    const article = reader.parse();

    if (article && article.textContent) {
      return {
        success: true,
        content: article.textContent.trim().slice(0, MAX_CONTENT_CHARS),
        title: article.title || undefined,
      };
    }

    // Fallback: raw body text if Readability can't extract
    const bodyText = document.body?.textContent?.trim();
    if (bodyText) {
      return {
        success: true,
        content: bodyText.slice(0, MAX_CONTENT_CHARS),
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
