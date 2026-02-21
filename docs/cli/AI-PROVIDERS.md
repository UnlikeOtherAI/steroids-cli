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

## Detailed Provider References

For in-depth operational knowledge about each provider CLI — invocation details, output formats, session management, known issues, and integration notes — see the per-provider reference docs:

- [Claude Code CLI Reference](./providers/claude.md) — Anthropic's Claude CLI
- [Codex CLI Reference](./providers/codex.md) — OpenAI's Codex CLI
- [Gemini CLI Reference](./providers/gemini.md) — Google's Gemini CLI
- [Vibe CLI Reference](./providers/vibe.md) — Mistral's Vibe CLI

---

## Supported Providers

| Provider | CLI Tool | Detection Command |
|----------|----------|-------------------|
| Anthropic (Claude) | `claude` | `which claude` |
| Google (Gemini) | `gemini` | `which gemini` |
| Codex (OpenAI) | `codex` | `which codex` |
| Mistral (Vibe) | `vibe` | `which vibe` |

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

The orchestrator invokes AI CLIs with generated prompts via stdin:

```bash
# For Claude Code CLI
claude --print --model claude-sonnet-4 < /tmp/prompt.txt

# For Gemini (via gcloud or standalone)
# Pattern depends on installation method
cat /tmp/prompt.txt | gemini-cli generate

# For OpenAI
cat /tmp/prompt.txt | openai api chat.completions.create --model gpt-4
```

**Note:** Exact CLI flags depend on the installed version. Steroids detects available CLIs and adapts invocation patterns accordingly. If a CLI's interface changes, update `~/.steroids/config.yaml` with custom invocation templates.

### Prompt Passing

All prompts are passed via **stdin with temp file**:

```bash
# Standard invocation pattern:
# 1. Write prompt to temp file
cat > /tmp/steroids-prompt-$$.txt << 'EOF'
$PROMPT
EOF

# 2. Invoke CLI with stdin redirection
claude --print --model claude-sonnet-4 < /tmp/steroids-prompt-$$.txt

# 3. Clean up
rm /tmp/steroids-prompt-$$.txt
```

### Custom CLI Templates

If the default invocation doesn't work for your CLI version:

```yaml
# In ~/.steroids/config.yaml
ai:
  coder:
    provider:
      value: claude
    model:
      value: claude-sonnet-4
    invocation:
      # Custom invocation template
      # {model} and {prompt_file} are substituted
      value: "claude --print --model {model} < {prompt_file}"
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

### Error Classification

The CLI classifies errors by exit code and output patterns:

| Error Type | Detection | Retry? | Action |
|------------|-----------|--------|--------|
| `rate_limit` | Exit 1 + "rate limit" in stderr | Yes (3x) | Exponential backoff |
| `auth_error` | Exit 1 + "unauthorized"/"auth" | No | Stop, alert user |
| `network_error` | Exit 1 + "connection"/"timeout" | Yes (cron) | Next cycle retries |
| `model_not_found` | Exit 1 + "model"/"not found" | No | Stop, alert user |
| `context_exceeded` | Exit 1 + "context"/"token" | No | Log, move to next task |
| `subprocess_hung` | No log output for 15 min | No | Kill, next cycle retries |
| `unknown` | Any other exit 1 | Yes (1x) | Log details for debugging |

### Network Failure Handling

**Simple retry via cron.** No special backoff logic needed:

1. Network failure occurs (connection refused, timeout, DNS failure)
2. LLM invocation fails, task status remains unchanged
3. Next cron cycle (1 minute) picks up the same task
4. Retries automatically when network comes back

```python
def handle_network_error():
    # Don't retry immediately - let cron handle it
    log_warning("Network error - will retry next cron cycle")
    # Task status unchanged, so next wakeup will pick it up
```

### Subprocess Hang Detection

LLM subprocesses are monitored by log timestamps, not wall-clock time:

```python
def monitor_subprocess(process, log_file):
    last_output_time = datetime.now()

    while process.poll() is None:
        # Check for new output
        if has_new_output(log_file):
            last_output_time = datetime.now()

        # Check for hang (15 minutes with no output)
        if datetime.now() - last_output_time > timedelta(minutes=15):
            log_error("Subprocess hung - no output for 15 minutes")
            process.kill()
            return "subprocess_hung"

        time.sleep(10)  # Check every 10 seconds

    return "completed"
```

**Why 15 minutes?** LLM sessions can involve long thinking pauses, but 15 minutes without ANY output (including progress indicators) means the subprocess is stuck.

```python
def classify_error(exit_code, stderr):
    if exit_code == 0:
        return None

    stderr_lower = stderr.lower()

    if "rate limit" in stderr_lower or "429" in stderr:
        return "rate_limit"
    if "unauthorized" in stderr_lower or "auth" in stderr_lower:
        return "auth_error"
    if "connection" in stderr_lower or "timeout" in stderr_lower:
        return "network_error"
    if "model" in stderr_lower and "not found" in stderr_lower:
        return "model_not_found"
    if "context" in stderr_lower or "token limit" in stderr_lower:
        return "context_exceeded"

    return "unknown"
```

---

## Provider-Specific Notes

> For detailed CLI references including invocation templates, output formats, session management, and known issues, see the [Detailed Provider References](#detailed-provider-references) section above.

### Anthropic (Claude)

- Requires `claude` CLI installed
- Authenticated via `claude login`
- Supports streaming responses
- See [Claude CLI Reference](./providers/claude.md) for full details

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
- See [Gemini CLI Reference](./providers/gemini.md) for full details

```bash
# Install
pip install google-generativeai

# Authenticate
gcloud auth application-default login

# Verify
gemini --version
```

### Codex (OpenAI)

- Requires `codex` CLI installed
- This IS OpenAI's development tool CLI - there is no separate `openai` CLI
- Authenticated via API key
- See [Codex CLI Reference](./providers/codex.md) for full details

```bash
# Install: See https://codex.com

# Set API key
export OPENAI_API_KEY=sk-...

# Verify
codex --version
```

### Mistral (Vibe)

- Requires `vibe` CLI installed (via `uv` or `pip`)
- Authenticated via `vibe --setup` or `MISTRAL_API_KEY` env var
- See [Vibe CLI Reference](./providers/vibe.md) for full details

```bash
# Install
uv tool install mistral-vibe

# Authenticate
vibe --setup

# Verify
vibe --version
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

### Invocation Logging

Every AI invocation is logged to `.steroids/logs/` with full input/output capture.

#### Log Directory Structure

```
.steroids/logs/
├── a1b2c3d4-coder-001.log      # First coder attempt
├── a1b2c3d4-coder-002.log      # Second coder attempt (after rejection)
├── a1b2c3d4-reviewer-001.log   # First review
├── b2c3d4e5-coder-001.log      # Different task
└── (index stored in steroids.db)
```

#### Naming Convention

```
{task_id_prefix}-{role}-{attempt}.log
```

| Part | Description |
|------|-------------|
| `task_id_prefix` | First 8 chars of task UUID |
| `role` | `coder`, `reviewer`, or `orchestrator` |
| `attempt` | Sequential attempt number (001, 002, ...) |

#### Log Entry Format

**Important:** Every log line includes a timestamp for hang detection. If no new timestamped output appears for 15 minutes, the subprocess is considered hung.

```json
{
  "version": 1,
  "meta": {
    "timestamp": "2024-01-15T10:30:00Z",
    "taskId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "role": "coder",
    "provider": "claude",
    "model": "claude-sonnet-4",
    "attempt": 1,
    "durationMs": 45000,
    "exitCode": 0,
    "success": true,
    "lastOutputAt": "2024-01-15T10:30:45Z"  // For hang detection
  },
  "invocation": {
    "command": "claude --print --model claude-sonnet-4",
    "promptFile": "/tmp/steroids-prompt-12345.txt",
    "workingDirectory": "/path/to/project"
  },
  "input": {
    "promptHash": "sha256:abc123...",
    "promptSizeBytes": 15420,
    "promptPreview": "# Task: Implement user authentication\n\n## Context\n..."
  },
  "output": {
    "stdout": "I'll implement the authentication feature...\n\n```typescript\n...",
    "stderr": "",
    "stdoutSizeBytes": 8240
  },
  "error": null
}
```

#### Error Log Entry

```json
{
  "version": 1,
  "meta": {
    "timestamp": "2024-01-15T10:32:00Z",
    "taskId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "role": "coder",
    "provider": "claude",
    "model": "claude-sonnet-4",
    "attempt": 2,
    "durationMs": 1200,
    "exitCode": 1,
    "success": false
  },
  "invocation": {
    "command": "claude --print --model claude-sonnet-4",
    "promptFile": "/tmp/steroids-prompt-12346.txt",
    "workingDirectory": "/path/to/project"
  },
  "input": {
    "promptHash": "sha256:def456...",
    "promptSizeBytes": 15420,
    "promptPreview": "# Task: Implement user authentication..."
  },
  "output": {
    "stdout": "",
    "stderr": "Error: Rate limit exceeded. Please try again in 60 seconds.",
    "stdoutSizeBytes": 0
  },
  "error": {
    "type": "rate_limit",
    "message": "Rate limit exceeded",
    "retryable": true,
    "retryAfterMs": 60000
  }
}
```

#### Index File

Quick lookup without parsing all logs:

```json
{
  "version": 1,
  "tasks": {
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890": {
      "title": "Implement user authentication",
      "logs": [
        {"file": "a1b2c3d4-coder-001.log", "role": "coder", "success": true},
        {"file": "a1b2c3d4-reviewer-001.log", "role": "reviewer", "success": true}
      ]
    }
  }
}
```

#### CLI Commands

```bash
# View logs for a task
steroids logs show a1b2c3d4-...

# View specific invocation
steroids logs show a1b2c3d4-... --role coder --attempt 1

# Tail recent logs
steroids logs tail

# Purge old logs
steroids logs purge --older-than 30d
```

#### Log Retention

```yaml
# In ~/.steroids/config.yaml
logs:
  enabled:
    value: true
  retentionDays:
    value: 30
  maxSizeMb:
    value: 500
  includePrompts:
    value: true  # Set false to only log prompt hash, not content
  purgeWithTasks:
    value: true  # Delete logs when associated task is purged
```

#### Purge Behavior

When `steroids purge tasks` is run, associated logs are also purged:

```bash
# Purge completed tasks older than 30 days
steroids purge tasks --older-than 30d

# This also deletes:
# - .steroids/logs/{taskid}-*.log for each purged task
# - Updates invocation_logs table in steroids.db
```

Logs for completed/disputed tasks are removed with the task. Only logs for active (pending, in_progress, review) tasks are retained.

```
Task purged: a1b2c3d4-...
  → Deleted: .steroids/logs/a1b2c3d4-coder-001.log
  → Deleted: .steroids/logs/a1b2c3d4-coder-002.log
  → Deleted: .steroids/logs/a1b2c3d4-reviewer-001.log
```

To keep logs even after task purge:
```bash
steroids purge tasks --older-than 30d --keep-logs
```

---

## Related Documentation

- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - How the daemon uses providers
- [PROMPTS.md](./PROMPTS.md) - Prompt templates for each role
- [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md) - Full configuration reference
- [Session Context Reuse](./design/session-context-reuse.md) - Design doc for session resume across providers
- **Provider CLI References:** [Claude](./providers/claude.md) | [Codex](./providers/codex.md) | [Gemini](./providers/gemini.md) | [Vibe](./providers/vibe.md)
