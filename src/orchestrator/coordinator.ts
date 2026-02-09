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
  shouldDispute: boolean;
  disputeReason?: string;
}

/**
 * Generate the coordinator prompt
 * The coordinator reviews rejection history and provides guidance
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

You are a COORDINATOR in an automated task system. A task has been rejected ${rejectionHistory.length} times and needs your help to break a deadlock.

Your job is to:
1. Analyze WHY the rejections keep happening
2. Provide SPECIFIC, ACTIONABLE guidance to the coder
3. If the reviewer's demands are impossible or out of scope, recommend a dispute

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

Analyze the rejection history and answer these questions:

1. **Is there a pattern?** Are the same issues being raised repeatedly?
2. **Is the feedback achievable?** Can the coder actually do what the reviewer asks within this single task's scope?
3. **Is there a scope mismatch?** Is the reviewer demanding work outside this task's scope (e.g., global coverage, unrelated files)?
4. **Is there a design disagreement?** Are coder and reviewer operating on different architectural assumptions?

---

## Your Response Format

Respond with EXACTLY this format:

DISPUTE: yes/no
DISPUTE_REASON: (only if DISPUTE is yes) Brief reason for the dispute

GUIDANCE:
(Your specific guidance for the coder. Be concrete:
- Which files to modify
- What specific changes to make
- What NOT to do
- How to address the reviewer's actual concerns
- If some reviewer demands are out of scope, explain which ones to ignore)

---

## Rules

- Be SPECIFIC - don't just say "fix the issues", say exactly what to fix
- If the reviewer demands global project metrics from a single task, recommend DISPUTE
- If there's a design disagreement, provide a clear direction
- If the same feedback has appeared 3+ times unchanged, something is fundamentally wrong
- Keep your guidance under 500 words
- Focus on UNBLOCKING, not perfection
`;
}

/**
 * Parse the coordinator's response
 */
function parseCoordinatorResponse(output: string): CoordinatorResult {
  const shouldDispute = /DISPUTE:\s*yes/i.test(output);
  const disputeMatch = output.match(/DISPUTE_REASON:\s*(.+?)(?:\n|$)/i);
  const guidanceMatch = output.match(/GUIDANCE:\s*([\s\S]+?)(?:---|$)/i);

  const guidance = guidanceMatch?.[1]?.trim() || output.trim();

  return {
    success: true,
    guidance,
    shouldDispute,
    disputeReason: disputeMatch?.[1]?.trim(),
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
    console.log(`Should dispute: ${parsed.shouldDispute ? 'YES' : 'NO'}`);
    if (parsed.shouldDispute) {
      console.log(`Dispute reason: ${parsed.disputeReason}`);
    }
    console.log(`Guidance length: ${parsed.guidance.length} chars`);
    console.log(`${'='.repeat(60)}\n`);

    return parsed;
  } finally {
    if (existsSync(tempPath)) {
      unlinkSync(tempPath);
    }
  }
}
