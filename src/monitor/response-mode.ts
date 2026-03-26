/**
 * Shared monitor response-mode contract.
 *
 * The monitor stores `response_preset` in config, but the runtime must treat
 * that value as a host-enforced policy, not just prompt text.
 */

export const MONITOR_RESPONSE_MODES = [
  'monitor_only',
  'triage_only',
  'fix_and_monitor',
  'custom',
] as const;

export const LEGACY_MONITOR_RESPONSE_PRESETS = [
  'stop_on_error',
  'investigate_and_stop',
] as const;

export type MonitorResponseMode = typeof MONITOR_RESPONSE_MODES[number];
export type LegacyMonitorResponsePreset = typeof LEGACY_MONITOR_RESPONSE_PRESETS[number];
export type StoredMonitorResponsePreset = MonitorResponseMode | LegacyMonitorResponsePreset;

export type FirstResponderActionName =
  | 'reset_task'
  | 'reset_project'
  | 'kill_runner'
  | 'stop_all_runners'
  | 'trigger_wakeup'
  | 'query_db'
  | 'update_task'
  | 'add_dependency'
  | 'add_task_feedback'
  | 'suppress_anomaly'
  | 'release_merge_lock'
  | 'reset_merge_phase'
  | 'report_only';

export interface MonitorResponseOption {
  value: MonitorResponseMode;
  label: string;
  description: string;
}

export interface MonitorResponsePolicy {
  preset: StoredMonitorResponsePreset;
  label: string;
  description: string;
  autoDispatch: boolean;
  allowedActions: ReadonlySet<FirstResponderActionName>;
  allowFallbackRepairInjection: boolean;
  requiresCustomPrompt: boolean;
  deprecated: boolean;
}

const ALL_ACTIONS = new Set<FirstResponderActionName>([
  'reset_task',
  'reset_project',
  'kill_runner',
  'stop_all_runners',
  'trigger_wakeup',
  'query_db',
  'update_task',
  'add_dependency',
  'add_task_feedback',
  'suppress_anomaly',
  'release_merge_lock',
  'reset_merge_phase',
  'report_only',
]);

const TRIAGE_ACTIONS = new Set<FirstResponderActionName>([
  'query_db',
  'report_only',
]);

const STOP_ON_ERROR_ACTIONS = new Set<FirstResponderActionName>([
  'stop_all_runners',
  'report_only',
]);

const INVESTIGATE_AND_STOP_ACTIONS = new Set<FirstResponderActionName>([
  'query_db',
  'report_only',
  'stop_all_runners',
]);

export const MONITOR_RESPONSE_OPTIONS: readonly MonitorResponseOption[] = [
  {
    value: 'monitor_only',
    label: 'Just Monitor',
    description: 'Detect and record anomalies only. Never dispatch a first responder automatically.',
  },
  {
    value: 'triage_only',
    label: 'Triage Only',
    description: 'Investigate and identify the problem, but do not mutate project or runner state.',
  },
  {
    value: 'fix_and_monitor',
    label: 'Fix And Monitor',
    description: 'Attempt safe corrective actions, then keep monitoring.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Use custom instructions, still constrained by host-side action validation.',
  },
] as const;

export function isMonitorResponseMode(value: string | null | undefined): value is MonitorResponseMode {
  return typeof value === 'string' && (MONITOR_RESPONSE_MODES as readonly string[]).includes(value);
}

export function isLegacyMonitorResponsePreset(value: string | null | undefined): value is LegacyMonitorResponsePreset {
  return typeof value === 'string' && (LEGACY_MONITOR_RESPONSE_PRESETS as readonly string[]).includes(value);
}

export function isStoredMonitorResponsePreset(value: string | null | undefined): value is StoredMonitorResponsePreset {
  return isMonitorResponseMode(value) || isLegacyMonitorResponsePreset(value);
}

export function resolveStoredMonitorResponsePreset(
  value: string | null | undefined,
): StoredMonitorResponsePreset {
  if (isStoredMonitorResponsePreset(value)) {
    return value;
  }
  return 'triage_only';
}

export function getCanonicalResponseMode(
  value: string | null | undefined,
): MonitorResponseMode {
  const preset = resolveStoredMonitorResponsePreset(value);
  if (preset === 'stop_on_error' || preset === 'investigate_and_stop') {
    return 'triage_only';
  }
  return preset;
}

export function requiresManualInvestigationOverride(
  value: string | null | undefined,
): boolean {
  return getCanonicalResponseMode(value) === 'monitor_only';
}

export function validateResponsePreset(
  value: string | null | undefined,
  customPrompt: string | null | undefined,
): string | null {
  if (!isStoredMonitorResponsePreset(value)) {
    return `Invalid response preset "${String(value)}"`;
  }
  if (value === 'custom' && !customPrompt?.trim()) {
    return 'Custom response mode requires a non-empty custom prompt';
  }
  return null;
}

export function formatResponsePresetLabel(
  value: string | null | undefined,
): string {
  const preset = resolveStoredMonitorResponsePreset(value);
  const policy = getMonitorResponsePolicy(preset);
  return policy.deprecated ? `${policy.label} (legacy)` : policy.label;
}

export function getMonitorResponsePolicy(
  value: string | null | undefined,
): MonitorResponsePolicy {
  const preset = resolveStoredMonitorResponsePreset(value);
  switch (preset) {
    case 'monitor_only':
      return {
        preset,
        label: 'Just Monitor',
        description: 'Detect and record anomalies only. Do not auto-dispatch a first responder.',
        autoDispatch: false,
        allowedActions: new Set<FirstResponderActionName>(),
        allowFallbackRepairInjection: false,
        requiresCustomPrompt: false,
        deprecated: false,
      };
    case 'triage_only':
      return {
        preset,
        label: 'Triage Only',
        description: 'Investigate and identify the problem without mutating project or runner state.',
        autoDispatch: true,
        allowedActions: TRIAGE_ACTIONS,
        allowFallbackRepairInjection: false,
        requiresCustomPrompt: false,
        deprecated: false,
      };
    case 'fix_and_monitor':
      return {
        preset,
        label: 'Fix And Monitor',
        description: 'Investigate issues, apply allowed corrective actions, and continue monitoring.',
        autoDispatch: true,
        allowedActions: ALL_ACTIONS,
        allowFallbackRepairInjection: true,
        requiresCustomPrompt: false,
        deprecated: false,
      };
    case 'custom':
      return {
        preset,
        label: 'Custom',
        description: 'Use custom instructions while staying inside the host-side action allowlist.',
        autoDispatch: true,
        allowedActions: ALL_ACTIONS,
        allowFallbackRepairInjection: false,
        requiresCustomPrompt: true,
        deprecated: false,
      };
    case 'stop_on_error':
      return {
        preset,
        label: 'Stop On Error',
        description: 'Legacy mode: stop all runners on dangerous anomalies and report the result.',
        autoDispatch: true,
        allowedActions: STOP_ON_ERROR_ACTIONS,
        allowFallbackRepairInjection: false,
        requiresCustomPrompt: false,
        deprecated: true,
      };
    case 'investigate_and_stop':
      return {
        preset,
        label: 'Investigate And Stop',
        description: 'Legacy mode: diagnose the problem and stop runners only if necessary.',
        autoDispatch: true,
        allowedActions: INVESTIGATE_AND_STOP_ACTIONS,
        allowFallbackRepairInjection: false,
        requiresCustomPrompt: false,
        deprecated: true,
      };
  }
}
