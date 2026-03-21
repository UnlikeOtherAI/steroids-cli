/**
 * Deterministic escalation rules engine.
 *
 * Pure threshold check: if any anomaly has severity >= the configured
 * minimum, escalation is triggered. No LLM, no fuzzy matching, no magic.
 */

import type { Anomaly } from './scanner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscalationRules {
  min_severity: 'info' | 'warning' | 'critical';
}

export interface EscalationDecision {
  escalate: boolean;
  reason: string;
  matchingAnomalies: Anomaly[];
}

// ---------------------------------------------------------------------------
// Severity ordering
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Anomaly['severity'], number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function shouldEscalate(
  anomalies: Anomaly[],
  rules: EscalationRules,
): EscalationDecision {
  const threshold = SEVERITY_ORDER[rules.min_severity];

  const matching = anomalies.filter(
    (a) => SEVERITY_ORDER[a.severity] >= threshold,
  );

  if (matching.length === 0) {
    return {
      escalate: false,
      reason: `No anomalies at or above severity "${rules.min_severity}"`,
      matchingAnomalies: [],
    };
  }

  const highest = matching.reduce((max, a) =>
    SEVERITY_ORDER[a.severity] > SEVERITY_ORDER[max.severity] ? a : max,
  );

  return {
    escalate: true,
    reason: `${matching.length} anomaly/anomalies at or above severity "${rules.min_severity}" (highest: ${highest.severity})`,
    matchingAnomalies: matching,
  };
}
