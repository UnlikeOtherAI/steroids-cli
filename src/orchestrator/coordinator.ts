/**
 * Coordinator intervention
 * Steps in after repeated rejections to break deadlocks
 * Uses the orchestrator AI config to analyze rejection patterns
 * and provide actionable guidance to the coder
 */

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, RejectionEntry } from '../database/queries.js';
import { loadConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import { logInvocation } from '../providers/invocation-logger.js';
import { getAgentsMd, getSourceFileReference } from '../prompts/prompt-helpers.js';

export interface CoordinatorContext {
  sectionTasks?: { id: string; title: string; status: string }[];
  submissionNotes?: string | null;
  gitDiffSummary?: string;
  previousGuidance?: string;  // Previous coordinator guidance to avoid repeating itself
  lockedMustImplementGuidance?: string;  // Non-negotiable override guidance from orchestrator
  lockedMustImplementWatermark?: number; // Rejection count where override was created
}

export interface CoordinatorResult {
  success: boolean;
  guidance: string;
  decision: 'guide_coder' | 'override_reviewer' | 'narrow_scope';
}

/**
 * Generate the coordinator prompt
 * The coordinator reviews rejection history and MUST provide a path forward
 * Gets full project context: architecture, spec, and user-facing perspective
 */
function generateCoordinatorPrompt(
  task: Task,
  rejectionHistory: RejectionEntry[],
  projectPath: string,
  extra?: CoordinatorContext
): string {
  const rejectionSummary = rejectionHistory.map(r =>
    `### Rejection #${r.rejection_number}
${r.notes || '(no notes)'}
`
  ).join('\n---\n');

  // Pull in project context so coordinator understands the bigger picture
  const agentsMd = getAgentsMd(projectPath);
  const specRef = getSourceFileReference(projectPath, task.source_file);

  // Build optional context sections
  const sectionTasksSection = extra?.sectionTasks && extra.sectionTasks.length > 1
    ? `
---

## Other Tasks in This Section

This task is part of a group. Other tasks handle related work - don't demand this task does their job:
${extra.sectionTasks.filter(t => t.id !== task.id).map(t => `- [${t.status}] ${t.title}`).join('\n')}
`
    : '';

  const submissionNotesSection = extra?.submissionNotes
    ? `
---

## Coder's Latest Submission Notes

> ${extra.submissionNotes}
`
    : '';

  const diffSection = extra?.gitDiffSummary
    ? `
---

## What The Coder Actually Changed (Latest Attempt)

\`\`\`
${extra.gitDiffSummary}
\`\`\`
`
    : '';

  // Previous coordinator guidance section (prevents repeating itself)
  const previousGuidanceSection = extra?.previousGuidance
    ? `
---

## Your Previous Guidance

You previously provided this guidance for this task:

> ${extra.previousGuidance.substring(0, 500)}${extra.previousGuidance.length > 500 ? '...' : ''}

**Do NOT repeat the same guidance.** If the previous guidance didn't work, provide a DIFFERENT approach.
`
    : '';

  const lockedMustImplementSection = extra?.lockedMustImplementGuidance
    ? `
---

## NON-NEGOTIABLE MUST_IMPLEMENT OVERRIDE

This guidance was set by the orchestrator after rejecting a weak WONT_FIX claim.
You MUST preserve these mandatory items in your guidance and you MAY add clarifications,
but you must NOT weaken, contradict, or remove them.

**Override watermark (rejection count):** ${extra.lockedMustImplementWatermark ?? 'unknown'}

${extra.lockedMustImplementGuidance}
`
    : '';

  return `# COORDINATOR INTERVENTION

You are a COORDINATOR in a fully automated task system with NO human in the loop.
A task has been rejected ${rejectionHistory.length} times. You MUST provide a decision that moves the task forward.

**Your job is to MAKE A DECISION, not to escalate.** There is no human to escalate to.

**IMPORTANT: Your guidance will be sent to BOTH the coder AND the reviewer.**
- The coder will use your guidance when implementing fixes
- The reviewer will see your guidance as CONTEXT only and still perform a full independent review

---

## Task Information

**Task ID:** ${task.id}
**Title:** ${task.title}
**Rejection Count:** ${task.rejection_count}/15
**Project:** ${projectPath}

---

## Task Specification (The Brief)

${specRef}

---

## Project Architecture & Best Practices

${agentsMd}

---

## Full Rejection History

${rejectionSummary}
${sectionTasksSection}${submissionNotesSection}${diffSection}${previousGuidanceSection}${lockedMustImplementSection}
---

## Your Decision Framework

When making your decision, always consider:

1. **Architecture** - Does the coder's approach follow the project's established patterns and best practices (see above)?
2. **The brief** - Does the implementation actually deliver what the specification asks for?
3. **User value** - Will this be usable and useful for the end user? Don't get bogged down in technical perfection at the expense of shipping.
4. **Scope** - Is the reviewer asking for things outside this single task's responsibility?

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
(Your specific guidance. This will be shown to BOTH the coder AND the reviewer. Be concrete:
- Which files to modify and what changes to make
- What reviewer feedback to address vs what to ignore
- If using override_reviewer: explicitly list which reviewer demands the coder should IGNORE
- If using narrow_scope: explicitly describe the NARROWED scope the reviewer should evaluate against
- If the reviewer demands global metrics, state clearly that this is out of scope
- If there's a design disagreement, pick the approach that best fits the project architecture
- Give the coder a clear path to get this task approved)

---

## Rules

- You MUST provide guidance that unblocks the task. "Try again" is not guidance.
- If the reviewer demands global project metrics from a single task, tell the coder to ignore that demand
- If there's a design disagreement, PICK the approach that matches the project's architecture and tell the coder to follow it
- If the same feedback appeared 3+ times unchanged, the coder needs a fundamentally different approach - describe it
- Always ask: "Will this be usable for the end user?" - if the current approach works for users, don't block on technicalities
- If NON-NEGOTIABLE MUST_IMPLEMENT override is present, you must keep those items mandatory
- Never tell the reviewer to auto-approve based on a fixed checklist (e.g., "these are the only items required for approval")
- Never claim reviewer guidance is binding over security, correctness, or specification requirements
- Keep guidance under 500 words
- Focus on UNBLOCKING while preserving review quality and safety
`;
}

/**
 * Parse the coordinator's response
 * Handles cases where guidance text may contain --- separators
 */
function parseCoordinatorResponse(output: string): CoordinatorResult {
  // Extract decision - look for valid decision values only
  const decisionMatch = output.match(/DECISION:\s*(guide_coder|override_reviewer|narrow_scope)/i);
  const rawDecision = decisionMatch?.[1]?.trim().toLowerCase();

  // Validate decision is one of the allowed values
  const validDecisions = ['guide_coder', 'override_reviewer', 'narrow_scope'] as const;
  const decision = validDecisions.includes(rawDecision as typeof validDecisions[number])
    ? rawDecision as CoordinatorResult['decision']
    : 'guide_coder';

  // Extract guidance - everything after "GUIDANCE:" until end of output
  // Use a greedy match since guidance is typically the last section
  const guidanceMatch = output.match(/GUIDANCE:\s*([\s\S]+)$/i);
  let guidance = guidanceMatch?.[1]?.trim() || output.trim();

  // Strip trailing section markers that might be from prompt template leaking
  guidance = guidance.replace(/\n## Rules[\s\S]*$/i, '').trim();

  return {
    success: true,
    guidance,
    decision,
  };
}

/**
 * Invoke the coordinator to analyze rejection patterns and provide guidance
 * Returns guidance string to inject into the coder prompt, or null if coordinator unavailable
 */
export async function invokeCoordinator(
  task: Task,
  rejectionHistory: RejectionEntry[],
  projectPath: string,
  extra?: CoordinatorContext
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

  const registry = await getProviderRegistry();
  const provider = registry.get(providerName);

  if (!(await provider.isAvailable())) {
    console.warn(`Coordinator provider '${providerName}' not available - skipping`);
    return null;
  }

  const prompt = generateCoordinatorPrompt(task, rejectionHistory, projectPath, extra);

  // Write prompt to temp file
  const tempPath = join(tmpdir(), `steroids-coordinator-${Date.now()}.txt`);
  writeFileSync(tempPath, prompt, 'utf-8');

  try {
    const result = await logInvocation(
      prompt,
      (ctx) =>
        provider.invoke(prompt, {
          model: modelName,
          timeout: 300_000, // 5 minutes for coordinator
          cwd: projectPath,
          promptFile: tempPath,
          role: 'orchestrator',
          streamOutput: false,
          onActivity: ctx?.onActivity,
        }),
      {
        role: 'orchestrator',
        provider: providerName,
        model: modelName,
        taskId: task.id,
        projectPath,
      }
    );

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
