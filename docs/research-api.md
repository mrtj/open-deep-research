# Research API

Programmatic endpoint for deep research. No browser session required.

## Setup

Set these environment variables on the server:

```bash
API_KEY=your-secret-key          # Bearer token for authentication
FIRECRAWL_API_KEY=fc-...         # Firecrawl API key for page extraction
SERPER_API_KEY=...               # Serper API key for web search
OPENAI_API_KEY=sk-...            # Required if using OpenAI models
OPENROUTER_API_KEY=sk-or-...     # Optional: routes all models through OpenRouter
REASONING_MODEL=o1-mini          # Optional: default reasoning model (fallback: o1-mini)
```

Start the server:

```bash
API_KEY=your-secret-key pnpm dev
```

## Endpoint

```
POST /api/research
POST /api/research?stream=false
```

### Authentication

All requests require a Bearer token matching the `API_KEY` env var:

```
Authorization: Bearer your-secret-key
```

### Request body

```json
{
  "topic": "string",
  "maxDepth": 7,
  "reasoningModelId": "o3-mini"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `topic` | string | yes | — | The research question or topic |
| `maxDepth` | number | no | 7 | Research depth (1–20). Higher = more thorough but slower |
| `reasoningModelId` | string | no | `REASONING_MODEL` env or `o1-mini` | Model for analysis and synthesis |

`reasoningModelId` accepts any model string. If `OPENROUTER_API_KEY` is set, the ID is routed through OpenRouter (e.g. `anthropic/claude-sonnet-4`, `meta-llama/llama-4-maverick`). Otherwise it's sent to OpenAI or TogetherAI (for DeepSeek models).

## Response modes

### Streaming (default)

Returns newline-delimited JSON (NDJSON). Each line is a progress event, with the final line containing the research result.

```bash
curl -N \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"topic": "recent advances in quantum error correction", "maxDepth": 3}' \
  http://localhost:3000/api/research
```

**Content-Type:** `text/x-ndjson`

#### Event types

**`progress-init`** — emitted once at the start:
```json
{"type":"progress-init","maxDepth":3,"totalSteps":15}
```

**`depth`** — emitted when entering a new research depth level:
```json
{"type":"depth","current":1,"max":3,"completedSteps":0,"totalSteps":15}
```

**`activity`** — emitted for each research action (search, extract, analyze, synthesis):
```json
{"type":"activity","activityType":"search","status":"complete","message":"Found 8 relevant results","timestamp":"2026-04-17T10:30:00.000Z","depth":1,"completedSteps":2,"totalSteps":15}
```

Activity types: `search`, `extract`, `analyze`, `reasoning`, `synthesis`, `thought`
Status values: `pending`, `complete`, `error`

**`source`** — emitted when a source URL is discovered:
```json
{"type":"source","url":"https://example.com/article","title":"Article Title","description":"Brief description"}
```

**`result`** — final line with the complete research output:
```json
{
  "type": "result",
  "findings": [
    {"text": "Key finding from the source...", "source": "https://example.com"}
  ],
  "analysis": "Comprehensive analysis text...",
  "metadata": {
    "maxDepth": 3,
    "durationMs": 142000,
    "steps": 12
  }
}
```

**`error`** — emitted if research fails (includes any partial findings gathered before the error):
```json
{
  "type": "error",
  "message": "Description of what went wrong",
  "findings": [],
  "metadata": {"maxDepth": 3, "durationMs": 5000, "steps": 2}
}
```

### Non-streaming (`?stream=false`)

Blocks until research completes, then returns a single JSON response.

```bash
curl \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"topic": "recent advances in quantum error correction", "maxDepth": 3}' \
  'http://localhost:3000/api/research?stream=false'
```

**Content-Type:** `application/json`

```json
{
  "findings": [
    {"text": "Key finding...", "source": "https://example.com"}
  ],
  "analysis": "Comprehensive analysis text...",
  "sources": [
    {"title": "Article Title", "url": "https://example.com"}
  ],
  "metadata": {
    "maxDepth": 3,
    "durationMs": 142000,
    "steps": 12
  }
}
```

Note: non-streaming mode includes a `sources` array (collected from all discovered URLs). Streaming mode emits sources as individual `source` events instead.

## Error responses

| Status | Cause |
|--------|-------|
| 400 | Missing `topic`, invalid JSON, `maxDepth` out of range |
| 401 | Missing or invalid `Authorization` header |
| 500 | `API_KEY` or `FIRECRAWL_API_KEY` not configured, provider error |

All errors return JSON:

```json
{"error": "descriptive message"}
```

## Examples

### Python

```python
import requests
import json

API_URL = "http://localhost:3000/api/research"
HEADERS = {
    "Authorization": "Bearer your-secret-key",
    "Content-Type": "application/json",
}

# Non-streaming
response = requests.post(
    API_URL,
    headers=HEADERS,
    params={"stream": "false"},
    json={"topic": "impact of AI on drug discovery", "maxDepth": 3},
    timeout=600,
)
result = response.json()
print(result["analysis"])

# Streaming
response = requests.post(
    API_URL,
    headers=HEADERS,
    json={"topic": "impact of AI on drug discovery", "maxDepth": 3},
    stream=True,
    timeout=600,
)
for line in response.iter_lines():
    if line:
        event = json.loads(line)
        if event["type"] == "activity":
            print(f"[{event['activityType']}] {event['message']}")
        elif event["type"] == "result":
            print(f"\n{event['analysis']}")
```

### Node.js

```javascript
const response = await fetch("http://localhost:3000/api/research?stream=false", {
  method: "POST",
  headers: {
    "Authorization": "Bearer your-secret-key",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    topic: "impact of AI on drug discovery",
    maxDepth: 3,
  }),
});

const result = await response.json();
console.log(result.analysis);
```

## Timing

Research takes 1–5 minutes depending on `maxDepth` and topic complexity. The internal timeout is 4.5 minutes per research run. For non-streaming mode, set your HTTP client timeout to at least 10 minutes.
