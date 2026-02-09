# Orchestrator Implementation Guide

This document provides TypeScript implementation examples and integration patterns for the orchestrator prompts defined in `ORCHESTRATOR_PROMPTS.md`.

---

## Type Definitions

```typescript
// src/orchestrator/types.ts

/**
 * Input to the coder orchestrator
 */
export interface CoderAnalysisInput {
  task: {
    id: string;
    title: string;
    description: string;
    rejection_notes?: string;
  };
  coder_output: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    duration_ms: number;
  };
  git_state: {
    commits: Array<{ sha: string; message: string }>;
    files_changed: string[];
    has_uncommitted_changes: boolean;
    diff_summary: string;
  };
}

/**
 * Output from the coder orchestrator
 */
export interface CoderAnalysisOutput {
  action: 'submit' | 'retry' | 'stage_commit_submit' | 'error';
  reasoning: string;
  next_status: 'review' | 'in_progress' | 'failed';
  commit_message?: string;
  error_type?: 'timeout' | 'no_changes' | 'invalid_state';
  confidence: number;
}

/**
 * Input to the reviewer orchestrator
 */
export interface ReviewerAnalysisInput {
  task: {
    id: string;
    title: string;
    rejection_count: number;
  };
  reviewer_output: {
    stdout: string;
    stderr: string;
    exit_code: number;
    duration_ms: number;
  };
  git_context: {
    commit_being_reviewed: string;
    files_changed: string[];
  };
}

/**
 * Output from the reviewer orchestrator
 */
export interface ReviewerAnalysisOutput {
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'ambiguous';
  reasoning: string;
  feedback: string;
  next_status: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review';
  confidence: number;
  should_push: boolean;
}
```

---

## Prompt Generation Functions

```typescript
// src/orchestrator/coder-analyzer.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoderAnalysisInput, CoderAnalysisOutput } from './types.js';

/**
 * Generate the coder analysis prompt with actual input data
 */
export function generateCoderAnalysisPrompt(input: CoderAnalysisInput): string {
  // Load the template from ORCHESTRATOR_PROMPTS.md or inline it
  const template = readFileSync(
    join(__dirname, '../../ORCHESTRATOR_PROMPTS.md'),
    'utf-8'
  );

  // Extract the coder orchestrator section
  const coderSection = extractSection(template, 'Orchestrator 1: Analyze Coder Output');
  let prompt = extractPromptContent(coderSection);

  // Replace placeholders with actual values
  prompt = prompt.replace('{task.id}', input.task.id);
  prompt = prompt.replace('{task.title}', input.task.title);
  prompt = prompt.replace('{task.description}', input.task.description);

  // Conditional rejection notes
  if (input.task.rejection_notes) {
    prompt = prompt.replace(
      '{if rejection_notes}',
      '**Previous Rejection Notes:**\n' + input.task.rejection_notes + '\n'
    );
    prompt = prompt.replace('{endif}', '');
  } else {
    prompt = prompt.replace(/\{if rejection_notes\}[\s\S]*?\{endif\}/g, '');
  }

  // Coder output
  prompt = prompt.replace('{coder_output.exit_code}', String(input.coder_output.exit_code));
  prompt = prompt.replace('{coder_output.duration_ms}', String(input.coder_output.duration_ms));
  prompt = prompt.replace('{coder_output.timed_out}', String(input.coder_output.timed_out));
  prompt = prompt.replace('{coder_output.stdout}', input.coder_output.stdout || '(no output)');
  prompt = prompt.replace('{coder_output.stderr}', input.coder_output.stderr || '(no errors)');

  // Git state
  prompt = prompt.replace('{git_state.commits.length}', String(input.git_state.commits.length));

  // Replace commit loop
  const commitsList = input.git_state.commits.length > 0
    ? input.git_state.commits.map(c => `- ${c.sha.substring(0, 7)}: ${c.message}`).join('\n')
    : '(no commits created)';
  prompt = prompt.replace(/\{for commit in git_state\.commits\}[\s\S]*?\{endfor\}/g, commitsList);

  prompt = prompt.replace('{git_state.files_changed.length}', String(input.git_state.files_changed.length));

  // Replace files loop
  const filesList = input.git_state.files_changed.length > 0
    ? input.git_state.files_changed.map(f => `- ${f}`).join('\n')
    : '(no files changed)';
  prompt = prompt.replace(/\{for file in git_state\.files_changed\}[\s\S]*?\{endfor\}/g, filesList);

  prompt = prompt.replace('{git_state.has_uncommitted_changes}', String(input.git_state.has_uncommitted_changes));
  prompt = prompt.replace('{git_state.diff_summary}', input.git_state.diff_summary);

  return prompt;
}

/**
 * Parse coder orchestrator output
 */
export function parseCoderAnalysisOutput(output: string): CoderAnalysisOutput {
  // Strip markdown code fences if present
  let cleaned = output.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/, '');
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned) as CoderAnalysisOutput;

    // Validate required fields
    if (!parsed.action || !parsed.reasoning || !parsed.next_status) {
      throw new Error('Missing required fields: action, reasoning, or next_status');
    }

    // Validate action is one of the allowed values
    const validActions = ['submit', 'retry', 'stage_commit_submit', 'error'];
    if (!validActions.includes(parsed.action)) {
      throw new Error(`Invalid action: ${parsed.action}`);
    }

    // Validate next_status
    const validStatuses = ['review', 'in_progress', 'failed'];
    if (!validStatuses.includes(parsed.next_status)) {
      throw new Error(`Invalid next_status: ${parsed.next_status}`);
    }

    // Validate confidence
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
      console.warn(`Invalid confidence ${parsed.confidence}, defaulting to 0.50`);
      parsed.confidence = 0.50;
    }

    // Validate commit_message for stage_commit_submit
    if (parsed.action === 'stage_commit_submit' && !parsed.commit_message) {
      throw new Error('action is stage_commit_submit but commit_message is missing');
    }

    // Validate error_type for error action
    if (parsed.action === 'error' && !parsed.error_type) {
      console.warn('action is error but error_type is missing, defaulting to invalid_state');
      parsed.error_type = 'invalid_state';
    }

    return parsed;
  } catch (error) {
    console.error('Failed to parse coder orchestrator output:', error);
    console.error('Raw output:', output);

    // Fallback: try regex extraction
    return extractCoderDecisionFallback(output);
  }
}

/**
 * Fallback parser using regex when JSON parsing fails
 */
function extractCoderDecisionFallback(output: string): CoderAnalysisOutput {
  const actionMatch = output.match(/action["']?\s*:\s*["']?(submit|retry|stage_commit_submit|error)/i);
  const action = actionMatch?.[1] as CoderAnalysisOutput['action'] || 'retry';

  const reasoningMatch = output.match(/reasoning["']?\s*:\s*["']([^"']+)/i);
  const reasoning = reasoningMatch?.[1] || 'Failed to parse orchestrator output';

  return {
    action,
    reasoning,
    next_status: action === 'submit' || action === 'stage_commit_submit' ? 'review' : 'in_progress',
    confidence: 0.30, // Low confidence due to parsing failure
  };
}

// Helper functions
function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  let inSection = false;
  let sectionLines: string[] = [];
  let headerLevel = 0;

  for (const line of lines) {
    if (line.includes(heading)) {
      inSection = true;
      headerLevel = (line.match(/^#+/) || [''])[0].length;
      continue;
    }

    if (inSection) {
      // Stop at next section of same or higher level
      const currentHeaderLevel = (line.match(/^#+/) || [''])[0].length;
      if (currentHeaderLevel > 0 && currentHeaderLevel <= headerLevel) {
        break;
      }
      sectionLines.push(line);
    }
  }

  return sectionLines.join('\n');
}

function extractPromptContent(section: string): string {
  // Extract content between ### The Prompt and next heading
  const match = section.match(/### The Prompt\s*\n\s*```markdown\s*\n([\s\S]*?)\n```/);
  return match?.[1] || section;
}
```

---

## Reviewer Orchestrator Implementation

```typescript
// src/orchestrator/reviewer-analyzer.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReviewerAnalysisInput, ReviewerAnalysisOutput } from './types.js';

/**
 * Generate the reviewer analysis prompt with actual input data
 */
export function generateReviewerAnalysisPrompt(input: ReviewerAnalysisInput): string {
  const template = readFileSync(
    join(__dirname, '../../ORCHESTRATOR_PROMPTS.md'),
    'utf-8'
  );

  const reviewerSection = extractSection(template, 'Orchestrator 2: Analyze Reviewer Output');
  let prompt = extractPromptContent(reviewerSection);

  // Replace placeholders
  prompt = prompt.replace('{task.id}', input.task.id);
  prompt = prompt.replace('{task.title}', input.task.title);
  prompt = prompt.replace('{task.rejection_count}', String(input.task.rejection_count));

  prompt = prompt.replace('{reviewer_output.exit_code}', String(input.reviewer_output.exit_code));
  prompt = prompt.replace('{reviewer_output.duration_ms}', String(input.reviewer_output.duration_ms));
  prompt = prompt.replace('{reviewer_output.stdout}', input.reviewer_output.stdout || '(no output)');
  prompt = prompt.replace('{reviewer_output.stderr}', input.reviewer_output.stderr || '(no errors)');

  prompt = prompt.replace('{git_context.commit_being_reviewed}', input.git_context.commit_being_reviewed);
  prompt = prompt.replace('{git_context.files_changed.length}', String(input.git_context.files_changed.length));

  // Replace files loop
  const filesList = input.git_context.files_changed.length > 0
    ? input.git_context.files_changed.map(f => `- ${f}`).join('\n')
    : '(no files changed)';
  prompt = prompt.replace(/\{for file in git_context\.files_changed\}[\s\S]*?\{endfor\}/g, filesList);

  return prompt;
}

/**
 * Parse reviewer orchestrator output
 */
export function parseReviewerAnalysisOutput(output: string): ReviewerAnalysisOutput {
  let cleaned = output.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/\s*```$/, '');
  cleaned = cleaned.trim();

  try {
    const parsed = JSON.parse(cleaned) as ReviewerAnalysisOutput;

    // Validate required fields
    if (!parsed.decision || !parsed.reasoning || !parsed.next_status || typeof parsed.should_push !== 'boolean') {
      throw new Error('Missing required fields');
    }

    // Validate decision
    const validDecisions = ['approve', 'reject', 'dispute', 'skip', 'ambiguous'];
    if (!validDecisions.includes(parsed.decision)) {
      throw new Error(`Invalid decision: ${parsed.decision}`);
    }

    // Validate next_status
    const validStatuses = ['completed', 'in_progress', 'disputed', 'skipped', 'review'];
    if (!validStatuses.includes(parsed.next_status)) {
      throw new Error(`Invalid next_status: ${parsed.next_status}`);
    }

    // Validate confidence
    if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
      console.warn(`Invalid confidence ${parsed.confidence}, defaulting to 0.50`);
      parsed.confidence = 0.50;
    }

    // Default feedback to empty string if missing
    if (!parsed.feedback) {
      parsed.feedback = '';
    }

    return parsed;
  } catch (error) {
    console.error('Failed to parse reviewer orchestrator output:', error);
    console.error('Raw output:', output);

    return extractReviewerDecisionFallback(output);
  }
}

/**
 * Fallback parser for reviewer decisions
 */
function extractReviewerDecisionFallback(output: string): ReviewerAnalysisOutput {
  const decisionMatch = output.match(/decision["']?\s*:\s*["']?(approve|reject|dispute|skip|ambiguous)/i);
  const decision = decisionMatch?.[1] as ReviewerAnalysisOutput['decision'] || 'ambiguous';

  const reasoningMatch = output.match(/reasoning["']?\s*:\s*["']([^"']+)/i);
  const reasoning = reasoningMatch?.[1] || 'Failed to parse orchestrator output';

  return {
    decision,
    reasoning,
    feedback: '',
    next_status: decision === 'approve' ? 'completed' : decision === 'reject' ? 'in_progress' : 'review',
    confidence: 0.30,
    should_push: decision === 'approve' || decision === 'skip',
  };
}
```

---

## Integration with Loop

```typescript
// src/commands/loop-phases.ts (additions)

import { invokeCoderAnalyzer, invokeReviewerAnalyzer } from '../orchestrator/index.js';
import { getRecentCommits, hasUncommittedChanges, getDiffSummary } from '../git/status.js';

/**
 * Enhanced coder phase with orchestrator analysis
 */
export async function executeCoderPhase(
  task: Task,
  projectPath: string,
  coordinatorGuidance?: string
): Promise<void> {
  // 1. Invoke the coder (existing code)
  const coderResult = await invokeCoder(task, projectPath, 'start', coordinatorGuidance);

  // 2. Gather git state after coder finishes
  const gitState = {
    commits: getRecentCommits(projectPath, 5), // Last 5 commits
    files_changed: getModifiedFiles(projectPath),
    has_uncommitted_changes: hasUncommittedChanges(projectPath),
    diff_summary: getDiffSummary(projectPath),
  };

  // 3. Invoke coder orchestrator to analyze the result
  const analysisInput = {
    task: {
      id: task.id,
      title: task.title,
      description: task.source_file || task.title, // Use spec file as description
      rejection_notes: task.rejection_count > 0 ? getLatestRejectionNotes(task.id) : undefined,
    },
    coder_output: {
      stdout: coderResult.stdout,
      stderr: coderResult.stderr,
      exit_code: coderResult.exitCode,
      timed_out: coderResult.timedOut,
      duration_ms: coderResult.duration,
    },
    git_state: gitState,
  };

  const orchestratorResult = await invokeCoderAnalyzer(analysisInput);

  console.log(`\nOrchestrator Decision: ${orchestratorResult.action}`);
  console.log(`Reasoning: ${orchestratorResult.reasoning}`);
  console.log(`Confidence: ${(orchestratorResult.confidence * 100).toFixed(0)}%\n`);

  // 4. Take action based on orchestrator decision
  const { db, close } = openDatabase(projectPath);

  try {
    switch (orchestratorResult.action) {
      case 'submit':
        // Move to review
        updateTaskStatus(db, task.id, 'review', 'orchestrator:coder', orchestratorResult.reasoning);
        console.log(`Task ${task.id} moved to review`);
        break;

      case 'stage_commit_submit':
        // Auto-commit the changes
        console.log(`Auto-committing changes: ${orchestratorResult.commit_message}`);
        execSync(
          `git add -A && git commit -m "${orchestratorResult.commit_message}"`,
          { cwd: projectPath }
        );
        // Then move to review
        updateTaskStatus(db, task.id, 'review', 'orchestrator:coder', 'Auto-committed and submitted');
        console.log(`Task ${task.id} committed and moved to review`);
        break;

      case 'retry':
        // Keep in in_progress, will be picked up again
        updateTaskStatus(db, task.id, 'in_progress', 'orchestrator:coder', `Retrying: ${orchestratorResult.reasoning}`);
        console.log(`Task ${task.id} will retry`);
        break;

      case 'error':
        // Mark as failed
        updateTaskStatus(db, task.id, 'failed', 'orchestrator:coder', `Error: ${orchestratorResult.error_type} - ${orchestratorResult.reasoning}`);
        console.error(`Task ${task.id} marked as failed: ${orchestratorResult.error_type}`);
        break;
    }

    // Log orchestrator decision to audit trail
    logOrchestratorDecision(db, task.id, 'coder', orchestratorResult);
  } finally {
    close();
  }
}

/**
 * Enhanced reviewer phase with orchestrator analysis
 */
export async function executeReviewerPhase(
  task: Task,
  projectPath: string,
  coordinatorGuidance?: string,
  coordinatorDecision?: string
): Promise<void> {
  // 1. Invoke the reviewer (existing code)
  const reviewerResult = await invokeReviewer(task, projectPath, coordinatorGuidance, coordinatorDecision);

  // 2. Get git context
  const commitHash = findTaskCommit(projectPath, task.title) || 'HEAD';
  const filesChanged = getCommitFiles(projectPath, commitHash);

  // 3. Invoke reviewer orchestrator
  const analysisInput = {
    task: {
      id: task.id,
      title: task.title,
      rejection_count: task.rejection_count,
    },
    reviewer_output: {
      stdout: reviewerResult.stdout,
      stderr: reviewerResult.stderr,
      exit_code: reviewerResult.exitCode,
      duration_ms: reviewerResult.duration,
    },
    git_context: {
      commit_being_reviewed: commitHash,
      files_changed: filesChanged,
    },
  };

  const orchestratorResult = await invokeReviewerAnalyzer(analysisInput);

  console.log(`\nOrchestrator Decision: ${orchestratorResult.decision}`);
  console.log(`Reasoning: ${orchestratorResult.reasoning}`);
  console.log(`Confidence: ${(orchestratorResult.confidence * 100).toFixed(0)}%\n`);

  if (orchestratorResult.feedback) {
    console.log(`Feedback extracted:\n${orchestratorResult.feedback}\n`);
  }

  // 4. Take action based on decision
  const { db, close } = openDatabase(projectPath);

  try {
    switch (orchestratorResult.decision) {
      case 'approve':
        // Mark completed
        updateTaskStatus(db, task.id, 'completed', 'orchestrator:reviewer', orchestratorResult.feedback || 'Approved');
        console.log(`Task ${task.id} marked as completed`);

        // Push if should_push is true
        if (orchestratorResult.should_push) {
          console.log('Pushing to remote...');
          execSync('git push', { cwd: projectPath });
        }
        break;

      case 'reject':
        // Record rejection and move back to in_progress
        rejectTask(db, task.id, orchestratorResult.feedback, commitHash, 'orchestrator:reviewer');
        updateTaskStatus(db, task.id, 'in_progress', 'orchestrator:reviewer', 'Rejected by reviewer');
        console.log(`Task ${task.id} rejected (count: ${task.rejection_count + 1})`);
        break;

      case 'dispute':
        // Mark as disputed
        updateTaskStatus(db, task.id, 'disputed', 'orchestrator:reviewer', orchestratorResult.feedback);
        console.log(`Task ${task.id} marked as disputed`);
        // Could auto-create dispute record here
        break;

      case 'skip':
        // Mark as skipped
        const skipStatus = orchestratorResult.feedback.includes('partial') ? 'partial' : 'skipped';
        updateTaskStatus(db, task.id, skipStatus, 'orchestrator:reviewer', orchestratorResult.feedback);
        console.log(`Task ${task.id} marked as ${skipStatus}`);

        if (orchestratorResult.should_push) {
          console.log('Pushing skip commit to remote...');
          execSync('git push', { cwd: projectPath });
        }
        break;

      case 'ambiguous':
        // Stay in review, will be retried
        console.warn(`Ambiguous review decision (confidence: ${orchestratorResult.confidence})`);

        if (orchestratorResult.confidence < 0.50) {
          // Very low confidence - may need human intervention
          console.warn('Creating feedback task for human review');
          createTask(db, {
            title: `Review ambiguous decision for: ${task.title}`,
            status: 'pending',
            section_id: getFeedbackSectionId(db), // Special section for human review
          });
        }
        break;
    }

    // Log orchestrator decision
    logOrchestratorDecision(db, task.id, 'reviewer', orchestratorResult);
  } finally {
    close();
  }
}

/**
 * Log orchestrator decisions to audit trail
 */
function logOrchestratorDecision(
  db: Database.Database,
  taskId: string,
  role: 'coder' | 'reviewer',
  result: any
): void {
  const notes = JSON.stringify({
    orchestrator: role,
    decision: result.action || result.decision,
    reasoning: result.reasoning,
    confidence: result.confidence,
  });

  db.prepare(`
    INSERT INTO audit_log (task_id, from_status, to_status, actor, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(taskId, null, 'orchestrator_decision', `orchestrator:${role}`, notes);
}
```

---

## Testing Examples

```typescript
// tests/orchestrator/coder-analyzer.test.ts

import { describe, it, expect } from 'vitest';
import { parseCoderAnalysisOutput } from '../../src/orchestrator/coder-analyzer.js';

describe('Coder Orchestrator', () => {
  it('should parse happy path (explicit submit)', () => {
    const output = `{
      "action": "submit",
      "reasoning": "Coder completed work and created commit. Ready for review.",
      "next_status": "review",
      "confidence": 0.95
    }`;

    const result = parseCoderAnalysisOutput(output);
    expect(result.action).toBe('submit');
    expect(result.next_status).toBe('review');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('should parse auto-commit scenario', () => {
    const output = `{
      "action": "stage_commit_submit",
      "reasoning": "Work complete but not committed.",
      "next_status": "review",
      "commit_message": "fix: correct validation logic",
      "confidence": 0.82
    }`;

    const result = parseCoderAnalysisOutput(output);
    expect(result.action).toBe('stage_commit_submit');
    expect(result.commit_message).toBeDefined();
    expect(result.commit_message).toContain('fix:');
  });

  it('should parse timeout error', () => {
    const output = `{
      "action": "error",
      "reasoning": "Coder timed out with no progress.",
      "next_status": "failed",
      "error_type": "timeout",
      "confidence": 0.98
    }`;

    const result = parseCoderAnalysisOutput(output);
    expect(result.action).toBe('error');
    expect(result.error_type).toBe('timeout');
    expect(result.next_status).toBe('failed');
  });

  it('should handle malformed JSON gracefully', () => {
    const output = `This is not JSON at all but mentions action: submit somewhere`;

    const result = parseCoderAnalysisOutput(output);
    expect(result).toBeDefined();
    expect(result.confidence).toBeLessThan(0.5); // Low confidence fallback
  });
});
```

---

## Configuration

Add orchestrator config to `.steroids/config.yaml`:

```yaml
ai:
  orchestrator:
    provider: anthropic
    model: claude-3-5-haiku-20241022  # Fast, cheap model for JSON tasks
    temperature: 0.1  # Low temperature for consistent structured output

  coder:
    provider: anthropic
    model: claude-3-7-sonnet-20250219

  reviewer:
    provider: anthropic
    model: claude-3-7-sonnet-20250219
```

---

## Performance Optimizations

### 1. Caching Git State
```typescript
// Cache git state between coder and orchestrator to avoid duplicate calls
const gitStateCache = new Map<string, GitState>();

export function getGitStateWithCache(projectPath: string, taskId: string): GitState {
  const cacheKey = `${projectPath}:${taskId}`;
  if (gitStateCache.has(cacheKey)) {
    return gitStateCache.get(cacheKey)!;
  }

  const state = {
    commits: getRecentCommits(projectPath, 5),
    files_changed: getModifiedFiles(projectPath),
    has_uncommitted_changes: hasUncommittedChanges(projectPath),
    diff_summary: getDiffSummary(projectPath),
  };

  gitStateCache.set(cacheKey, state);
  return state;
}
```

### 2. Parallel Orchestration (Future Enhancement)
```typescript
// Run both orchestrators in parallel if you want consensus
const [coderAnalysis, coderAnalysisAlt] = await Promise.all([
  invokeCoderAnalyzer(input, 'claude-3-5-haiku'),
  invokeCoderAnalyzer(input, 'gpt-4o-mini'),
]);

// Use consensus or highest confidence
if (coderAnalysis.confidence >= coderAnalysisAlt.confidence) {
  return coderAnalysis;
} else {
  return coderAnalysisAlt;
}
```

### 3. Streaming for Large Outputs
```typescript
// If reviewer/coder outputs are huge, stream them to orchestrator
export async function invokeCoderAnalyzerStreaming(input: CoderAnalysisInput): Promise<CoderAnalysisOutput> {
  const prompt = generateCoderAnalysisPrompt(input);

  const provider = getProviderRegistry().get('anthropic');
  const stream = await provider.invokeStreaming(prompt, {
    model: 'claude-3-5-haiku-20241022',
    temperature: 0.1,
  });

  let jsonBuffer = '';
  for await (const chunk of stream) {
    jsonBuffer += chunk;
    // Try to parse as soon as we have complete JSON
    if (jsonBuffer.includes('}') && jsonBuffer.trim().endsWith('}')) {
      try {
        return parseCoderAnalysisOutput(jsonBuffer);
      } catch {
        // Not valid yet, keep buffering
      }
    }
  }

  return parseCoderAnalysisOutput(jsonBuffer);
}
```

---

## Migration Path

### Phase 1: Orchestrator Observes (No Action)
- Add orchestrator invocations to loop
- Log decisions to audit trail
- Compare orchestrator decisions with existing CLI-based decisions
- Measure accuracy and confidence distributions

### Phase 2: Orchestrator Advises
- Show orchestrator decision in loop output
- Keep existing CLI command parsing as primary
- Flag disagreements for human review

### Phase 3: Orchestrator Decides
- Make orchestrator decisions authoritative
- Remove CLI command parsing from coder/reviewer prompts
- Simplify prompts to focus on work, not status updates

### Phase 4: Optimize
- Switch to faster/cheaper models for orchestration
- Add consensus voting
- Implement confidence-based routing (high confidence → fast model, low → expensive model)

---

## Metrics to Track

```typescript
interface OrchestratorMetrics {
  total_invocations: number;
  decisions: Record<string, number>; // action/decision → count
  avg_confidence: number;
  parsing_failures: number;
  low_confidence_count: number; // confidence < 0.5
  decision_time_ms: number;
}

export function trackOrchestratorMetrics(
  role: 'coder' | 'reviewer',
  result: any,
  durationMs: number
): void {
  const { db, close } = openDatabase(process.cwd());

  db.prepare(`
    INSERT INTO orchestrator_metrics (role, decision, confidence, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    role,
    result.action || result.decision,
    result.confidence,
    durationMs,
    new Date().toISOString()
  );

  close();
}
```

Add to migration:
```sql
CREATE TABLE IF NOT EXISTS orchestrator_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL, -- 'coder' | 'reviewer'
  decision TEXT NOT NULL, -- action or decision value
  confidence REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE INDEX idx_orchestrator_metrics_role ON orchestrator_metrics(role);
CREATE INDEX idx_orchestrator_metrics_timestamp ON orchestrator_metrics(timestamp);
```

---

## Future Enhancements

### 1. Self-Learning Orchestrator
- Store human corrections when orchestrator is wrong
- Fine-tune model on (input, correct_decision) pairs
- Improve accuracy over time

### 2. Multi-Model Ensemble
- Run 3 orchestrators (Claude, GPT-4o, Gemini)
- Use voting or confidence weighting
- Fallback to most reliable model on disagreement

### 3. Confidence Calibration
- Track: predicted confidence vs actual accuracy
- Adjust confidence scores based on historical performance
- Route low-confidence decisions to human review

### 4. Contextual Orchestration
- Different prompts for different project types
- Adapt decision rules based on project complexity
- Learn project-specific patterns (e.g., "this reviewer always rejects on first pass")

### 5. Interactive Debugging
```bash
# View orchestrator decision for a task
steroids orchestrator explain <task-id>

# Re-run orchestrator with different model
steroids orchestrator reanalyze <task-id> --model gpt-4o

# Override orchestrator decision manually
steroids orchestrator override <task-id> --action submit --reason "Human override"
```
