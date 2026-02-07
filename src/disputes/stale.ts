/**
 * Stale dispute handling
 *
 * Tracks disputes that have been open longer than the configured timeout
 * and provides alerting and listing functionality.
 */

import type Database from 'better-sqlite3';
import {
  getStaleDisputes,
  listDisputesWithTasks,
  calculateDaysOpen,
  type DisputeWithTask,
} from './queries.js';
import type { Dispute } from './types.js';

// ============ Configuration ============

/**
 * Default timeout in days before a dispute is considered stale
 */
export const DEFAULT_TIMEOUT_DAYS = 7;

/**
 * Alert types for stale disputes
 */
export type StaleAlertType = 'log' | 'webhook' | 'none';

// ============ Stale Detection ============

/**
 * Result of checking for stale disputes
 */
export interface StaleDisputesResult {
  /** Number of stale disputes found */
  count: number;
  /** The stale disputes with task info */
  disputes: StaleDisputeInfo[];
  /** Timeout days used for detection */
  timeoutDays: number;
}

/**
 * Stale dispute with additional computed info
 */
export interface StaleDisputeInfo {
  /** The dispute record */
  dispute: DisputeWithTask;
  /** Number of days the dispute has been open */
  daysOpen: number;
  /** Days past the timeout threshold */
  daysPastThreshold: number;
}

/**
 * Check for stale disputes
 */
export function checkStaleDisputes(
  db: Database.Database,
  timeoutDays: number = DEFAULT_TIMEOUT_DAYS
): StaleDisputesResult {
  const staleDisputes = listDisputesWithTasks(db, {
    stale: true,
    timeoutDays,
  });

  const disputes = staleDisputes.map((dispute) => {
    const daysOpen = calculateDaysOpen(dispute.created_at);
    return {
      dispute,
      daysOpen,
      daysPastThreshold: daysOpen - timeoutDays,
    };
  });

  return {
    count: disputes.length,
    disputes,
    timeoutDays,
  };
}

/**
 * Get stale dispute summary for display
 */
export function getStaleDisputeSummary(
  db: Database.Database,
  timeoutDays: number = DEFAULT_TIMEOUT_DAYS
): string {
  const result = checkStaleDisputes(db, timeoutDays);

  if (result.count === 0) {
    return `No disputes have been open longer than ${timeoutDays} days.`;
  }

  const lines: string[] = [];
  lines.push(`WARNING: ${result.count} dispute(s) have been open for > ${timeoutDays} days\n`);
  lines.push('ID               TASK                           DAYS OPEN');
  lines.push('-'.repeat(60));

  for (const item of result.disputes) {
    const shortId = item.dispute.id.substring(0, 8);
    const taskTitle = item.dispute.task_title.length > 30
      ? item.dispute.task_title.substring(0, 27) + '...'
      : item.dispute.task_title.padEnd(30);
    lines.push(`${shortId}         ${taskTitle} ${item.daysOpen}`);
  }

  lines.push('');
  lines.push('Run `steroids dispute show <id>` for details.');

  return lines.join('\n');
}

// ============ Alerting ============

/**
 * Alert configuration for stale disputes
 */
export interface StaleAlertConfig {
  /** Type of alert to send */
  type: StaleAlertType;
  /** Webhook URL (required if type is 'webhook') */
  webhookUrl?: string;
  /** Custom message prefix */
  messagePrefix?: string;
}

/**
 * Alert result
 */
export interface AlertResult {
  success: boolean;
  alertType: StaleAlertType;
  message?: string;
  error?: string;
}

/**
 * Send alert for stale disputes
 */
export async function alertStaleDisputes(
  db: Database.Database,
  config: StaleAlertConfig,
  timeoutDays: number = DEFAULT_TIMEOUT_DAYS
): Promise<AlertResult> {
  const result = checkStaleDisputes(db, timeoutDays);

  if (result.count === 0) {
    return {
      success: true,
      alertType: config.type,
      message: 'No stale disputes found',
    };
  }

  const prefix = config.messagePrefix ?? 'Steroids';
  const message = `${prefix}: ${result.count} dispute(s) open > ${timeoutDays} days`;

  switch (config.type) {
    case 'log':
      console.warn(message);
      console.warn(getStaleDisputeSummary(db, timeoutDays));
      return {
        success: true,
        alertType: 'log',
        message,
      };

    case 'webhook':
      if (!config.webhookUrl) {
        return {
          success: false,
          alertType: 'webhook',
          error: 'Webhook URL not configured',
        };
      }
      try {
        await sendWebhookAlert(config.webhookUrl, result);
        return {
          success: true,
          alertType: 'webhook',
          message,
        };
      } catch (error) {
        return {
          success: false,
          alertType: 'webhook',
          error: error instanceof Error ? error.message : 'Webhook failed',
        };
      }

    case 'none':
      return {
        success: true,
        alertType: 'none',
        message: 'Alerting disabled',
      };
  }
}

/**
 * Send webhook alert for stale disputes
 */
async function sendWebhookAlert(
  url: string,
  result: StaleDisputesResult
): Promise<void> {
  const payload = {
    type: 'stale_disputes',
    count: result.count,
    timeoutDays: result.timeoutDays,
    disputes: result.disputes.map((item) => ({
      id: item.dispute.id,
      taskId: item.dispute.task_id,
      taskTitle: item.dispute.task_title,
      type: item.dispute.type,
      reason: item.dispute.reason,
      daysOpen: item.daysOpen,
      createdAt: item.dispute.created_at,
    })),
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook failed with status ${response.status}`);
  }
}

// ============ Stale Check Integration ============

/**
 * Options for periodic stale checking
 */
export interface StaleCheckOptions {
  /** Timeout in days */
  timeoutDays: number;
  /** Alert configuration */
  alert: StaleAlertConfig;
}

/**
 * Perform a stale check and alert if needed
 * Called from daemon or cron job
 */
export async function performStaleCheck(
  db: Database.Database,
  options: StaleCheckOptions
): Promise<{
  staleCount: number;
  alertSent: boolean;
  alertResult?: AlertResult;
}> {
  const result = checkStaleDisputes(db, options.timeoutDays);

  if (result.count === 0) {
    return {
      staleCount: 0,
      alertSent: false,
    };
  }

  const alertResult = await alertStaleDisputes(
    db,
    options.alert,
    options.timeoutDays
  );

  return {
    staleCount: result.count,
    alertSent: true,
    alertResult,
  };
}

// ============ List Helpers ============

/**
 * List all open disputes sorted by age (oldest first)
 */
export function listOpenDisputesByAge(
  db: Database.Database
): DisputeWithTask[] {
  return listDisputesWithTasks(db, { status: 'open' }).sort((a, b) => {
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/**
 * Get dispute age in human-readable format
 */
export function formatDisputeAge(dispute: Dispute): string {
  const days = calculateDaysOpen(dispute.created_at);

  if (days === 0) {
    return 'Today';
  } else if (days === 1) {
    return '1 day ago';
  } else if (days < 7) {
    return `${days} days ago`;
  } else if (days < 14) {
    return '1 week ago';
  } else if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} weeks ago`;
  } else {
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
}
