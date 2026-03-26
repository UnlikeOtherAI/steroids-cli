/**
 * Prompt builder for the first responder agent.
 */

import {
  getMonitorResponsePolicy,
  type FirstResponderActionName,
  type StoredMonitorResponsePreset,
} from './response-mode.js';
import type { ScanResult } from './scanner.js';

const PRESET_INSTRUCTIONS: Record<StoredMonitorResponsePreset, string> = {
  monitor_only: 'This mode is observation-only. Do not request any actions. Provide diagnosis only.',
  triage_only: 'Diagnose the root cause. Investigate with read-only queries when needed. Do not request mutating actions.',
  fix_and_monitor: 'Attempt to fix issues by resetting stuck tasks, adding missing dependencies, providing feedback to coders, or killing zombie runners. Only stop all runners as a last resort.',
  custom: 'Follow the custom instructions below while staying within the host-enforced action policy.',
  stop_on_error: 'Legacy mode: if the situation is dangerous, stop all runners immediately. Do not attempt other repairs.',
  investigate_and_stop: 'Legacy mode: diagnose the root cause. If the situation is dangerous, stop all runners. Otherwise, report only.',
};

interface ActionDoc {
  action: FirstResponderActionName;
  text: string;
}

const ACTION_DOCS: readonly ActionDoc[] = [
  {
    action: 'query_db',
    text: `**Investigation & Debugging:**

- { "action": "query_db", "projectPath": "<path>", "sql": "<SELECT ...>", "reason": "<why>" }
  Run a READ-ONLY SQL query against a project's database to investigate issues.
  Only SELECT statements are allowed.
  Tables available: tasks, sections, section_dependencies, task_invocations, task_feedback, task_rejections.`,
  },
  {
    action: 'reset_task',
    text: `**Task Fixes:**

- { "action": "reset_task", "projectPath": "<path>", "taskId": "<id>", "reason": "<why>" }
  Reset a stuck or failed task so it can run again.`,
  },
  {
    action: 'update_task',
    text: `- { "action": "update_task", "projectPath": "<path>", "taskId": "<id>", "fields": { ... }, "reason": "<why>" }
  Update specific task fields. Allowed fields: status, failure_count, rejection_count, merge_failure_count, conflict_count, blocked_reason, description, merge_phase, approved_sha, rebase_attempts.`,
  },
  {
    action: 'add_task_feedback',
    text: `- { "action": "add_task_feedback", "projectPath": "<path>", "taskId": "<id>", "feedback": "<guidance>", "reason": "<why>" }
  Add feedback that future coder or reviewer attempts will see.`,
  },
  {
    action: 'add_dependency',
    text: `**Dependency & Ordering Fixes:**

- { "action": "add_dependency", "projectPath": "<path>", "sectionId": "<id>", "dependsOnSectionId": "<id>", "reason": "<why>" }
  Add a section dependency so work runs in the correct order.`,
  },
  {
    action: 'reset_project',
    text: `**Project & Runner Controls:**

- { "action": "reset_project", "projectPath": "<path>", "reason": "<why>" }
  Reset all blocked or failed tasks in a project to pending.`,
  },
  {
    action: 'kill_runner',
    text: `- { "action": "kill_runner", "runnerId": "<pid>", "reason": "<why>" }
  Send SIGTERM to a specific runner process by PID.`,
  },
  {
    action: 'stop_all_runners',
    text: `- { "action": "stop_all_runners", "reason": "<why>" }
  Stop every active runner. Use only when the system is in a dangerous state.`,
  },
  {
    action: 'trigger_wakeup',
    text: `- { "action": "trigger_wakeup", "reason": "<why>" }
  Trigger the wakeup cycle to restart runners and recover from idle states.`,
  },
  {
    action: 'release_merge_lock',
    text: `**Merge Queue:**

- { "action": "release_merge_lock", "projectPath": "<path>", "diagnosis": "<why>" }
  Force-release a stale merge lock for a project.`,
  },
  {
    action: 'reset_merge_phase',
    text: `- { "action": "reset_merge_phase", "projectPath": "<path>", "taskId": "<id>", "diagnosis": "<why>" }
  Reset a stuck merge_pending task back to the queued phase.`,
  },
  {
    action: 'suppress_anomaly',
    text: `**Suppression:**

- { "action": "suppress_anomaly", "projectPath": "<path>", "anomalyType": "<type>", "duration_hours": <number>, "reason": "<why>" }
  Suppress a known false positive anomaly for the specified project and type (max 168 hours).`,
  },
  {
    action: 'report_only',
    text: `**Report:**

- { "action": "report_only", "diagnosis": "<summary>" }
  No action taken, just report findings.`,
  },
];

function buildAllowedActionsSection(preset: StoredMonitorResponsePreset): string {
  const policy = getMonitorResponsePolicy(preset);
  if (policy.allowedActions.size === 0) {
    return `No actions are allowed in this mode. Return an empty "actions" array.`;
  }

  return ACTION_DOCS
    .filter((doc) => policy.allowedActions.has(doc.action))
    .map((doc) => doc.text)
    .join('\n\n');
}

export function buildFirstResponderPrompt(
  scanResult: ScanResult,
  preset: StoredMonitorResponsePreset,
  customPrompt: string | null,
  remediationContext?: string,
): string {
  const policy = getMonitorResponsePolicy(preset);
  const presetText = preset === 'custom' && customPrompt
    ? customPrompt
    : PRESET_INSTRUCTIONS[preset];

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

Selected response mode: ${policy.label}
Host policy:
- Auto-dispatch allowed: ${policy.autoDispatch ? 'yes' : 'no'}
- Mutating actions allowed: ${policy.allowedActions.has('reset_task') ? 'yes' : 'no'}
- Fallback repair injection allowed: ${policy.allowFallbackRepairInjection ? 'yes' : 'no'}

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

${buildAllowedActionsSection(preset)}

## Guidelines

- You are NOT limited to simple resets. Think creatively about root causes.
- If a task keeps failing, USE query_db to check its invocation history and rejections, then add_task_feedback with guidance for the next attempt.
- If tasks run in the wrong order, USE add_dependency to fix the ordering.
- If you need to understand the state before acting, query_db FIRST, then take action based on what you learn.
- You may use multiple query_db calls to investigate before taking action.
- NEVER modify the steroids CLI source code — your job is to fix project-level task/runner issues.
- Respond with valid JSON only — no markdown fences, no commentary outside the JSON.
- If no action is needed, use a single report_only action.
- If this mode does not allow a desired action, do not request it.
- Blocking issues still require a useful diagnosis even when this mode forbids repair.
- Document everything. Your actions will be reviewed. Explain your reasoning.`;
}
