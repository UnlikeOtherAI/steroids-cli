# Architectural Study: JSON Schemas vs. Plain Text Signals

## 1. Current State of Structured Outputs in Steroids CLI
Currently, the system enforces structured data by requesting the LLM to output a ````json` block. This relies entirely on **Prompt Engineering** rather than native API capabilities.

### Provider Capabilities Review (Real API Docs)
To implement native "Structured Outputs" (where the LLM is guaranteed to return valid JSON matching a schema), we must examine the CLIs we wrap:

*   **Google Gemini:** Native API supports `responseMimeType: "application/json"` and `responseSchema`. The `gemini` CLI supports this via `modelConfigs` in `settings.json`. However, dynamically generating and passing this configuration per-task via the CLI interface is cumbersome.
*   **Anthropic Claude:** The native API supports JSON schemas via "Tool Use" (forcing the model to call a specific tool to return the JSON). However, the `claude` CLI we wrap does *not* expose a simple `--response-schema` flag for arbitrary text completion.
*   **OpenAI / Mistral / Ollama:** All support JSON mode natively in their APIs, but CLI wrapper support varies wildly.

**Conclusion:** Enforcing strict JSON schemas at the API layer across all 5+ independent CLI providers is technically infeasible without dropping the CLIs and migrating to native SDKs (which would ruin the "bring your own CLI" architecture).

---

## 2. Do we need JSON at all? (The "Signal" Model)
With the recent implementation of the **Signal Extractor** in `fallback-handler.ts`, we proved that extracting deterministic intent (signals) from unstructured text is often safer than parsing fragile JSON.

### The Coder Case
**Current JSON:**
```json
{
  "action": "submit",
  "reasoning": "...",
  "commits": ["abc1234"],
  ...
}
```
**Plain Text Alternative:**
If the Coder simply states `ACTION: SUBMIT` and provides its reasoning in markdown, the system doesn't lose any functionality. The `commits` are already retrieved safely by the host system (`resolveSubmissionCommitHistoryWithRecovery`), rendering the LLM's self-reported commit array mostly redundant.

### The Reviewer Case
**Current JSON:**
```json
{
  "decision": "approve",
  "reasoning": "...",
  "notes": "...",
  "follow_up_tasks": [...]
}
```
**Plain Text Alternative:**
```markdown
**DECISION:** APPROVE
**REASONING:** The code meets all requirements.

### Follow Up Tasks
- **Task 1:** Refactor config parser.
```
A simple regex (`/DECISION:\s*(APPROVE|REJECT|DISPUTE|SKIP)/i`) handles the core state machine perfectly. Markdown parsing can easily extract bulleted lists for follow-up tasks.

---

## 3. Recommended Simplification (The Next Evolution)
The loop can be simplified even further by abandoning JSON outputs for the AI roles. 

### Benefits of dropping JSON:
1.  **Zero Parse Errors:** No more missing commas, unescaped quotes, or `JSON.parse()` crashes.
2.  **Model Flexibility:** Smaller models (like Haiku or Gemini Flash) excel at markdown but often struggle with nested JSON logic. 
3.  **Code Deletion:** We can delete `schemas.ts`, the `ajv` dependency, and the entire `fallback-handler.ts` tiered parsing system, replacing it with a ~20 line `SignalParser`.
4.  **Token Efficiency:** Generating `{"decision": "approve", "reasoning": "..."}` uses more tokens than simply writing `DECISION: APPROVE`.

### How the Ultimate Loop Looks:
```typescript
// 1. Runner invokes LLM and gets raw text.
const output = await invokeReviewer(...);

// 2. Simple Signal Extraction
const decisionMatch = output.match(/DECISION:\s*(APPROVE|REJECT|DISPUTE)/i);
const decision = decisionMatch ? decisionMatch[1].toLowerCase() : 'unclear';

// 3. State Transition
updateTaskStatus(db, taskId, decision === 'approve' ? 'completed' : 'in_progress');
```

By removing JSON, the orchestrator becomes a pure text-signal router, eliminating the need to "repair" or "validate" outputs entirely.
