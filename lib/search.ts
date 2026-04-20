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
