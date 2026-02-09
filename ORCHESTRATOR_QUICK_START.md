# Orchestrator Quick Start Guide

Fast reference for implementing and using the orchestrator system.

---

## TL;DR

**Before:** Coder/reviewer run CLI commands to update task status (unreliable)
**After:** Orchestrators analyze their output and make workflow decisions (structured JSON)

**Files:**
- `ORCHESTRATOR_PROMPTS.md` - The prompts (copy-paste ready)
- `ORCHESTRATOR_IMPLEMENTATION.md` - TypeScript code examples
- `ORCHESTRATOR_SUMMARY.md` - Full design documentation
- `ORCHESTRATOR_QUICK_START.md` - This file

---

## 5-Minute Implementation

### 1. Create Type Definitions

```bash
touch src/orchestrator/types.ts
```

```typescript
// src/orchestrator/types.ts
export interface CoderAnalysisOutput {
  action: 'submit' | 'retry' | 'stage_commit_submit' | 'error';
  reasoning: string;
  next_status: 'review' | 'in_progress' | 'failed';
  commit_message?: string;
  error_type?: 'timeout' | 'no_changes' | 'invalid_state';
  confidence: number;
}

export interface ReviewerAnalysisOutput {
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'ambiguous';
  reasoning: string;
  feedback: string;
  next_status: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review';
  confidence: number;
  should_push: boolean;
}
```

### 2. Add Orchestrator Invocation

```typescript
// src/orchestrator/invoke.ts
import { getProviderRegistry } from '../providers/registry.js';
import { loadConfig } from '../config/loader.js';

export async function invokeCoderOrchestrator(
  prompt: string,
  projectPath: string
): Promise<CoderAnalysisOutput> {
  const config = loadConfig(projectPath);
  const provider = getProviderRegistry().get(config.ai?.orchestrator?.provider || 'anthropic');

  const result = await provider.invoke(prompt, {
    model: config.ai?.orchestrator?.model || 'claude-3-5-haiku-20241022',
    temperature: 0.1,
    timeout: 30_000, // 30 seconds
  });

  return parseCoderOutput(result.stdout);
}

function parseCoderOutput(output: string): CoderAnalysisOutput {
  const cleaned = output.trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '');

  const parsed = JSON.parse(cleaned);

  // Validate and return
  if (!parsed.action || !parsed.next_status) {
    throw new Error('Invalid orchestrator output');
  }

  return parsed;
}
```

### 3. Update Loop

```typescript
// In src/commands/loop-phases.ts
export async function executeCoderPhase(task: Task, projectPath: string) {
  // 1. Run coder
  const coderResult = await invokeCoder(task, projectPath, 'start');

  // 2. Gather git state
  const gitState = {
    commits: getRecentCommits(projectPath, 5),
    files_changed: getModifiedFiles(projectPath),
    has_uncommitted_changes: hasUncommittedChanges(projectPath),
    diff_summary: getDiffSummary(projectPath),
  };

  // 3. Build prompt (use template from ORCHESTRATOR_PROMPTS.md)
  const prompt = buildCoderOrchestratorPrompt(task, coderResult, gitState);

  // 4. Invoke orchestrator
  const decision = await invokeCoderOrchestrator(prompt, projectPath);

  // 5. Take action
  switch (decision.action) {
    case 'submit':
      updateTaskStatus(task.id, 'review');
      break;
    case 'stage_commit_submit':
      execSync(`git add -A && git commit -m "${decision.commit_message}"`);
      updateTaskStatus(task.id, 'review');
      break;
    case 'retry':
      // Keep in_progress, will retry
      break;
    case 'error':
      updateTaskStatus(task.id, 'failed');
      break;
  }
}
```

---

## Prompt Templates (Copy-Paste)

### Coder Orchestrator Prompt (Minimal)

```
# CODER OUTPUT ANALYZER

You analyze a coder's work and decide next steps. Output ONLY valid JSON.

## Task
ID: {task.id}
Title: {task.title}

## Coder Result
Exit code: {exit_code}
Timed out: {timed_out}
Output: {stdout}

## Git State
Commits: {commits.length}
Files changed: {files.length}
Uncommitted: {has_uncommitted}

## Decision Rules
- Timeout → error
- No changes → error
- Exit 0 + commits → submit
- Exit 0 + files but no commit → stage_commit_submit
- Exit non-zero + progress → retry

## Output JSON Schema
{
  "action": "submit|retry|stage_commit_submit|error",
  "reasoning": "1-2 sentences",
  "next_status": "review|in_progress|failed",
  "commit_message": "only if stage_commit_submit",
  "error_type": "only if error: timeout|no_changes|invalid_state",
  "confidence": 0.85
}

Output JSON now:
```

### Reviewer Orchestrator Prompt (Minimal)

```
# REVIEWER OUTPUT ANALYZER

You analyze a reviewer's assessment and extract their decision. Output ONLY valid JSON.

## Task
ID: {task.id}
Title: {task.title}
Rejections: {rejection_count}

## Reviewer Result
Exit code: {exit_code}
Output: {stdout}

## Decision Rules
- "approve" or "LGTM" → approve
- "reject" or checkbox list → reject
- "dispute" → dispute
- "skip" → skip
- Unclear → ambiguous

## Output JSON Schema
{
  "decision": "approve|reject|dispute|skip|ambiguous",
  "reasoning": "1-2 sentences",
  "feedback": "extracted notes",
  "next_status": "completed|in_progress|disputed|skipped|review",
  "confidence": 0.92,
  "should_push": true
}

Output JSON now:
```

---

## Common Patterns

### Pattern 1: Coder Finished Work
```typescript
if (decision.action === 'submit' && decision.confidence > 0.80) {
  console.log(`✓ Coder completed task: ${decision.reasoning}`);
  updateTaskStatus(db, task.id, 'review', 'orchestrator', decision.reasoning);
}
```

### Pattern 2: Auto-Commit Forgotten Work
```typescript
if (decision.action === 'stage_commit_submit') {
  console.log(`Auto-committing: ${decision.commit_message}`);
  execSync(`git add -A && git commit -m "${decision.commit_message}"`, { cwd: projectPath });
  updateTaskStatus(db, task.id, 'review', 'orchestrator', 'Auto-committed');
}
```

### Pattern 3: Retry on Low Confidence
```typescript
if (decision.confidence < 0.50) {
  console.warn(`Low confidence (${decision.confidence}), defaulting to retry`);
  // Keep task in current status, will retry on next loop
}
```

### Pattern 4: Reviewer Approval
```typescript
if (decision.decision === 'approve' && decision.should_push) {
  updateTaskStatus(db, task.id, 'completed', 'orchestrator', decision.feedback);
  execSync('git push', { cwd: projectPath });
  console.log(`✓ Task approved and pushed`);
}
```

### Pattern 5: Reviewer Rejection
```typescript
if (decision.decision === 'reject') {
  rejectTask(db, task.id, decision.feedback, commitSha, 'orchestrator');
  updateTaskStatus(db, task.id, 'in_progress', 'orchestrator', 'Rejected');
  console.log(`✗ Task rejected (${task.rejection_count + 1}/15)`);
}
```

### Pattern 6: Ambiguous Decision → Retry
```typescript
if (decision.decision === 'ambiguous' && decision.confidence < 0.60) {
  console.warn('Ambiguous review decision, retrying with stricter prompt');
  // Re-invoke reviewer with more explicit instructions
}
```

---

## Decision Matrix

### Coder Actions

| Git State | Exit Code | Timeout | Action | Next Status |
|-----------|-----------|---------|--------|-------------|
| No commits, no files | 0 | No | error (no_changes) | failed |
| Has commits | 0 | No | submit | review |
| No commits, has files, uncommitted | 0 | No | stage_commit_submit | review |
| Any | Any | Yes | error (timeout) | failed |
| Any | Non-zero | No | retry or error | in_progress or failed |

### Reviewer Decisions

| Output Contains | Decision | Next Status | Push? |
|-----------------|----------|-------------|-------|
| "approve" or "LGTM" | approve | completed | Yes |
| "reject" or "- [ ]" | reject | in_progress | No |
| "dispute" | dispute | disputed | No |
| "skip" | skip | skipped | Yes |
| Unclear | ambiguous | review | No |

---

## Configuration

Add to `.steroids/config.yaml`:

```yaml
ai:
  orchestrator:
    provider: anthropic
    model: claude-3-5-haiku-20241022  # Fast + cheap
    temperature: 0.1  # Consistent structured output
```

Or use GPT-4o-mini for even lower cost:

```yaml
ai:
  orchestrator:
    provider: openai
    model: gpt-4o-mini
    temperature: 0.1
```

---

## Testing

```bash
# Unit tests for JSON parsing
npm test -- orchestrator

# Integration test: run loop with orchestrator
steroids loop --once

# Check orchestrator decisions in audit log
sqlite3 .steroids/steroids.db "SELECT * FROM audit_log WHERE actor LIKE 'orchestrator%' ORDER BY created_at DESC LIMIT 10"
```

---

## Debugging

### View Raw Orchestrator Output

```typescript
const result = await invokeCoderOrchestrator(prompt, projectPath);
console.log('Orchestrator raw output:', result);
```

### Log All Decisions

```typescript
function logOrchestratorDecision(decision: any) {
  const logPath = join(projectPath, '.steroids', 'orchestrator.log');
  appendFileSync(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    decision,
  }) + '\n');
}
```

### Override Orchestrator Decision

```typescript
// For debugging, manually override
if (process.env.FORCE_CODER_ACTION) {
  decision.action = process.env.FORCE_CODER_ACTION as any;
  decision.confidence = 1.0;
  console.warn('OVERRIDING orchestrator decision:', decision.action);
}
```

---

## Cost Tracking

```typescript
// Track tokens and cost per orchestrator call
interface OrchestratorCost {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

function trackCost(result: any, model: string): OrchestratorCost {
  const inputTokens = estimateTokens(prompt); // ~4000
  const outputTokens = estimateTokens(result.stdout); // ~150

  const costs = {
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 }, // per 1M tokens
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
  };

  const rate = costs[model] || costs['claude-3-5-haiku-20241022'];
  const cost = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

  return { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: cost };
}
```

---

## Troubleshooting

### Problem: Orchestrator returns invalid JSON

**Solution:**
```typescript
try {
  return JSON.parse(cleaned);
} catch (error) {
  console.error('Invalid JSON, trying fallback extraction');
  // Use regex to extract action/decision
  const actionMatch = output.match(/"action":\s*"(\w+)"/);
  return {
    action: actionMatch?.[1] || 'retry',
    reasoning: 'Failed to parse JSON',
    next_status: 'in_progress',
    confidence: 0.30,
  };
}
```

### Problem: Orchestrator is too slow

**Solution:**
```yaml
# Use faster model
orchestrator:
  model: gpt-4o-mini  # ~3-5 seconds
  timeout: 15_000     # 15 second timeout
```

### Problem: Low confidence on most decisions

**Solution:**
- Add more explicit decision rules to prompt
- Include more examples in few-shot section
- Use a more capable model (Haiku → Sonnet)

### Problem: Orchestrator disagrees with human judgment

**Solution:**
```typescript
// Log disagreements for analysis
if (orchestratorDecision !== humanDecision) {
  logDisagreement({
    task_id: task.id,
    orchestrator: orchestratorDecision,
    human: humanDecision,
    coder_output: coderResult.stdout,
    git_state: gitState,
  });
}

// Later: analyze logs and refine decision rules
```

---

## Migration Checklist

- [ ] Create `src/orchestrator/types.ts`
- [ ] Implement `invokeCoderOrchestrator()`
- [ ] Implement `invokeReviewerOrchestrator()`
- [ ] Add to `loop-phases.ts` after coder/reviewer
- [ ] Configure `ai.orchestrator` in config
- [ ] Test on 10 real tasks
- [ ] Measure: accuracy, confidence distribution, latency
- [ ] Compare orchestrator vs CLI command parsing
- [ ] If accuracy > 90%, make authoritative
- [ ] Remove CLI command instructions from prompts
- [ ] Monitor for 1 week
- [ ] Fine-tune decision rules based on errors

---

## Key Metrics to Watch

**Accuracy:**
- Target: >90% agreement with human judgment
- Measure: Review 50 orchestrator decisions, count correct ones

**Confidence:**
- Healthy: 60% high confidence (>0.9), 5% low (<0.5)
- Unhealthy: <40% high confidence, >15% low confidence

**Latency:**
- Target: <10 seconds per orchestrator call
- Measure: Log duration, calculate p50/p95/p99

**Cost:**
- Target: <5% of total AI cost per task
- Measure: Track tokens, multiply by model pricing

**Parsing:**
- Target: >95% valid JSON output
- Measure: Count JSON.parse() failures vs total calls

---

## Quick Reference: Full Prompt Locations

Full prompts are in `ORCHESTRATOR_PROMPTS.md`:
- Coder orchestrator: Section "Orchestrator 1: Analyze Coder Output"
- Reviewer orchestrator: Section "Orchestrator 2: Analyze Reviewer Output"

Implementation examples in `ORCHESTRATOR_IMPLEMENTATION.md`:
- Type definitions
- Prompt generation functions
- JSON parsing with fallbacks
- Loop integration code

---

## One-Liner Commands

```bash
# View orchestrator decisions
sqlite3 .steroids/steroids.db "SELECT task_id, actor, notes FROM audit_log WHERE actor LIKE 'orchestrator%'"

# Count decision types
sqlite3 .steroids/steroids.db "SELECT json_extract(notes, '$.decision'), COUNT(*) FROM audit_log WHERE actor='orchestrator:reviewer' GROUP BY 1"

# Average confidence
sqlite3 .steroids/steroids.db "SELECT AVG(CAST(json_extract(notes, '$.confidence') AS REAL)) FROM audit_log WHERE actor LIKE 'orchestrator%'"

# Find low confidence decisions
sqlite3 .steroids/steroids.db "SELECT task_id, json_extract(notes, '$.confidence'), json_extract(notes, '$.decision') FROM audit_log WHERE actor LIKE 'orchestrator%' AND CAST(json_extract(notes, '$.confidence') AS REAL) < 0.5"
```

---

## Resources

- **Full Design:** `ORCHESTRATOR_SUMMARY.md`
- **Prompts:** `ORCHESTRATOR_PROMPTS.md`
- **Code Examples:** `ORCHESTRATOR_IMPLEMENTATION.md`
- **This Guide:** `ORCHESTRATOR_QUICK_START.md`

---

**Last Updated:** 2026-02-09
**Estimated Implementation Time:** 1-2 days for basic version, 1 week to production-ready
