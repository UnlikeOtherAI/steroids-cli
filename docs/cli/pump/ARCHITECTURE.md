# Pump CLI Architecture

> Data gathering CLI with LLM grounding using Google APIs.
> Completely independent from the main Steroids CLI.

---

## Overview

Pump is an internal utility for data gathering and LLM grounding. It uses Google APIs (Gemini, Search, etc.) to reduce credit consumption on primary LLM providers.

**Purpose:**
- Gather and preprocess data before sending to expensive LLMs
- Ground LLM responses with real-time search data
- Cache and deduplicate API calls
- Save credits by using cost-effective Google APIs for research tasks

---

## Independence

Pump is **completely independent** from Steroids CLI:

| Aspect | Steroids CLI | Pump CLI |
|--------|---------------|----------|
| Purpose | Task management | Data gathering |
| Storage | `.steroids/` | `.pump/` or standalone |
| Dependencies | None shared | None shared |
| Can run without other | Yes | Yes |

---

## Google API Integration

### Authentication

```bash
# Pass Google API token
pump --token <GOOGLE_API_TOKEN> search "query"

# Or use environment variable
export GOOGLE_API_TOKEN=your-token
pump search "query"

# Or use config
pump config set google.token <token>
```

### Supported APIs

| API | Use Case |
|-----|----------|
| Gemini | Fast, cheap LLM for preprocessing |
| Google Search | Real-time web grounding |
| Custom Search JSON | Structured search results |
| Knowledge Graph | Entity extraction |

---

## Use Cases

### 1. Research Grounding

```bash
# Gather context before expensive LLM call
pump research "React 19 new features" --output context.json

# Use context in main workflow
steroids tasks update "Research React 19" --context context.json
```

### 2. Batch Data Collection

```bash
# Collect data on multiple topics
pump batch topics.txt --output results/
```

### 3. Cache-First Queries

```bash
# Check cache before API call
pump search "TypeScript 5.4 features" --cache-first

# Results cached for future use
```

---

## Cost Savings

| Operation | Primary LLM | Pump (Google) | Savings |
|-----------|-------------|---------------|---------|
| Web search grounding | $0.01/query | $0.001/query | 90% |
| Quick summarization | $0.03/1K tokens | $0.0001/1K tokens | 99% |
| Data preprocessing | $0.06/1K tokens | $0.0005/1K tokens | 99% |

---

## CLI Commands

```bash
# Search and ground
pump search "query" [options]

# Research a topic (multi-step)
pump research "topic" [options]

# Batch operations
pump batch <file> [options]

# Manage config
pump config set <key> <value>
pump config show

# Cache management
pump cache stats
pump cache clear
```

---

## Configuration

```yaml
# ~/.pump/config.yaml

google:
  token: ${GOOGLE_API_TOKEN}
  project: my-project-id

cache:
  enabled: true
  ttl: 24h
  maxSize: 100MB

output:
  format: json
  pretty: true
```

---

## Output Format

```json
{
  "query": "React 19 new features",
  "timestamp": "2024-01-15T10:30:00Z",
  "sources": [
    {
      "url": "https://react.dev/blog/...",
      "title": "React 19 Release Notes",
      "snippet": "..."
    }
  ],
  "summary": "React 19 introduces...",
  "tokens_used": 150,
  "cost": 0.00015,
  "cached": false
}
```

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 LTS |
| Language | TypeScript |
| CLI Framework | Commander.js |
| HTTP Client | Undici |
| Cache | SQLite (local) |

---

## Directory Structure

```
Pump/
├── src/
│   ├── commands/
│   │   ├── search.ts
│   │   ├── research.ts
│   │   ├── batch.ts
│   │   └── config.ts
│   ├── services/
│   │   ├── GoogleSearchService.ts
│   │   ├── GeminiService.ts
│   │   └── CacheService.ts
│   ├── utils/
│   │   └── cost.ts
│   └── main.ts
├── package.json
├── tsconfig.json
└── ARCHITECTURE.md
```

---

## Integration with Steroids

While independent, Pump can feed data to Steroids:

```bash
# Gather context
pump research "authentication best practices" -o auth-context.json

# Use in Steroids task
steroids tasks add "Implement auth" --source auth-context.json
```

The `--source` flag in Steroids links to Pump output for LLM context.

---

## Related Documentation

- [Steroids CLI](../ARCHITECTURE.md) - Main task management CLI
- [Steroids CLAUDE.md](../../../CLAUDE.md) - Project-wide coding standards
