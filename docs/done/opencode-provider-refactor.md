# Refactor HF/Ollama to Invoke via OpenCode CLI

## Context

The HuggingFace and Ollama providers use direct HTTP calls for model invocation. This means models can't use tools, read files, or do multi-step reasoning — making them useless for actual code generation and review tasks. The web UI already stores a `runtime` field ('claude-code' | 'opencode') when pairing models, but this runtime is never used during execution. The fix: create an OpenCode provider that spawns `opencode run` as a subprocess (same pattern as Claude/Codex/Gemini providers), and wire the web UI model picker so selecting an "OpenCode" runtime model saves `provider: 'opencode'` in config.

## Step 1: Create OpenCode Provider

**New file:** `src/providers/opencode.ts` (~300 lines)

Follow Claude provider (`src/providers/claude.ts`) as reference. Key elements:

- **Class:** `OpenCodeProvider extends BaseAIProvider`
- **name:** `'opencode'`, **displayName:** `'OpenCode'`
- **Default template:** `{cli} run -m {model} --format json --dir {cwd} "$(cat {prompt_file})"`
- **Resume template:** append `--session {session_id}`
- **isAvailable():** `which opencode`
- **listModels():** empty array (models come from paired tables, not provider)
- **getDefaultModel():** return undefined (no defaults — user must pair explicitly)

**JSONL parsing** (`opencode run --format json` output):

| Event type | Action |
|-----------|--------|
| `step_start` | No-op, mark activity |
| `text` | Append `part.text` to stdout |
| `tool_use` | Emit `onActivity({ type: 'tool', cmd: part.tool })` |
| `step_finish` | Extract `part.tokens.{input,output}` → `tokenUsage` |
| `error` | Capture error message |
| Any event with `sessionID` | Capture session ID |

**Subprocess management** (reuse from Claude provider pattern):
- `spawn(command, { shell: true, env: getSanitizedCliEnv() })`
- Activity-based resettable timeout (reset on each data chunk)
- SIGTERM → SIGKILL escalation (5s delay)
- Prompt written to temp file with `0o600` permissions
- Cleanup temp file in `finally` block

**No isolated HOME needed** — OpenCode manages its own auth via `~/.config/opencode/opencode.json`.

## Step 2: Type and Config Changes

**`src/config/loader.ts` line 15** — add `'opencode'`:
```typescript
export type ProviderName = 'claude' | 'gemini' | 'openai' | 'codex' | 'mistral' | 'minimax' | 'ollama' | 'hf' | 'opencode';
```

**`src/config/schema.ts` lines 30, 45, 60** — add `'opencode'` to all 3 `_options` arrays.

## Step 3: Register Provider

**`src/providers/registry.ts`** — import `OpenCodeProvider`, add `new OpenCodeProvider()` to the providers array in `createDefaultRegistry()`.

**`src/providers/index.ts`** — add export.

## Step 4: Update AI Model Picker API

**`API/src/routes/ai-model-picker.ts`**

Add `mappedProvider` field to `AIModelResponse`:
```typescript
interface AIModelResponse {
  id: string;
  name: string;
  runtime?: Runtime;
  groupLabel?: string;
  mappedProvider?: string;  // NEW
}
```

Update `toGroupedHFModel()`:
```typescript
function toGroupedHFModel(row: HFPairedModelRow): AIModelResponse {
  const base = { name: row.model_id, runtime: row.runtime, groupLabel: HF_RUNTIME_LABELS[row.runtime] };
  if (row.runtime === 'opencode') {
    return { ...base, id: `huggingface/${row.model_id}`, mappedProvider: 'opencode' };
  }
  return { ...base, id: row.model_id };
}
```

Update `toGroupedOllamaModel()` similarly (prefix `ollama/`).

Add `opencode` to `/ai/providers` list:
```typescript
{ id: 'opencode', name: 'OpenCode (HF/Ollama)', installed: isCliInstalled('opencode') }
```

## Step 5: Update Web UI Model Selection

**`WebUI/src/components/onboarding/AISetupModal.tsx`** (or `AISetupRoleSelector.tsx`)

When user selects a model that has `mappedProvider`, override the provider in config:

```typescript
// When model is selected from dropdown:
if (selectedModel.mappedProvider) {
  // Save provider: 'opencode', model: 'huggingface/deepseek-ai/DeepSeek-V3'
  updateConfig({ provider: selectedModel.mappedProvider, model: selectedModel.id });
} else {
  // Existing behavior
  updateConfig({ model: selectedModel.id });
}
```

This means:
- User picks provider "Hugging Face" in dropdown → sees HF models grouped by runtime
- Picks "OpenCode (HF) / DeepSeek-V3" → config saves `provider: 'opencode', model: 'huggingface/deepseek-ai/DeepSeek-V3'`
- Picks "Claude Code (HF) / DeepSeek-V3" → config saves `provider: 'hf', model: 'deepseek-ai/DeepSeek-V3'` (existing HTTP behavior, eventually deprecated)

## Step 6: Tests

**New:** `tests/opencode-provider.test.ts`
- JSONL event parsing (text, tool_use, step_finish with tokens, error)
- Session ID extraction
- Error classification (model_not_found, rate_limit, auth_error)
- Command building with model and session flags

**Update:** existing tests that assert HF/Ollama models always use provider `'hf'`/`'ollama'`

## Files to Create

| File | Purpose | ~Lines |
|------|---------|--------|
| `src/providers/opencode.ts` | OpenCode CLI provider | ~300 |
| `tests/opencode-provider.test.ts` | Unit tests | ~200 |

## Files to Modify

| File | Change |
|------|--------|
| `src/config/loader.ts:15` | Add `'opencode'` to ProviderName |
| `src/config/schema.ts:30,45,60` | Add `'opencode'` to 3 `_options` arrays |
| `src/providers/registry.ts` | Import + register OpenCodeProvider |
| `src/providers/index.ts` | Export OpenCodeProvider |
| `API/src/routes/ai-model-picker.ts` | Add `mappedProvider`, update model ID format, add opencode to providers |
| `WebUI/src/components/onboarding/AISetupModal.tsx` | Handle `mappedProvider` override on model selection |

## Non-Goals

- Managing OpenCode's `opencode.json` config from steroids (user configures separately)
- Removing/gutting existing HF/Ollama HTTP providers (keep for backwards compat)
- Parsing tool results from OpenCode output (report tool events via onActivity only)

## Verification

1. `npm run build` — compiles
2. `npm test` — all tests pass
3. `steroids config set ai.coder.provider opencode && steroids config set ai.coder.model huggingface/deepseek-ai/DeepSeek-V3` → run task → OpenCode spawned
4. Web UI: `/ai/providers` includes opencode; `/ai/models/hf` returns `mappedProvider: 'opencode'` for opencode-runtime models
5. Web UI: select HF model from "OpenCode (HF)" group → config shows `provider: opencode`
