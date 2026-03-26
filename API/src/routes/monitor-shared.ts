export interface MonitorConfigRow {
  id: number;
  enabled: number;
  interval_seconds: number;
  first_responder_agents: string;
  response_preset: string;
  custom_prompt: string | null;
  escalation_rules: string;
  first_responder_timeout_seconds: number;
  updated_at: number;
}

export interface MonitorRunRow {
  id: number;
  started_at: number;
  completed_at: number | null;
  outcome: string;
  scan_results: string | null;
  escalation_reason: string | null;
  first_responder_needed: number;
  first_responder_agent: string | null;
  first_responder_actions: string | null;
  first_responder_report: string | null;
  action_results: string | null;
  error: string | null;
}

export function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

export function formatRunRow(row: MonitorRunRow) {
  return {
    id: row.id,
    started_at: row.started_at,
    completed_at: row.completed_at,
    outcome: row.outcome,
    scan_results: safeJsonParse(row.scan_results, null),
    escalation_reason: row.escalation_reason,
    first_responder_needed: Boolean(row.first_responder_needed),
    first_responder_agent: row.first_responder_agent,
    first_responder_actions: safeJsonParse(row.first_responder_actions, null),
    first_responder_report: row.first_responder_report,
    action_results: safeJsonParse(row.action_results, null),
    error: row.error,
    duration_ms: row.completed_at ? row.completed_at - row.started_at : null,
  };
}
