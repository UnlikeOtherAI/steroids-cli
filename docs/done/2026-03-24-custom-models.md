# Custom Models Implementation Plan

**Goal:** A new `custom` provider that lets users define their own inference endpoints (MiniMax, OpenRouter, vLLM, etc.) via the web UI. When selected as a runner, it delegates to `claude`, `opencode`, or `codex` CLI with custom base URL + token injected as env vars.

**Architecture:** CustomModelsProvider reads `ai.custom.models[]` from config, delegates to the chosen CLI (claude/opencode/codex) with env overrides. WebUI has a new "Custom" page to CRUD entries. The `custom` provider appears in provider dropdowns; its model names are the user-defined entry names.

---

## Task 1: Config Type & Schema

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/provider-names.ts`

**Step 1:** Add to `loader.ts` — add `CustomModelConfig` interface and `custom` field to `SteroidsConfig.ai`.

**Step 2:** Add `custom` to `schema.ts` CONFIG_SCHEMA under `ai`.

**Step 3:** Add `'custom'` to `PROVIDER_NAMES` array in `provider-names.ts`.

---

## Task 2: CustomModelsProvider

**Files:**
- Create: `src/providers/custom.ts`
- Modify: `src/providers/registry.ts`

**Pattern:** Provider reads `ai.custom.models[]` from config, delegates to underlying `ClaudeProvider` / `OpenCodeProvider` / `CodexProvider` with env overrides set on `process.env` during the invoke call (restored in `finally`).

**Per-CLI injection:**
- `claude` → `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`
- `opencode` → `OPENAI_BASE_URL` + `OPENAI_API_KEY`
- `codex` → `CODEX_HOME` env var pointing to isolated dir with `config.toml` + `OPENAI_API_KEY` env var fallback

**Register** `CustomModelsProvider` in `createDefaultRegistry()`.

---

## Task 3: API Route

**Files:**
- Modify: `API/src/routes/ai-model-picker.ts`

**Step 1:** Add `{ id: 'custom', name: 'Custom Endpoints', installed: true }` to `/ai/providers`.

**Step 2:** Add `GET /ai/models/custom` route — reads `ai.custom.models` from global config (via `steroids config get --global --json`) and returns as `AIModelResponse[]`.

---

## Task 4: WebUI Page

**Files:**
- Create: `WebUI/src/pages/CustomModelsPage.tsx`
- Modify: `WebUI/src/App.tsx`
- Modify: `WebUI/src/services/api.ts`

**Step 1:** Add `customModelsApi.list()` and `customModelsApi.save()` to api.ts.

**Step 2:** Create `CustomModelsPage.tsx` — CRUD UI for custom models (name, CLI dropdown, baseUrl, token). Shows info banner for Codex entries.

**Step 3:** Register `/custom` route in App.tsx. Add to getPageTitle().

---

## Task 5: Sidebar

**Files:**
- Modify: `WebUI/src/components/layouts/Sidebar.tsx`

**Step 1:** Add "Custom" nav link to AI Models section.

---

## Task 6: AIRoleSettings Integration

**Files:**
- Modify: `WebUI/src/components/onboarding/AISetupModal.tsx` or wherever model dropdowns live

**Step 1:** When provider = 'custom', call `aiApi.getModels('custom')` to populate model dropdown.

---

## Task 7: Build & Restart

**Step 1:** `npm run build`

**Step 2:** Copy changed .js files to `/opt/homebrew/lib/node_modules/steroids-cli/dist/`

**Step 3:** `cd WebUI && npm run build`

**Step 4:** `steroids web stop && steroids web`
