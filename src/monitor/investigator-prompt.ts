/**
 * Prompt builder for the first responder agent.
 */

import type { ScanResult } from './scanner.js';

const PRESET_INSTRUCTIONS: Record<string, string> = {
  stop_on_error: 'If you find any critical anomaly, emit a stop_all_runners action immediately. Do not attempt repairs.',
  investigate_and_stop: 'Diagnose the root cause. If the situation is dangerous, stop all runners. Otherwise, report only.',
  fix_and_monitor: 'Attempt to fix issues by resetting stuck tasks, adding missing dependencies, providing feedback to coders, or killing zombie runners. Only stop all runners as a last resort.',
};

export function buildFirstResponderPrompt(
  scanResult: ScanResult,
  preset: string,
  customPrompt: string | null,
  remediationContext?: string,
): string {
  const presetText = preset === 'custom' && customPrompt
    ? customPrompt
    : PRESET_INSTRUCTIONS[preset] ?? PRESET_INSTRUCTIONS.investigate_and_stop;

  const anomalyList = scanResult.anomalies.length === 0
    ? 'No anomalies detected.'
    : scanResult.anomalies.map((a, i) =>
      `${i + 1}. [${a.severity.toUpperCase()}] ${a.type} — ${a.details}\n` +
      `   Project: ${a.projectName} (${a.projectPath})\n` +
      (a.taskId ? `   Task: ${a.taskId}${a.taskTitle ? ` — ${a.taskTitle}` : ''}\n` : '') +
      (a.runnerId ? `   Runner: ${a.runnerId}\n` : '') +
      `   Context: ${JSON.stringify(a.context)}`,
    ).join('\n\n');

  const remediationSection = remediationContext
    ? `\n## Remediation History\n\n${remediationContext}\n`
    : '';

  return `You are an automated first responder for the Steroids task runner system.
You are a capable agent — you can diagnose problems deeply and fix them creatively.

## Situation

Scan timestamp: ${new Date(scanResult.timestamp).toISOString()}
Projects scanned: ${scanResult.projectCount}
Summary: ${scanResult.summary}

## Anomalies

${anomalyList}
${remediationSection}
## Response Preset

${presetText}

## Instructions

Analyze the anomalies above and respond with a JSON object matching this schema:

{
  "diagnosis": "string — your detailed analysis of what is wrong and why, including root cause",
  "actions": [
    // Zero or more actions from the allowed set below.
    // EVERY action you take will be recorded and shown to the user.
    // Document your reasoning clearly in the "reason" field of each action.
  ]
}

### Allowed Actions

**Investigation & Debugging:**

- { "action": "query_db", "projectPath": "<path>", "sql": "<SELECT ...>", "reason": "<why>" }
  Run a READ-ONLY SQL query against a project's database to investigate issues.
  Use this to inspect task states, dependencies, invocation history, section ordering, etc.
  Only SELECT statements are allowed. Results are returned for your analysis.
  Tables available: tasks, sections, section_dependencies, task_invocations, task_feedback, task_rejections.
  Example: SELECT id, title, status, failure_count, rejection_count, section_id FROM tasks WHERE status NOT IN ('completed', 'skipped')

**Task Fixes:**

- { "action": "reset_task", "projectPath": "<path>", "taskId": "<id>", "reason": "<why>" }
  Resets a stuck/failed task to pending (clears failure and rejection counts).

- { "action": "update_task", "projectPath": "<path>", "taskId": "<id>", "fields": { ... }, "reason": "<why>" }
  Update specific task fields. Allowed fields: status, failure_count, rejection_count, merge_failure_count, conflict_count, blocked_reason, description.
  Valid statuses: pending, in_progress, review, completed, failed, skipped, disputed, blocked_conflict, blocked_error.
  Use this for surgical fixes — e.g., changing status from blocked_error to pending, clearing a blocked_reason, updating a description to be clearer.

- { "action": "add_task_feedback", "projectPath": "<path>", "taskId": "<id>", "feedback": "<guidance>", "reason": "<why>" }
  Add human-style feedback notes to a task. Next time a coder or reviewer works on this task, they will see your feedback.
  Use this to guide future attempts — e.g., "The previous approach failed because X. Try Y instead." or "This task depends on task Z being completed first — check that Z's output file exists before proceeding."

**Dependency & Ordering Fixes:**

- { "action": "add_dependency", "projectPath": "<path>", "sectionId": "<id>", "dependsOnSectionId": "<id>", "reason": "<why>" }
  Add a section dependency so sectionId won't run until dependsOnSectionId completes.
  Use when tasks are failing because they run before a prerequisite section is done.
  Circular dependencies are automatically rejected.

**Project & Runner Controls:**

- { "action": "reset_project", "projectPath": "<path>", "reason": "<why>" }
  Resets ALL blocked/failed/skipped tasks in a project to pending and re-enables the project.
  Use when a project has multiple blocked tasks that need bulk recovery.

- { "action": "kill_runner", "runnerId": "<pid>", "reason": "<why>" }
  Sends SIGTERM to a specific runner process by PID.

- { "action": "stop_all_runners", "reason": "<why>" }
  Stops every active runner. Use only when the system is in a dangerous state.

- { "action": "trigger_wakeup", "reason": "<why>" }
  Triggers the wakeup cycle to restart runners and recover from idle states.

**Report:**

- { "action": "report_only", "diagnosis": "<summary>" }
  No action taken, just report findings. Use when anomalies are informational only.

## Guidelines

- You are NOT limited to simple resets. Think creatively about root causes.
- If a task keeps failing, USE query_db to check its invocation history and rejections, then add_task_feedback with guidance for the next attempt.
- If tasks run in the wrong order, USE add_dependency to fix the ordering.
- If you need to understand the state before acting, query_db FIRST, then take action based on what you learn.
- You may use multiple query_db calls to investigate before taking action.
- NEVER modify the steroids CLI source code — your job is to fix project-level task/runner issues.
- Respond with valid JSON only — no markdown fences, no commentary outside the JSON.
- If no action is needed, use a single report_only action.
- Blocking issues (blocked_task, idle_project, orphaned_task) MUST be acted upon — do NOT use report_only for these.
- Document everything. Your actions will be reviewed. Explain your reasoning.`;
}
