/**
 * Coordinator intervention
 * Steps in after repeated rejections to break deadlocks
 * Uses the orchestrator AI config to analyze rejection patterns
 * and provide actionable guidance to the coder
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';

export interface CoordinatorResult {
  success: boolean;
  guidance: string;
  decision: 'guide_coder' | 'override_reviewer' | 'narrow_scope';
}

/**
 * Generate the coordinator prompt
 * The coordinator reviews rejection history and MUST provide a path forward
 */
function generateCoordinatorPrompt(
  task: Task,
  rejectionHistory: RejectionEntry[],
  projectPath: string
): string {
  const rejectionSummary = rejectionHistory.map(r =>
    `### Rejection #${r.rejection_number}
${r.notes || '(no notes)'}
`
  ).join('\n---\n');

  return `# COORDINATOR INTERVENTION

You are a COORDINATOR in a fully automated task system with NO human in the loop.
A task has been rejected ${rejectionHistory.length} times. You MUST provide a decision that moves the task forward.

**Your job is to MAKE A DECISION, not to escalate.** There is no human to escalate to.

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}

---

## Full Rejection History

${rejectionSummary}

---

## Your Analysis

1. **Is there a pattern?** Are the same issues raised repeatedly?
2. **Is the feedback achievable?** Can the coder do what the reviewer asks within THIS task's scope?
3. **Is there a scope mismatch?** Is the reviewer demanding work outside this task (e.g., global coverage)?
4. **Is there a design disagreement?** Different architectural assumptions?

---

## Your Response Format

DECISION: (one of: guide_coder | override_reviewer | narrow_scope)

- **guide_coder** - The reviewer is right but the coder needs clearer direction
- **override_reviewer** - The reviewer is asking for something out of scope or impossible; tell the coder what to ignore
- **narrow_scope** - Both have valid points; narrow the task scope to what's achievable

GUIDANCE:
(Your specific guidance for the coder. Be concrete:
- Which files to modify and what changes to make
- What reviewer feedback to address vs what to ignore
- If the reviewer demands global metrics, tell the coder to focus on task-scoped coverage only
- If there's a design disagreement, pick an approach and commit to it
- Give the coder a clear path to get this task approved)

---

## Rules

- You MUST provide guidance that unblocks the task. "Try again" is not guidance.
- If the reviewer demands global project metrics from a single task, tell the coder to ignore that demand
- If there's a design disagreement, PICK ONE APPROACH and tell the coder to follow it
- If the same feedback appeared 3+ times unchanged, the coder needs a fundamentally different approach - describe it
- Keep guidance under 500 words
- Focus on UNBLOCKING - the goal is to get this task approved on the next attempt
`;
}

/**
 * Parse the coordinator's response
 */
function parseCoordinatorResponse(output: string): CoordinatorResult {
  const guidanceMatch = output.match(/GUIDANCE:\s*([\s\S]+?)(?:---|$)/i);
  const decisionMatch = output.match(/DECISION:\s*(\w+)/i);

  const guidance = guidanceMatch?.[1]?.trim() || output.trim();
  const decision = decisionMatch?.[1]?.trim().toLowerCase() || 'guide_coder';

  return {
    success: true,
    guidance,
    decision: decision as CoordinatorResult['decision'],
  };
}

/**
 * Invoke the coordinator to analyze rejection patterns and provide guidance
 * Returns guidance string to inject into the coder prompt, or null if coordinator unavailable
 */
export async function invokeCoordinator(
  task: Task,
  rejectionHistory: RejectionEntry[],
  projectPath: string
): Promise<CoordinatorResult | null> {
  const config = loadConfig(projectPath);
  const orchestratorConfig = config.ai?.orchestrator;

  // If no orchestrator configured, fall back to reviewer config
  const providerName = orchestratorConfig?.provider || config.ai?.reviewer?.provider;
  const modelName = orchestratorConfig?.model || config.ai?.reviewer?.model;

  if (!providerName || !modelName) {
    console.warn('No orchestrator or reviewer AI configured - skipping coordinator intervention');
    return null;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`COORDINATOR: Analyzing rejections for "${task.title}"`);
  console.log(`Rejection count: ${task.rejection_count}`);
  console.log(`Provider: ${providerName} / ${modelName}`);
  console.log(`${'='.repeat(60)}\n`);

  const registry = getProviderRegistry();
  const provider = registry.get(providerName);

  if (!(await provider.isAvailable())) {
    console.warn(`Coordinator provider '${providerName}' not available - skipping`);
    return null;
  }

  const prompt = generateCoordinatorPrompt(task, rejectionHistory, projectPath);

  // Write prompt to temp file
  const tempPath = join(tmpdir(), `steroids-coordinator-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');

  try {
    const result = await provider.invoke(prompt, {
      model: modelName,
      timeout: 300_000, // 5 minutes for coordinator
      cwd: projectPath,
      promptFile: tempPath,
      role: 'orchestrator',
      streamOutput: false,
    });

    // Log the invocation
    logInvocation(prompt, result, {
      role: 'orchestrator',
      provider: providerName,
      model: modelName,
      taskId: task.id,
      projectPath,
    });

    if (!result.success) {
      console.warn('Coordinator invocation failed - continuing without guidance');
      return null;
    }

    const parsed = parseCoordinatorResponse(result.stdout);

    console.log(`\n${'='.repeat(60)}`);
    console.log('COORDINATOR RESULT');
    console.log(`Decision: ${parsed.decision}`);
    console.log(`Guidance length: ${parsed.guidance.length} chars`);
    console.log(`${'='.repeat(60)}\n`);

    return parsed;
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}
