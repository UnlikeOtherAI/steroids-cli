# AI Provider Configuration

> How to configure and use AI providers with Steroids.
> For orchestrator flow, see [ORCHESTRATOR.md](./ORCHESTRATOR.md)

---

## Overview

Steroids uses **existing CLI tools** for AI providers rather than direct API integration. This approach:

- Leverages already-authenticated CLIs
- Avoids API key management complexity
- Works with any provider that has a CLI
- Allows users to use their existing subscriptions

---

## Supported Providers

| Provider | CLI Tool | Detection Command |
|----------|----------|-------------------|
| Anthropic (Claude) | `claude` | `which claude` |
| Google (Gemini) | `gemini` | `which gemini` |
| OpenAI | `openai` | `which openai` |

### Future Providers

The system is extensible. Any CLI that accepts a prompt and returns a response can be added.

---

## Setup Flow

### Initial Configuration

```bash
$ steroids init
```

The setup wizard:

```
┌─────────────────────────────────────────────────────────────────┐
│                    STEROIDS SETUP WIZARD                          │
└─────────────────────────────────────────────────────────────────┘

Step 1: Detecting installed AI providers...

  ✓ claude (Anthropic) - found at /usr/local/bin/claude
  ✓ gemini (Google) - found at /usr/local/bin/gemini
  ✗ openai - not installed

Step 2: Select ORCHESTRATOR
  The orchestrator generates prompts and coordinates tasks.

  Available providers:
  1. claude (Anthropic)
  2. gemini (Google)

  Select provider [1]: 1

  Fetching available models from Anthropic...

  Available models:
  1. claude-opus-4 (Recommended for orchestration)
  2. claude-sonnet-4
  3. claude-haiku-4

  Select model [1]: 1

  Orchestrator: claude-opus-4 ✓

Step 3: Select CODER
  The coder implements tasks and writes code.

  Select provider [1]: 1

  Available models:
  1. claude-sonnet-4 (Recommended for coding)
  2. claude-opus-4
  3. claude-haiku-4

  Select model [1]: 1

  Coder: claude-sonnet-4 ✓

Step 4: Select REVIEWER
  The reviewer validates implementations.

  Select provider [1]: 1

  Available models:
  1. claude-opus-4 (Recommended for review)
  2. claude-sonnet-4
  3. claude-haiku-4

  Select model [1]: 1

  Reviewer: claude-opus-4 ✓

┌─────────────────────────────────────────────────────────────────┐
│                      CONFIGURATION SUMMARY                        │
├─────────────────────────────────────────────────────────────────┤
│  Orchestrator:  claude-opus-4 (Anthropic)                        │
│  Coder:         claude-sonnet-4 (Anthropic)                      │
│  Reviewer:      claude-opus-4 (Anthropic)                        │
└─────────────────────────────────────────────────────────────────┘

Save configuration? [Y/n]: Y

Configuration saved to ~/.steroids/config.yaml
```

---

## Configuration Schema

### Global Config (`~/.steroids/config.yaml`)

```yaml
ai:
  _description: "AI provider configuration"

  orchestrator:
    _description: "Model that generates prompts and coordinates tasks"
    provider:
      _description: "AI provider"
      _options: [claude, gemini, openai]
      value: claude
    model:
      _description: "Model identifier"
      value: claude-opus-4
    cli:
      _description: "Path to CLI executable"
      value: /usr/local/bin/claude

  coder:
    _description: "Model that implements tasks"
    provider:
      value: claude
    model:
      value: claude-sonnet-4
    cli:
      value: /usr/local/bin/claude

  reviewer:
    _description: "Model that reviews implementations"
    provider:
      value: claude
    model:
      value: claude-opus-4
    cli:
      value: /usr/local/bin/claude
```

### Project Override (`.steroids/config.yaml`)

```yaml
# Override global settings for this project
ai:
  coder:
    provider:
      value: gemini
    model:
      value: gemini-pro
    cli:
      value: /usr/local/bin/gemini

  # Reviewer inherits from global config (not overridden)
```

---

## CLI Tool Invocation

### How Steroids Calls AI Providers

The orchestrator invokes AI CLIs with generated prompts:

```bash
# For Claude
claude --model claude-sonnet-4 --prompt "$(cat prompt.txt)"

# For Gemini
gemini --model gemini-pro --prompt "$(cat prompt.txt)"

# For OpenAI
openai chat --model gpt-4 --message "$(cat prompt.txt)"
```

### Prompt Passing

Prompts are passed via:
1. **Stdin** - For long prompts
2. **Temp file** - For very long prompts with context
3. **--prompt flag** - For shorter prompts

```bash
# Method 1: Stdin
echo "$PROMPT" | claude --model claude-sonnet-4

# Method 2: Temp file
cat > /tmp/steroids-prompt-$$.txt << 'EOF'
$PROMPT
EOF
claude --model claude-sonnet-4 --prompt-file /tmp/steroids-prompt-$$.txt
rm /tmp/steroids-prompt-$$.txt

# Method 3: Direct
claude --model claude-sonnet-4 --prompt "$PROMPT"
```

---

## Model Detection

### Fetching Available Models

During setup, Steroids queries each provider for available models:

```bash
# Claude
claude models list --json

# Gemini
gemini models list --json

# OpenAI
openai models list --json
```

### Model Recommendations

Based on role, Steroids suggests appropriate models:

| Role | Recommendation | Reasoning |
|------|----------------|-----------|
| Orchestrator | Most capable (opus/gpt-4) | Needs to understand context, generate good prompts |
| Coder | Balanced (sonnet/gemini-pro) | Fast, capable, cost-effective |
| Reviewer | Most capable (opus/gpt-4) | Needs to catch issues, make judgment calls |

---

## CLI Commands

```bash
# Provider management
steroids ai providers          # List detected providers
steroids ai models <provider>  # List models for provider
steroids ai test <role>        # Test if role is properly configured

# Configuration
steroids config set ai.coder.provider claude
steroids config set ai.coder.model claude-sonnet-4
steroids config show ai

# Project overrides
steroids config set ai.coder.model gemini-pro --project
```

---

## Error Handling

### Provider Not Found

```
$ steroids runners start

Error: Coder provider 'claude' not found.

  The claude CLI is not installed or not in PATH.

  To install:
    brew install anthropic/tap/claude

  Or select a different provider:
    steroids config set ai.coder.provider gemini
```

### Model Not Available

```
$ steroids runners start

Error: Model 'claude-opus-5' not available.

  Available models for claude:
    - claude-opus-4
    - claude-sonnet-4
    - claude-haiku-4

  Update configuration:
    steroids config set ai.coder.model claude-opus-4
```

### Rate Limiting

If a provider returns a rate limit error:

1. Log the error
2. Wait 60 seconds
3. Retry up to 3 times
4. If still failing, mark task as `failed` and move to next

```
[WARN] Rate limited by Anthropic. Waiting 60s... (attempt 1/3)
[WARN] Rate limited by Anthropic. Waiting 60s... (attempt 2/3)
[ERROR] Rate limit exceeded after 3 attempts. Task marked as failed.
```

---

## Provider-Specific Notes

### Anthropic (Claude)

- Requires `claude` CLI installed
- Authenticated via `claude login`
- Supports streaming responses

```bash
# Install
brew install anthropic/tap/claude

# Authenticate
claude login

# Verify
claude --version
```

### Google (Gemini)

- Requires `gemini` CLI installed
- Authenticated via Google Cloud credentials

```bash
# Install
pip install google-generativeai

# Authenticate
gcloud auth application-default login

# Verify
gemini --version
```

### OpenAI

- Requires `openai` CLI installed
- Authenticated via API key

```bash
# Install
pip install openai

# Set API key
export OPENAI_API_KEY=sk-...

# Verify
openai --version
```

---

## Security Considerations

### CLI Authentication

- Steroids does NOT store API keys
- Uses existing CLI authentication
- Each provider manages its own credentials

### Prompt Isolation

- Prompts are written to temp files with restricted permissions
- Temp files are deleted immediately after use
- No prompt content is logged (only success/failure)

### Audit Trail

Every AI invocation is logged:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "role": "coder",
  "provider": "claude",
  "model": "claude-sonnet-4",
  "taskId": "task-uuid",
  "success": true,
  "durationMs": 45000
}
```

Prompt content is NOT logged for security/privacy.

---

## Related Documentation

- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - How the daemon uses providers
- [PROMPTS.md](./PROMPTS.md) - Prompt templates for each role
- [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md) - Full configuration reference
