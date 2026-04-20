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
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
  message?: string;
}

const SERPER_TIMEOUT_MS = 15_000;

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
      signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
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

    if (!json.organic) {
      return {
        success: false,
        data: [],
        error: json.message || 'Serper returned no organic results',
      };
    }

    const data: SearchResult[] = json.organic.map((r) => ({
      url: r.link,
      title: r.title,
      description: r.snippet,
    }));

    return { success: true, data };
  } catch (error: any) {
    const message =
      error?.name === 'TimeoutError'
        ? `Serper search timed out after ${SERPER_TIMEOUT_MS}ms`
        : `Serper search failed: ${error.message}`;
    return {
      success: false,
      data: [],
      error: message,
    };
  }
}
