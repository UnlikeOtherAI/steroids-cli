# Pump

> Data gathering CLI with LLM grounding - save credits using Google APIs.

---

## What is Pump?

Pump is an internal utility for data gathering and LLM grounding. It uses Google APIs (Gemini, Search, etc.) to reduce credit consumption on expensive primary LLM providers.

**Part of the Steroids suite:** Pump Iron + Steroids

---

## Planned Features

- Google API integration (Gemini, Search, Knowledge Graph)
- Research grounding before expensive LLM calls
- Local caching to avoid duplicate API calls
- Batch data collection
- Cost tracking and reporting
- Output formats compatible with Steroids CLI

---

## Usage (Planned)

```bash
# Search and ground
pump search "React 19 features" --token $GOOGLE_API_TOKEN

# Research a topic
pump research "authentication best practices" --output context.json

# Use with Steroids
steroids tasks add "Implement auth" --source context.json
```

---

## Status

**Not yet implemented.** See [ARCHITECTURE.md](./ARCHITECTURE.md) for design details.

---

## Related

- [Steroids CLI](../CLI/ARCHITECTURE.md) - Task management
- [Iron CLI](../Iron/README.md) - Documentation scaffolding
