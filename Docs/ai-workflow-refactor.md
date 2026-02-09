# AI Workflow Refactor: Orchestrator-Driven Architecture

**Date:** 2026-02-09
**Status:** Design Complete, Implementation Pending
**Version:** 1.0

---

## Executive Summary

We are refactoring from **model-driven** to **host-driven** state management. Instead of instructing AI agents (coder/reviewer) to run CLI commands, we now have a lightweight orchestrator analyze their output and make all workflow decisions.

**Problem:** LLMs forget to run status update commands, run them incorrectly, or commands fail → infinite loops, stuck tasks.

**Solution:** Remove CLI commands from prompts. Orchestrator reads agent output + git state → returns JSON decision → code executes it.

**Impact:**
- ✅ Reliability: 72% → 94% success rate (estimated)
- ✅ Debuggability: Clear decision audit trail
- ✅ Testability: Pure functions with deterministic logic
- ✅ Cost: <5% overhead (orchestrator is cheap + fast)

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Original Proposal](#original-proposal)
3. [Critical Feedback](#critical-feedback)
   - [Gemini's Analysis](#geminis-analysis)
   - [Codex's Analysis](#codexs-analysis)
   - [Claude's Analysis](#claudes-analysis)
4. [Consensus Design](#consensus-design)
5. [Orchestrator Prompts](#orchestrator-prompts)
   - [Post-Coder Orchestrator](#post-coder-orchestrator)
   - [Post-Reviewer Orchestrator](#post-reviewer-orchestrator)
6. [Implementation Guide](#implementation-guide)
7. [Decision Matrices](#decision-matrices)
8. [Fallback Strategies](#fallback-strategies)
9. [Migration Plan](#migration-plan)
10. [Testing Strategy](#testing-strategy)
11. [Open Questions](#open-questions)

---

## Problem Statement

### Current Architecture (Model-Driven)

```
Loop:
  1. Select task → Set status: in_progress
  2. Invoke Coder → Coder runs: steroids tasks update --status review
  3. Re-read task status → If changed, continue
  4. Invoke Reviewer → Reviewer runs: steroids tasks approve/reject
  5. Re-read task status → If changed, continue
```

### Issues with Current Approach

1. **LLM Forgets to Run Command**
   - Coder completes work but doesn't update status
   - Task stuck in `in_progress` → infinite loop
   - Recent fix: Auto-submit if status unchanged after coder

2. **LLM Runs Command Incorrectly**
   - Wrong syntax: `codex exec --prompt` instead of `cat prompt | codex exec -`
   - Wrong task ID: `steroids tasks update <wrong-id>`
   - Wrong arguments: `steroids tasks approve` without task ID
   - Result: 468+ failed invocations (actual incident in v0.4.56)

3. **Command Fails for Technical Reasons**
   - Missing permissions
   - Git repository check fails
   - Database locked
   - LLM may or may not recover

4. **No Validation Before Execution**
   - LLM can update status even if no work was done
   - Can approve without reviewing
   - Can reject without providing feedback

### Recent Band-Aid Fix (v0.4.60)

Added auto-submit in `loop-phases.ts`:
```typescript
// Re-read task to see if status was updated
const updatedTask = getTask(db, task.id);

// AUTO-SUBMIT: If coder finished but didn't update status
if (updatedTask.status === 'in_progress') {
  updateTaskStatus(db, updatedTask.id, 'review', 'orchestrator');
}
```

**Problem:** This is still model-driven! We're checking if LLM updated status and fixing it if they didn't. We haven't removed the dependency on LLM behavior.

---

## Original Proposal

### User's Insight

> "The coder and reviewer can have a lot on their plate. They can have a lot in that context. So that's why this should be the job for the orchestrator. The orchestrator will see the output from each and can decide what happened."

### Proposed Architecture

```
Loop:
  1. Select task → Set status: in_progress
  2. Invoke Coder (no CLI commands in prompt)
  3. Orchestrator analyzes coder output + git state → Decides action
  4. Orchestrator updates status directly
  5. If needs review → Invoke Reviewer (no CLI commands in prompt)
  6. Orchestrator analyzes reviewer output → Decides action
  7. Orchestrator updates status directly
```

### Key Changes

- **Coder prompt:** Remove all `steroids tasks update` commands
- **Reviewer prompt:** Remove all `steroids tasks approve/reject/dispute` commands
- **New orchestrator:** Lightweight AI that reads output and returns JSON decision
- **Orchestrator owns state:** Only orchestrator can update task status

### Benefits

- Small context for orchestrator (just output + git state, no full code)
- Precise prompt (analyze output → return JSON decision)
- Orchestrator can handle commits if coder forgot
- Single source of truth for status transitions
- Testable (mock outputs, verify decisions)

---

## Critical Feedback

We asked Gemini, Codex, and Claude to scrutinize the proposal. Here's what they found:

### Gemini's Analysis

#### ✅ What's Right
- Orchestrator should coordinate workflow
- Separating concerns is good architecture
- Coordinator intervention is clever

#### ❌ Critical Flaws

**1. Still Relying on LLM Compliance**

> "You're replacing structured data with unstructured parsing. Both rely on LLM behavior, but the second adds interpretation ambiguity."

Current problem:
```typescript
// LLM must remember to run this
steroids tasks update --status review
```

Proposed "solution":
```typescript
// Orchestrator must interpret this
orchestrator.parseOutput("I've completed the task and committed changes")
```

Both are fragile! We traded one LLM reliability problem for another.

**2. Output Parsing is Fragile**

Reviewer might say:
- "I approve this" ✅
- "APPROVE" ✅
- "Looks good to me" 🤔
- "I think we should approve, but..." 🤔
- "Great work but needs small changes" ❓

Pattern matching won't catch all these.

**3. Better Alternative: Structured Output**

```typescript
// Coder/reviewer output structured JSON
interface CoderResult {
  taskId: string;
  intent: 'submit_for_review' | 'blocked' | 'in_progress';
  evidence: {
    commits?: string[];
    notes?: string;
  };
}

// Orchestrator validates and applies
if (output.intent === 'submit_for_review' && hasCommits) {
  updateTaskStatus(taskId, 'review');
}
```

#### Recommended Architecture

1. **Structured output** (JSON) from coder/reviewer
2. **Orchestrator validates** intent against reality (git state)
3. **Robust fallback** to current behavior if JSON invalid
4. **Comprehensive audit logging** for all decisions
5. **Transaction safety** with rollback capability

---

### Codex's Analysis

#### Core Problem: Not Host-Driven Enough

> "Your proposal is 70% correct but 30% incomplete. You're still relying on LLM compliance for state management."

**The prompts STILL instruct LLMs to run CLI commands:**

**Coder prompt** (`coder.ts:158`):
```bash
steroids tasks update ${task.id} --status review
```

**Reviewer prompt** (`reviewer.ts:264`):
```bash
steroids tasks approve ${task.id} --model codex
```

This is model-driven, not host-driven.

#### What True Host-Driven Looks Like

**Coder prompt becomes:**
```
# Task: ${task.title}

Implement this task. When done:
1. Commit your changes with a descriptive message
2. Output "TASK COMPLETE" followed by a summary

DO NOT run any steroids commands. The orchestrator will handle status.
```

**Orchestrator after coder:**
```typescript
const result = await invokeCoder(task);

// Analyze what happened
const gitChanges = getGitChanges();
const coderSaidComplete = result.stdout.includes("TASK COMPLETE");
const hasCommit = gitChanges.commits.length > 0;

if (coderSaidComplete && hasCommit) {
  updateTaskStatus(db, task.id, 'review', 'orchestrator');
} else if (result.timedOut) {
  // Will retry
} else {
  // Incomplete - prompt coder to finish
}
```

#### Missing from Proposal

1. **No validation of artifacts**
   - Did commit actually include changes?
   - Are changed files relevant to task?
   - Is decision internally consistent?

2. **No error handling**
   - What if git operations fail?
   - What if LLM times out mid-execution?
   - What if orchestrator makes wrong decision?

3. **No transaction boundaries**
   - No rollback on failure
   - No optimistic locking
   - Race conditions possible

4. **Hard to test critical paths**
   - Need integration tests with mock LLM responses
   - Need chaos tests (network drops, disk full)

#### Recommendations

1. **Remove ALL CLI commands from prompts**
2. **Implement pure decision functions** (testable)
3. **Rule-based primary path** + LLM fallback for ambiguous cases
4. **Add transaction boundaries** with rollback
5. **Write exhaustive tests** for decision logic

---

### Claude's Analysis

#### Fundamental Design Flaw

> "You're trading one LLM reliability problem (forgetting commands) for another (ambiguous natural language)."

#### Edge Cases Missed

**Post-Coder:**
- Coder commits but doesn't indicate completion
- Multiple commits in one session
- Partial failures (commit succeeds, push fails)
- Empty commits (staged nothing)
- External changes between coder and orchestrator

**Post-Reviewer:**
- Reviewer provides mixed signals ("Great work but needs changes")
- Reviewer unclear or contradictory
- Multiple reviewers (batch mode)
- Reviewer disputes but orchestrator misreads as rejection
- Empty output (timeout, error)

#### Recommended JSON Schemas

**Coder Orchestration Result:**
```typescript
interface CoderOrchestrationResult {
  action: 'submit_to_review' | 'retry_coder' | 'commit_and_submit' | 'fail_task';
  explanation: string;
  next_task_status: 'review' | 'in_progress' | 'failed';
  artifacts?: {
    commits_detected: string[];
    files_modified: string[];
    changes_summary: string;
  };
  instructions?: {
    commit_message?: string;
    retry_reason?: string;
  };
  confidence: 'high' | 'medium' | 'low';
}
```

**Reviewer Orchestration Result:**
```typescript
interface ReviewerOrchestrationResult {
  decision: 'approve_task' | 'reject_to_coder' | 'dispute_task' | 'skip_task' | 'unclear_retry_review';
  explanation: string;
  feedback_for_coder?: string;
  next_task_status: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review';
  actions: {
    push_to_remote: boolean;
    notify_human: boolean;
  };
  confidence: 'high' | 'medium' | 'low';
}
```

#### Fallback Strategy

Multi-layer recovery:
1. **Try JSON.parse()** with schema validation
2. **Extract JSON from markdown** code blocks
3. **Find first `{` to last `}`** and parse
4. **Keyword analysis** for safe fallback
5. **Default to safe action** (retry/unclear)

---

## Consensus Design

All three agents converged on these principles:

### 1. Full Host-Driven Architecture

✅ **Do:**
- Remove ALL CLI commands from coder/reviewer prompts
- Orchestrator makes ALL status update decisions
- Agents produce artifacts (commits, analysis) only

❌ **Don't:**
- Instruct agents to run any `steroids` commands
- Let agents update task status directly
- Parse unstructured natural language

### 2. Structured JSON Output

✅ **Do:**
- Orchestrator returns valid JSON only
- Schema validation with cross-field rules
- Include confidence scores

❌ **Don't:**
- Allow markdown wrapping
- Accept natural language decisions
- Parse free-form text

### 3. Rule-Based + LLM Hybrid

**Primary Path (95% of cases):** Rule-based orchestrator
- Fast (no LLM call needed for most cases)
- Deterministic (testable)
- Cheap (no API cost)

**Fallback Path (5% of cases):** LLM-based orchestrator
- Handles ambiguous cases
- Small focused prompt
- Minimal context

### 4. Validation Layer

Before applying decisions:
- Verify commits are valid (not empty)
- Verify changed files match task scope
- Verify decisions are internally consistent
- Check for repeated patterns (death spirals)

### 5. Safety & Observability

- **Transaction boundaries** with rollback
- **Audit trail** for all orchestrator decisions
- **Monitoring** for accuracy and failures
- **Confidence scores** to flag uncertainty
- **Safe defaults** (retry > fail when uncertain)

---

## Orchestrator Prompts

### Post-Coder Orchestrator

**Purpose:** Analyze coder output and decide if work is ready for review.

#### Input Context

```typescript
interface CoderContext {
  task: {
    id: string;
    title: string;
    description: string;
    rejection_notes?: string;  // If retry after rejection
    rejection_count?: number;
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
    diff_summary: string;  // "+50 -20 lines across 3 files"
  };
}
```

#### Prompt Template

```markdown
# POST-CODER ORCHESTRATOR

You are a state machine that analyzes coder output and determines the next action.

**CRITICAL: You MUST respond ONLY with valid JSON. No markdown, no other text.**

---

## Task Context

**Task ID:** {{task.id}}
**Task Title:** {{task.title}}
**Task Status:** in_progress
{{#if rejection_notes}}
**Previous Rejection:** {{rejection_notes}}
**Rejection Count:** {{rejection_count}}
{{/if}}

---

## Coder Execution

**Exit Code:** {{exit_code}}
**Timed Out:** {{timed_out}}
**Duration:** {{duration_seconds}}s

**Output (last 2000 chars):**
```
{{stdout_tail}}
```

{{#if stderr}}
**Errors:**
```
{{stderr_tail}}
```
{{/if}}

---

## Git State

**Commits Made:** {{commits.length}}
{{#if commits.length > 0}}
{{#each commits}}
- {{sha}} - {{message}}
{{/each}}
{{/if}}

**Files Changed:** {{files_changed.length}}
{{#if files_changed.length > 0}}
{{#each files_changed}}
- {{this}}
{{/each}}
{{/if}}

**Uncommitted Changes:** {{has_uncommitted_changes}}

---

## Decision Rules

### 1. Error States
- Exit code non-zero + timeout → `error` (process killed)
- Exit code non-zero + no commits + no changes → `error` (failed to start)
- Stderr contains "fatal" / "Permission denied" → `error`

### 2. Incomplete Work
- Exit 0 but no commits and no changes → `retry` (did nothing)
- Timeout but has commits/changes → `stage_commit_submit` (save progress)
- Output contains "need more time" / "continuing" → `retry`

### 3. Completion Without Commit
- Exit 0 + uncommitted changes + completion signal → `stage_commit_submit`
- Look for: "changes ready", "implementation complete", "finished"

### 4. Normal Completion
- Exit 0 + commits exist → `submit`
- Most common happy path

### 5. Uncertainty Default
- When signals conflict → `retry` (safer than error)

---

## Output Format (JSON ONLY)

```json
{
  "action": "submit" | "retry" | "stage_commit_submit" | "error",
  "reasoning": "One sentence why (max 100 chars)",
  "commits": ["sha1", "sha2"],
  "commit_message": "Only if stage_commit_submit",
  "next_status": "review" | "in_progress" | "failed",
  "metadata": {
    "files_changed": 0,
    "confidence": "high" | "medium" | "low",
    "exit_clean": true,
    "has_commits": false
  }
}
```

### Field Rules

**action:**
- `submit` → Work complete, has commits, ready for review
- `retry` → Incomplete or unclear, run coder again
- `stage_commit_submit` → Work complete but not committed
- `error` → Fatal issue, needs human intervention

**next_status:**
- `review` for submit and stage_commit_submit
- `in_progress` for retry
- `failed` for error

**confidence:**
- `high` - Clear signals, obvious decision
- `medium` - Reasonable inference from context
- `low` - Uncertain, making best guess

---

## Examples

### Example 1: Normal Completion
```json
{
  "action": "submit",
  "reasoning": "Clean exit with 2 commits",
  "commits": ["abc123", "def456"],
  "commit_message": null,
  "next_status": "review",
  "metadata": {
    "files_changed": 3,
    "confidence": "high",
    "exit_clean": true,
    "has_commits": true
  }
}
```

### Example 2: Uncommitted Work
```json
{
  "action": "stage_commit_submit",
  "reasoning": "Work complete but not committed",
  "commits": [],
  "commit_message": "feat: implement task specification",
  "next_status": "review",
  "metadata": {
    "files_changed": 2,
    "confidence": "high",
    "exit_clean": true,
    "has_commits": false
  }
}
```

### Example 3: Timeout
```json
{
  "action": "retry",
  "reasoning": "Timeout with no output, retrying",
  "commits": [],
  "commit_message": null,
  "next_status": "in_progress",
  "metadata": {
    "files_changed": 0,
    "confidence": "high",
    "exit_clean": false,
    "has_commits": false
  }
}
```

---

Analyze the context above and respond with JSON:
```

---

### Post-Reviewer Orchestrator

**Purpose:** Analyze reviewer output and decide task outcome.

#### Input Context

```typescript
interface ReviewerContext {
  task: {
    id: string;
    title: string;
    rejection_count: number;
  };
  reviewer_output: {
    stdout: string;
    stderr: string;
    exit_code: number;
    timed_out: boolean;
    duration_ms: number;
  };
  git_context: {
    commit_sha: string;
    files_changed: string[];
    additions: number;
    deletions: number;
  };
}
```

#### Prompt Template

```markdown
# POST-REVIEWER ORCHESTRATOR

You are a state machine that analyzes reviewer output and determines the next action.

**CRITICAL: You MUST respond ONLY with valid JSON. No markdown, no other text.**

---

## Task Context

**Task ID:** {{task.id}}
**Task Title:** {{task.title}}
**Rejection Count:** {{rejection_count}}/15

---

## Reviewer Execution

**Exit Code:** {{exit_code}}
**Timed Out:** {{timed_out}}
**Duration:** {{duration_seconds}}s

**Output (last 2000 chars):**
```
{{stdout_tail}}
```

{{#if stderr}}
**Errors:**
```
{{stderr_tail}}
```
{{/if}}

---

## Git Diff

**Commit:** {{commit_sha}}
**Files Changed:** {{files_changed.length}}
**Lines:** +{{additions}} -{{deletions}}

---

## Decision Rules

### 1. Clear Approval
- Output contains "APPROVE" / "LGTM" / "looks good" → `approve`
- Exit 0 + positive language + no rejection phrases → `approve`

### 2. Clear Rejection
- Output contains "REJECT" / "needs work" / "issues found" → `reject`
- Output lists specific problems/feedback → `reject`

### 3. Dispute
- Output contains "DISPUTE" / "fundamental disagreement" → `dispute`
- Rejection count >= 10 AND same issue repeated → `dispute`
- Output mentions "out of scope" / "architectural disagreement" → `dispute`

### 4. Skip
- Output contains "SKIP" / "external setup required" → `skip`
- Output says "nothing to review" / "no code changes needed" → `skip`

### 5. Unclear
- Exit 0 but no clear decision words → `unclear`
- Timeout → `unclear`
- Stderr has errors → `unclear`

### 6. Rejection Threshold
- Rejection count = 15 → automatically `dispute` (prevent infinite loops)

---

## Output Format (JSON ONLY)

```json
{
  "decision": "approve" | "reject" | "dispute" | "skip" | "unclear",
  "reasoning": "One sentence why (max 100 chars)",
  "notes": "Feedback for coder (required if reject)",
  "next_status": "completed" | "in_progress" | "disputed" | "skipped" | "review",
  "metadata": {
    "rejection_count": 0,
    "confidence": "high" | "medium" | "low",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
```

### Field Rules

**decision:**
- `approve` → Work meets requirements, task complete
- `reject` → Issues found, send back to coder
- `dispute` → Fundamental disagreement or hit limit, needs human
- `skip` → Task requires external work, no code needed
- `unclear` → Couldn't determine decision, retry review

**next_status:**
- `completed` for approve
- `in_progress` for reject
- `disputed` for dispute
- `skipped` for skip
- `review` for unclear

**notes:** Required if reject (specific feedback for coder)

**metadata.push_to_remote:**
- `true` for approve, dispute, skip
- `false` for reject, unclear

---

## Examples

### Example 1: Approval
```json
{
  "decision": "approve",
  "reasoning": "Explicit approval signal",
  "notes": "Implementation meets all requirements",
  "next_status": "completed",
  "metadata": {
    "rejection_count": 0,
    "confidence": "high",
    "push_to_remote": true,
    "repeated_issue": false
  }
}
```

### Example 2: Rejection
```json
{
  "decision": "reject",
  "reasoning": "Specific issues identified",
  "notes": "1. Add error handling in parseConfig(). 2. Missing test for edge case. 3. Fix type error on line 42.",
  "next_status": "in_progress",
  "metadata": {
    "rejection_count": 1,
    "confidence": "high",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
```

### Example 3: Dispute (Repeated)
```json
{
  "decision": "dispute",
  "reasoning": "Same issue repeated 4 times, hitting limit",
  "notes": "Reviewer demanding global test coverage outside task scope. Human decision needed.",
  "next_status": "disputed",
  "metadata": {
    "rejection_count": 11,
    "confidence": "high",
    "push_to_remote": true,
    "repeated_issue": true
  }
}
```

### Example 4: Unclear
```json
{
  "decision": "unclear",
  "reasoning": "No decision statement in output",
  "notes": "Reviewer did not complete analysis",
  "next_status": "review",
  "metadata": {
    "rejection_count": 2,
    "confidence": "low",
    "push_to_remote": false,
    "repeated_issue": false
  }
}
```

---

Analyze the context above and respond with JSON:
```

---

## Implementation Guide

### File Structure

```
src/orchestrator/
├── post-coder.ts           # Coder orchestrator
├── post-reviewer.ts        # Reviewer orchestrator
├── schemas.ts              # JSON schemas for validation
├── fallback-handler.ts     # Handles invalid JSON
└── types.ts                # TypeScript interfaces

src/commands/
└── loop-phases.ts          # Update to use orchestrators

tests/orchestrator/
├── post-coder.test.ts
├── post-reviewer.test.ts
└── fallback.test.ts
```

### Core Implementation

#### 1. TypeScript Interfaces

```typescript
// src/orchestrator/types.ts

export interface CoderOrchestrationResult {
  action: 'submit' | 'retry' | 'stage_commit_submit' | 'error';
  reasoning: string;
  commits: string[];
  commit_message?: string;
  next_status: 'review' | 'in_progress' | 'failed';
  metadata: {
    files_changed: number;
    confidence: 'high' | 'medium' | 'low';
    exit_clean: boolean;
    has_commits: boolean;
  };
}

export interface ReviewerOrchestrationResult {
  decision: 'approve' | 'reject' | 'dispute' | 'skip' | 'unclear';
  reasoning: string;
  notes: string;
  next_status: 'completed' | 'in_progress' | 'disputed' | 'skipped' | 'review';
  metadata: {
    rejection_count: number;
    confidence: 'high' | 'medium' | 'low';
    push_to_remote: boolean;
    repeated_issue: boolean;
  };
}
```

#### 2. Schema Validation

```typescript
// src/orchestrator/schemas.ts

import Ajv from 'ajv';

const coderSchema = {
  type: 'object',
  required: ['action', 'reasoning', 'next_status', 'metadata'],
  properties: {
    action: {
      type: 'string',
      enum: ['submit', 'retry', 'stage_commit_submit', 'error']
    },
    reasoning: { type: 'string', minLength: 10, maxLength: 200 },
    commits: { type: 'array', items: { type: 'string' } },
    commit_message: { type: 'string', maxLength: 200 },
    next_status: {
      type: 'string',
      enum: ['review', 'in_progress', 'failed']
    },
    metadata: {
      type: 'object',
      required: ['files_changed', 'confidence', 'exit_clean', 'has_commits'],
      properties: {
        files_changed: { type: 'number', minimum: 0 },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        exit_clean: { type: 'boolean' },
        has_commits: { type: 'boolean' }
      }
    }
  }
};

const reviewerSchema = {
  type: 'object',
  required: ['decision', 'reasoning', 'next_status', 'metadata'],
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'reject', 'dispute', 'skip', 'unclear']
    },
    reasoning: { type: 'string', minLength: 10, maxLength: 200 },
    notes: { type: 'string', maxLength: 1000 },
    next_status: {
      type: 'string',
      enum: ['completed', 'in_progress', 'disputed', 'skipped', 'review']
    },
    metadata: {
      type: 'object',
      required: ['rejection_count', 'confidence', 'push_to_remote'],
      properties: {
        rejection_count: { type: 'number', minimum: 0 },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        push_to_remote: { type: 'boolean' },
        repeated_issue: { type: 'boolean' }
      }
    }
  }
};

const ajv = new Ajv();
export const validateCoderResult = ajv.compile(coderSchema);
export const validateReviewerResult = ajv.compile(reviewerSchema);
```

#### 3. Fallback Handler

```typescript
// src/orchestrator/fallback-handler.ts

export class OrchestrationFallbackHandler {
  parseCoderOutput(rawOutput: string): CoderOrchestrationResult {
    // 1. Try JSON.parse
    try {
      const parsed = JSON.parse(rawOutput);
      if (validateCoderResult(parsed)) {
        return parsed;
      }
    } catch {}

    // 2. Extract from markdown
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock[1]);
        if (validateCoderResult(parsed)) return parsed;
      } catch {}
    }

    // 3. Keyword fallback
    return this.keywordFallbackCoder(rawOutput);
  }

  private keywordFallbackCoder(output: string): CoderOrchestrationResult {
    const lower = output.toLowerCase();

    if (/timeout|timed out/.test(lower)) {
      return {
        action: 'retry',
        reasoning: 'FALLBACK: Detected timeout',
        commits: [],
        next_status: 'in_progress',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: false,
          has_commits: false
        }
      };
    }

    if (/commit|committed/.test(lower) && !/error|failed/.test(lower)) {
      return {
        action: 'submit',
        reasoning: 'FALLBACK: Detected commit keywords',
        commits: [],
        next_status: 'review',
        metadata: {
          files_changed: 0,
          confidence: 'low',
          exit_clean: true,
          has_commits: false
        }
      };
    }

    // Safe default: retry
    return {
      action: 'retry',
      reasoning: 'FALLBACK: Orchestrator failed, defaulting to retry',
      commits: [],
      next_status: 'in_progress',
      metadata: {
        files_changed: 0,
        confidence: 'low',
        exit_clean: true,
        has_commits: false
      }
    };
  }

  parseReviewerOutput(rawOutput: string): ReviewerOrchestrationResult {
    // Similar structure to parseCoderOutput
    try {
      const parsed = JSON.parse(rawOutput);
      if (validateReviewerResult(parsed)) return parsed;
    } catch {}

    // Fallback logic for reviewer
    return this.keywordFallbackReviewer(rawOutput);
  }

  private keywordFallbackReviewer(output: string): ReviewerOrchestrationResult {
    const lower = output.toLowerCase();

    if (/(lgtm|approve|looks good)/.test(lower) && !/reject|issues/.test(lower)) {
      return {
        decision: 'approve',
        reasoning: 'FALLBACK: Detected approval keywords',
        notes: 'Approved based on keyword detection',
        next_status: 'completed',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: true,
          repeated_issue: false
        }
      };
    }

    if (/reject|issues|needs work/.test(lower)) {
      return {
        decision: 'reject',
        reasoning: 'FALLBACK: Detected rejection keywords',
        notes: 'Rejected - see full reviewer output for details',
        next_status: 'in_progress',
        metadata: {
          rejection_count: 0,
          confidence: 'low',
          push_to_remote: false,
          repeated_issue: false
        }
      };
    }

    // Safe default: unclear
    return {
      decision: 'unclear',
      reasoning: 'FALLBACK: Orchestrator failed, retrying review',
      notes: 'Review unclear, retrying',
      next_status: 'review',
      metadata: {
        rejection_count: 0,
        confidence: 'low',
        push_to_remote: false,
        repeated_issue: false
      }
    };
  }
}
```

#### 4. Loop Integration

```typescript
// src/commands/loop-phases.ts

import { OrchestrationFallbackHandler } from '../orchestrator/fallback-handler.js';

export async function runCoderPhase(
  db: Database,
  task: Task,
  projectPath: string,
  jsonMode = false
): Promise<void> {
  // 1. Invoke coder (no status update commands in prompt)
  const coderResult = await invokeCoder(task, projectPath);

  // 2. Gather git state
  const gitState = {
    commits: getRecentCommits(projectPath),
    files_changed: getChangedFiles(projectPath),
    has_uncommitted_changes: hasUncommittedChanges(projectPath),
    diff_summary: getDiffSummary(projectPath)
  };

  // 3. Invoke orchestrator
  const orchestratorOutput = await invokeCoderOrchestrator({
    task,
    coder_output: coderResult,
    git_state: gitState
  });

  // 4. Parse with fallback
  const handler = new OrchestrationFallbackHandler();
  const decision = handler.parseCoderOutput(orchestratorOutput);

  // 5. Execute decision
  switch (decision.action) {
    case 'submit':
      updateTaskStatus(db, task.id, 'review', 'orchestrator');
      if (!jsonMode) console.log('✓ Work complete, submitted to review');
      break;

    case 'stage_commit_submit':
      // Stage all changes
      execSync('git add -A', { cwd: projectPath });
      // Commit with orchestrator's message
      execSync(`git commit -m "${decision.commit_message}"`, { cwd: projectPath });
      updateTaskStatus(db, task.id, 'review', 'orchestrator');
      if (!jsonMode) console.log('✓ Auto-committed and submitted to review');
      break;

    case 'retry':
      if (!jsonMode) console.log('⟳ Retrying coder (incomplete work)');
      break;

    case 'error':
      updateTaskStatus(db, task.id, 'failed', 'orchestrator');
      if (!jsonMode) console.log('✗ Task failed, needs human intervention');
      break;
  }

  // 6. Log decision for audit
  logOrchestrationDecision(db, task.id, 'coder', decision);
}

export async function runReviewerPhase(
  db: Database,
  task: Task,
  projectPath: string,
  jsonMode = false
): Promise<void> {
  // Similar structure to runCoderPhase
  const reviewerResult = await invokeReviewer(task, projectPath);

  const gitContext = {
    commit_sha: getCurrentCommitSha(projectPath),
    files_changed: getChangedFiles(projectPath),
    additions: getDiffAdditions(projectPath),
    deletions: getDiffDeletions(projectPath)
  };

  const orchestratorOutput = await invokeReviewerOrchestrator({
    task,
    reviewer_output: reviewerResult,
    git_context: gitContext
  });

  const handler = new OrchestrationFallbackHandler();
  const decision = handler.parseReviewerOutput(orchestratorOutput);

  switch (decision.decision) {
    case 'approve':
      approveTask(db, task.id, 'orchestrator', decision.notes);
      pushToRemote(projectPath);
      if (!jsonMode) console.log('✓ Task approved');
      break;

    case 'reject':
      rejectTask(db, task.id, 'orchestrator', decision.notes);
      if (!jsonMode) console.log('✗ Task rejected, returning to coder');
      break;

    case 'dispute':
      updateTaskStatus(db, task.id, 'disputed', 'orchestrator', decision.notes);
      if (!jsonMode) console.log('! Task disputed, needs human intervention');
      break;

    case 'skip':
      updateTaskStatus(db, task.id, 'skipped', 'orchestrator', decision.notes);
      if (!jsonMode) console.log('⏭ Task skipped');
      break;

    case 'unclear':
      if (!jsonMode) console.log('? Review unclear, retrying');
      break;
  }

  logOrchestrationDecision(db, task.id, 'reviewer', decision);
}
```

---

## Decision Matrices

### Post-Coder Decision Matrix

| Exit Code | Commits | Uncommitted | Output Signal | Action | Next Status | Confidence |
|-----------|---------|-------------|---------------|--------|-------------|------------|
| 0 | ✅ | ❌ | "complete" | `submit` | `review` | high |
| 0 | ✅ | ✅ | "complete" | `submit` | `review` | high |
| 0 | ❌ | ✅ | "complete" | `stage_commit_submit` | `review` | high |
| 0 | ❌ | ❌ | "complete" | `retry` | `in_progress` | low |
| 0 | ❌ | ❌ | unclear | `retry` | `in_progress` | medium |
| 124 (timeout) | ✅ | ❌ | any | `submit` | `review` | medium |
| 124 (timeout) | ❌ | ✅ | any | `stage_commit_submit` | `review` | medium |
| 124 (timeout) | ❌ | ❌ | any | `retry` | `in_progress` | high |
| ≠0 | ❌ | ❌ | error | `error` | `failed` | high |
| ≠0 | ✅ | any | any | `submit` | `review` | low |

### Post-Reviewer Decision Matrix

| Rejection Count | Output Signal | Feedback Quality | Decision | Next Status | Push | Confidence |
|-----------------|---------------|------------------|----------|-------------|------|------------|
| 0-9 | "APPROVE" | any | `approve` | `completed` | ✅ | high |
| 0-9 | "REJECT" | specific | `reject` | `in_progress` | ❌ | high |
| 0-9 | "REJECT" | vague | `unclear` | `review` | ❌ | low |
| 10-14 | "REJECT" | same as before | `dispute` | `disputed` | ❌ | high |
| 10-14 | "REJECT" | new issue | `reject` | `in_progress` | ❌ | medium |
| 15 | any | any | `dispute` | `disputed` | ❌ | high |
| any | "DISPUTE" | any | `dispute` | `disputed` | ❌ | high |
| any | "SKIP" | any | `skip` | `skipped` | ✅ | high |
| any | empty | any | `unclear` | `review` | ❌ | low |
| any | contradictory | any | `unclear` | `review` | ❌ | low |

---

## Fallback Strategies

### Multi-Layer Parsing

```typescript
function parseOrchestrationOutput(raw: string): Result {
  // Layer 1: Direct JSON parse
  try {
    const parsed = JSON.parse(raw);
    if (validate(parsed)) return parsed;
  } catch {}

  // Layer 2: Extract from markdown
  const match = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (validate(parsed)) return parsed;
    } catch {}
  }

  // Layer 3: Find first { to last }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try {
      const parsed = JSON.parse(raw.substring(start, end + 1));
      if (validate(parsed)) return parsed;
    } catch {}
  }

  // Layer 4: Keyword analysis
  return keywordFallback(raw);
}
```

### Confidence-Based Routing

```typescript
function shouldUseLLMOrchestrator(context: Context): boolean {
  // Calculate ambiguity score
  const score = calculateAmbiguity(context);

  // High ambiguity → use LLM
  if (score > 0.7) return true;

  // Special cases that need LLM
  if (context.rejection_count > 10) return true;
  if (context.output.length > 5000) return true;
  if (hasConflictingSignals(context)) return true;

  // Default: use rule-based
  return false;
}

async function orchestrate(context: Context): Promise<Decision> {
  if (shouldUseLLMOrchestrator(context)) {
    // LLM-based orchestrator for complex cases
    return await invokeLLMOrchestrator(context);
  } else {
    // Rule-based orchestrator for simple cases
    return ruleBasedOrchestrator(context);
  }
}
```

### Monitoring & Alerts

```typescript
class OrchestrationMonitor {
  private metrics = {
    total: 0,
    fallback_used: 0,
    low_confidence: 0,
    errors: 0
  };

  record(decision: Decision, usedFallback: boolean): void {
    this.metrics.total++;
    if (usedFallback) this.metrics.fallback_used++;
    if (decision.confidence === 'low') this.metrics.low_confidence++;

    // Alert if fallback rate too high
    const fallbackRate = this.metrics.fallback_used / this.metrics.total;
    if (fallbackRate > 0.1) {
      console.warn(`⚠️  High fallback rate: ${(fallbackRate * 100).toFixed(1)}%`);
    }

    // Alert if low confidence rate too high
    const lowConfidenceRate = this.metrics.low_confidence / this.metrics.total;
    if (lowConfidenceRate > 0.2) {
      console.warn(`⚠️  High low-confidence rate: ${(lowConfidenceRate * 100).toFixed(1)}%`);
    }
  }

  getMetrics() {
    return {
      ...this.metrics,
      fallback_rate: this.metrics.fallback_used / this.metrics.total,
      low_confidence_rate: this.metrics.low_confidence / this.metrics.total
    };
  }
}
```

---

## Migration Plan

### Phase 1: Observe (1-2 weeks)

**Goal:** Add orchestrators alongside existing logic, measure accuracy

**Changes:**
1. Implement orchestrator functions
2. Call orchestrators after coder/reviewer
3. Log decisions but DON'T apply them yet
4. Keep existing CLI command logic

**Validation:**
- Compare orchestrator decisions vs actual status changes
- Measure: accuracy, confidence distribution, fallback rate
- Build confidence in orchestrator reliability

**Success criteria:**
- Orchestrator accuracy >90%
- Fallback rate <10%
- Low confidence rate <20%

### Phase 2: Advise (1 week)

**Goal:** Show orchestrator decisions to user, keep existing logic

**Changes:**
1. Display orchestrator decision in CLI output
2. Show confidence and reasoning
3. Flag when orchestrator disagrees with LLM command

**Validation:**
- User reviews orchestrator decisions
- Identify patterns where orchestrator is wrong
- Refine prompts and rules

**Success criteria:**
- User trusts orchestrator decisions
- No major disagreements with expected behavior

### Phase 3: Decide (Breaking Change)

**Goal:** Make orchestrator authoritative, remove CLI commands

**Changes:**
1. Remove ALL `steroids tasks update/approve/reject` from prompts
2. Apply orchestrator decisions directly
3. Remove fallback to checking task status after agent runs

**Validation:**
- Run on test projects first
- Monitor for stuck tasks or wrong decisions
- Have manual override available

**Success criteria:**
- No tasks stuck in wrong state
- Rejection loops detected and resolved
- Task completion rate improves

### Phase 4: Optimize (Ongoing)

**Goal:** Reduce cost and latency

**Changes:**
1. Switch to cheaper models (Haiku, GPT-4o-mini)
2. Add rule-based fast path for obvious cases
3. Cache orchestrator decisions for similar contexts
4. Implement consensus voting (multiple models)

**Validation:**
- Measure cost per task
- Measure latency impact
- Maintain accuracy

**Success criteria:**
- Orchestrator cost <5% of total AI cost
- Latency <10s per orchestrator call
- Accuracy maintained or improved

---

## Testing Strategy

### Unit Tests

```typescript
// tests/orchestrator/post-coder.test.ts

describe('Post-Coder Orchestrator', () => {
  describe('Happy Path', () => {
    it('should submit when commits exist and clean exit', () => {
      const context = {
        coder_output: { exit_code: 0, stdout: 'Task complete' },
        git_state: { commits: ['abc123'], files_changed: ['src/file.ts'] }
      };
      const decision = ruleBasedCoderOrchestrator(context);
      expect(decision.action).toBe('submit');
      expect(decision.confidence).toBe('high');
    });
  });

  describe('Edge Cases', () => {
    it('should stage_commit_submit when changes not committed', () => {
      const context = {
        coder_output: { exit_code: 0, stdout: 'Implementation finished' },
        git_state: {
          commits: [],
          files_changed: ['src/file.ts'],
          has_uncommitted_changes: true
        }
      };
      const decision = ruleBasedCoderOrchestrator(context);
      expect(decision.action).toBe('stage_commit_submit');
      expect(decision.commit_message).toBeTruthy();
    });

    it('should retry on timeout with no work', () => {
      const context = {
        coder_output: { exit_code: 124, timed_out: true },
        git_state: { commits: [], files_changed: [] }
      };
      const decision = ruleBasedCoderOrchestrator(context);
      expect(decision.action).toBe('retry');
    });
  });

  describe('Error Handling', () => {
    it('should error on fatal git failure', () => {
      const context = {
        coder_output: {
          exit_code: 128,
          stderr: 'fatal: not a git repository'
        },
        git_state: { commits: [], files_changed: [] }
      };
      const decision = ruleBasedCoderOrchestrator(context);
      expect(decision.action).toBe('error');
    });
  });
});
```

### Integration Tests

```typescript
// tests/orchestrator/integration.test.ts

describe('Orchestrator Integration', () => {
  it('should handle full coder → reviewer flow', async () => {
    // 1. Run coder phase
    const coderDecision = await runCoderPhase(db, task, projectPath);
    expect(coderDecision.action).toBe('submit');

    // 2. Verify task status updated
    const updatedTask = getTask(db, task.id);
    expect(updatedTask.status).toBe('review');

    // 3. Run reviewer phase
    const reviewerDecision = await runReviewerPhase(db, updatedTask, projectPath);
    expect(reviewerDecision.decision).toBe('approve');

    // 4. Verify task completed
    const completedTask = getTask(db, task.id);
    expect(completedTask.status).toBe('completed');
  });

  it('should handle rejection loop with coordinator', async () => {
    // Simulate 3 rejection cycles
    for (let i = 0; i < 3; i++) {
      await runCoderPhase(db, task, projectPath);
      const reviewerDecision = await runReviewerPhase(db, task, projectPath);
      expect(reviewerDecision.decision).toBe('reject');
    }

    // 4th rejection should trigger coordinator
    const coordinatorResult = await runCoordinatorPhase(db, task, projectPath);
    expect(coordinatorResult).toBeTruthy();
  });
});
```

### Chaos Tests

```typescript
// tests/orchestrator/chaos.test.ts

describe('Orchestrator Chaos Tests', () => {
  it('should handle disk full during commit', async () => {
    // Mock execSync to throw ENOSPC error
    const originalExecSync = execSync;
    execSync = jest.fn(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    const decision = await runCoderPhase(db, task, projectPath);
    expect(decision.action).toBe('error');
    expect(decision.reasoning).toContain('disk');

    execSync = originalExecSync;
  });

  it('should handle network timeout during orchestrator call', async () => {
    // Mock provider to timeout
    const provider = getProviderRegistry().get('claude');
    provider.invoke = jest.fn(() => {
      throw new Error('ETIMEDOUT');
    });

    const decision = await runCoderPhase(db, task, projectPath);
    // Should fallback to safe default
    expect(decision.action).toBe('retry');
    expect(decision.confidence).toBe('low');
  });

  it('should handle corrupted git repository', async () => {
    // Corrupt .git directory
    execSync('echo "corrupted" > .git/HEAD', { cwd: projectPath });

    const decision = await runCoderPhase(db, task, projectPath);
    expect(decision.action).toBe('error');
  });
});
```

---

## Open Questions

### 1. Orchestrator Model Selection

**Question:** Which model should run the orchestrator?

**Options:**
- **Claude Haiku** ($0.80/$4.00 per MTok) - Fast, cheap, good for structured tasks
- **GPT-4o-mini** ($0.15/$0.60 per MTok) - Very cheap, adequate for simple decisions
- **Claude Sonnet** (current) - Overkill for orchestration, but most reliable

**Recommendation:** Start with Sonnet for accuracy, migrate to Haiku in Phase 4.

### 2. Rule-Based vs LLM Orchestrator

**Question:** When to use rule-based vs LLM-based orchestrator?

**Current thinking:**
- Rule-based for 95% of cases (fast, deterministic, cheap)
- LLM fallback for ambiguous cases (slow but handles complexity)

**Need to define:** What makes a case "ambiguous"?
- Output length >5000 chars?
- Rejection count >10?
- Conflicting signals (e.g., "good work but needs changes")?
- No clear completion signal?

### 3. Monitoring & Observability

**Question:** How do we track orchestrator accuracy in production?

**Metrics needed:**
- Decision accuracy (% correct)
- Fallback rate (% using keyword fallback)
- Low confidence rate (% with confidence=low)
- Average latency per orchestrator call
- Cost per task (orchestrator overhead)

**Validation:**
- Manual spot-checks on random tasks
- Compare human labels vs orchestrator decisions
- Track disputes (if orchestrator wrong, human fixes it)

### 4. Rollback Strategy

**Question:** What if orchestrator makes the wrong decision?

**Options:**
- Manual override: `steroids tasks update --force`
- Replay: Re-run orchestrator with updated prompt
- Human review: Flag low-confidence decisions for review

**Need:** Clear process for handling orchestrator errors.

### 5. Backward Compatibility

**Question:** Do old prompts need to work during migration?

**Answer:** Yes, during Phase 1 and 2. By Phase 3, all prompts updated.

**Migration:**
- Keep old prompts in `src/prompts/coder.ts.old`
- Update prompts gradually
- Add feature flag: `USE_ORCHESTRATOR=true|false`

---

## Conclusion

This refactor moves us from **model-driven** (hoping LLMs remember to run commands) to **host-driven** (orchestrator analyzes output and makes decisions) state management.

**Key takeaways:**
1. Remove ALL CLI commands from coder/reviewer prompts
2. Orchestrator returns structured JSON decisions
3. Rule-based primary path + LLM fallback for ambiguity
4. Multi-layer parsing with safe fallbacks
5. Comprehensive testing and monitoring
6. 4-phase migration to reduce risk

**Expected impact:**
- Reliability: 72% → 94% success rate
- Cost: <5% overhead (orchestrator is cheap)
- Debuggability: Clear audit trail of all decisions
- Testability: Pure functions, deterministic rules

**Next steps:**
1. Implement orchestrator functions (Phase 1)
2. Test on real tasks, measure accuracy
3. Refine prompts based on results
4. Deploy to production (Phase 3)

---

**Document version:** 1.0
**Last updated:** 2026-02-09
**Contributors:** Gemini, Codex, Claude (AI analysis), User (architecture vision)
