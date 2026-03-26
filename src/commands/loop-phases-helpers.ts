/**
 * Loop phase functions for coder and reviewer invocation
 * ORCHESTRATOR-DRIVEN: The orchestrator makes ALL status decisions
 */

import { execSync } from 'node:child_process';
import {
  getTaskRejections,
  getTaskAudit,
  incrementTaskFailureCount,
} from '../database/queries.js';
import type { openDatabase } from '../database/connection.js';
import {
  getCurrentCommitSha,
  getModifiedFiles,
  isCommitReachableWithFetch,
} from '../git/status.js';
import { loadConfig, type ReviewerConfig } from '../config/loader.js';
import { getProviderRegistry } from '../providers/registry.js';
import type { InvokeResult } from '../providers/interface.js';
import { withGlobalDatabase } from '../runners/global-db.js';

export interface LeaseFenceContext {
  parallelSessionId?: string;
  runnerId?: string;
}

export const WORKSTREAM_LEASE_TTL_SECONDS = 120;
export const LEASE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Extract [OUT_OF_SCOPE] checkbox lines from raw reviewer stdout.
 * Handles bold/backtick formatting, * bullets, and checked/unchecked boxes LLMs may emit.
 */
export function extractOutOfScopeItems(stdout: string): string[] {
  return stdout.match(/[-*]\s*\[\s*[x ]?\s*\]\s*(?:[`*]{1,2})?\[OUT_OF_SCOPE\](?:[`*]{1,2})?[^\n]*/gi) ?? [];
}

export function refreshParallelWorkstreamLease(projectPath: string, leaseFence?: LeaseFenceContext): boolean {
  if (!leaseFence?.parallelSessionId) {
    return true;
  }

  return withGlobalDatabase((db: any) => {
    const row = db
      .prepare(
        `SELECT id, claim_generation, runner_id
         FROM workstreams
         WHERE session_id = ?
           AND clone_path = ?
           AND status = 'running'
         LIMIT 1`
      )
      .get(leaseFence.parallelSessionId, projectPath) as
      | { id: string; claim_generation: number; runner_id: string | null }
      | undefined;

    if (!row) {
      return false;
    }

    const owner = leaseFence.runnerId ?? row.runner_id ?? `runner:${process.pid ?? 'unknown'}`;
    const updateResult = db
      .prepare(
        `UPDATE workstreams
         SET runner_id = ?,
             lease_expires_at = datetime('now', '+${WORKSTREAM_LEASE_TTL_SECONDS} seconds')
         WHERE id = ?
           AND status = 'running'
           AND claim_generation = ?`
      )
      .run(owner, row.id, row.claim_generation);

    return updateResult.changes === 1;
  });
}

export async function invokeWithLeaseHeartbeat<T>(
  projectPath: string,
  leaseFence: LeaseFenceContext | undefined,
  invokeFn: () => Promise<T>
): Promise<{ superseded: boolean; result?: T }> {
  if (!leaseFence?.parallelSessionId) {
    return { superseded: false, result: await invokeFn() };
  }

  let superseded = false;
  const interval = setInterval(() => {
    if (superseded) {
      return;
    }
    const refreshed = refreshParallelWorkstreamLease(projectPath, leaseFence);
    if (!refreshed) {
      superseded = true;
    }
  }, LEASE_HEARTBEAT_INTERVAL_MS);
  interval.unref?.();

  try {
    const result = await invokeFn();
    if (superseded) {
      return { superseded: true };
    }
    return { superseded: false, result };
  } finally {
    clearInterval(interval);
  }
}

export interface CreditExhaustionResult {
  action: 'pause_credit_exhaustion' | 'rate_limit' | 'pause_auth_error';
  provider: string;
  model: string;
  role: 'coder' | 'reviewer';
  message: string;
  retryAfterMs?: number;
}

export function summarizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * Classify orchestrator invocation failures so we can distinguish transient parse
 * noise from hard provider/config failures (auth/model/availability).
 */
export async function classifyOrchestratorFailure(
  error: unknown,
  projectPath: string
): Promise<{ type: string; message: string; retryable: boolean } | null> {
  const message = summarizeErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes('orchestrator ai provider not configured')) {
    return { type: 'orchestrator_unconfigured', message, retryable: false };
  }

  if (lower.includes("provider '") && lower.includes('is not available')) {
    return { type: 'provider_unavailable', message, retryable: false };
  }

  const config = loadConfig(projectPath);
  const providerName = config.ai?.orchestrator?.provider;
  if (!providerName) {
    return { type: 'orchestrator_unconfigured', message, retryable: false };
  }

  const registry = await getProviderRegistry();
  const provider = registry.tryGet(providerName);
  if (!provider) {
    return { type: 'provider_unavailable', message, retryable: false };
  }

  const syntheticFailure: InvokeResult = {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: message,
    duration: 0,
    timedOut: false,
  };

  const classified = provider.classifyResult(syntheticFailure);
  if (!classified) {
    return null;
  }

  return {
    type: classified.type,
    message: classified.message || message,
    retryable: classified.retryable,
  };
}

export const MAX_ORCHESTRATOR_PARSE_RETRIES = 3;
export const MAX_CONTRACT_VIOLATION_RETRIES = 3;
export const MAX_PROVIDER_NONZERO_FAILURES = 3;
export const MAX_CONSECUTIVE_CODER_RETRIES = 3;
export const CODER_PARSE_FALLBACK_MARKER = '[retry] FALLBACK: Orchestrator failed, defaulting to retry';
export const REVIEWER_PARSE_FALLBACK_MARKER = '[unclear] FALLBACK: Orchestrator failed, retrying review';
export const CONTRACT_CHECKLIST_MARKER = '[contract:checklist]';
export const CONTRACT_REJECTION_RESPONSE_MARKER = '[contract:rejection_response]';
export const MUST_IMPLEMENT_MARKER = '[must_implement]';

export interface ProviderFailureContext {
  role: 'coder' | 'reviewer';
  provider: string;
  model: string;
  exitCode: number;
  output: string;
}

export interface ProviderInvocationFailureDecision {
  shouldStopTask: boolean;
}

export function formatProviderFailureMessage(
  taskId: string,
  context: ProviderFailureContext
): string {
  const output = context.output || 'provider invocation failed with no output.';
  return `Task ${taskId}: provider ${context.provider}/${context.model} exited with non-zero status ${context.exitCode} during ${context.role} phase: ${output}`;
}

export async function handleProviderInvocationFailure(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  context: ProviderFailureContext,
  jsonMode: boolean
): Promise<ProviderInvocationFailureDecision> {
  const { updateTaskStatus } = await import('../database/queries.js');

  const failureCount = incrementTaskFailureCount(db, taskId);
  const providerMessage = formatProviderFailureMessage(taskId, context);

  if (failureCount >= MAX_PROVIDER_NONZERO_FAILURES) {
    const reason = `${providerMessage} (provider invocation failed ${failureCount} time(s). Task failed.)`;
    updateTaskStatus(db, taskId, 'failed', 'orchestrator', reason);

    if (!jsonMode) {
      console.log(`\n✗ Task failed (${reason})`);
    }

    return { shouldStopTask: true };
  }

  if (!jsonMode) {
    const retriesLeft = MAX_PROVIDER_NONZERO_FAILURES - failureCount;
    console.log(`\n⟳ Provider invocation failed (${failureCount}/${MAX_PROVIDER_NONZERO_FAILURES}) for task ${taskId}; retrying (${retriesLeft} attempt(s) left).`);
    console.log(`    ${providerMessage}`);
  }

  return { shouldStopTask: false };
}

export function countConsecutiveOrchestratorFallbackEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  marker: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') break;

    // Use category and error_code instead of marker string search
    const isFallback = entry.category === 'fallback';
    const matchesCode = entry.error_code === marker;

    if (isFallback && matchesCode) {
      count += 1;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Count consecutive unclear orchestrator entries (regardless of specific marker).
 * This catches ALL unclear decisions — orchestrator parse failures, missing decision tokens, etc.
 */
export function countConsecutiveUnclearEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') break;

    if ((entry.notes ?? '').startsWith('[unclear]')) {
      count += 1;
      continue;
    }

    break;
  }

  return count;
}

/**
 * Count consecutive coder retry entries (notes starting with [retry]).
 * Used as a universal retry cap to prevent infinite loops.
 */
export function countConsecutiveRetryEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') break;

    if ((entry.notes ?? '').startsWith('[retry]')) {
      count += 1;
      continue;
    }

    break;
  }

  return count;
}

export function countConsecutiveTaggedOrchestratorEntries(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string,
  requiredTag: string,
  tagFamilyPrefix?: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') {
      continue; // tolerate non-orchestrator audit noise
    }

    const notes = entry.notes ?? '';
    if (notes.includes(requiredTag)) {
      count += 1;
      continue;
    }

    if (tagFamilyPrefix && notes.includes(tagFamilyPrefix)) {
      break; // same family, different category = sequence ended
    }

    break;
  }

  return count;
}

/**
 * Count commit-recovery attempts across a recovery episode.
 * Unlike the generic consecutive counter, this intentionally tolerates
 * orchestrator review submissions between attempts so retry caps cannot reset.
 */
export function countCommitRecoveryAttempts(
  db: ReturnType<typeof openDatabase>['db'],
  taskId: string
): number {
  const audit = getTaskAudit(db, taskId);
  let count = 0;

  for (let i = audit.length - 1; i >= 0; i--) {
    const entry = audit[i];
    if (entry.actor !== 'orchestrator') {
      continue;
    }

    const notes = entry.notes ?? '';
    if (notes.includes('[commit_recovery]')) {
      count += 1;
      continue;
    }

    if (entry.category === 'decision') {
      continue;
    }

    // Recovery cycles naturally include orchestrator review submissions.
    // Do not treat those as sequence boundaries.
    if (entry.to_status === 'review') {
      continue;
    }

    break;
  }

  return count;
}

export function countLatestOpenRejectionItems(notes?: string): number {
  if (!notes) return 0;
  return notes
    .split('\n')
    .filter(line => /^\s*[-*]\s*\[\s\]\s+/.test(line))
    .length;
}

export function hasCoderCompletionSignal(output: string): boolean {
  const lower = output.toLowerCase();

  if (/\b(?:not|no)\s+(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|finished|done|ready)\b/.test(lower)) {
    return false;
  }

  return /\b(?:task\s+)?(?:is\s+)?(?:complete|complete[d]?|implemented|finished|done|ready for review|ready)\b/.test(
    lower
  );
}

export function extractSubmissionCommitToken(output: string): string | null {
  const match = output.match(/^\s*SUBMISSION_COMMIT\s*:\s*([0-9a-fA-F]{7,40})\b/im);
  return match?.[1] ?? null;
}

export function resolveCoderSubmittedCommitSha(
  projectPath: string,
  coderOutput: string,
  options: { requireExplicitToken?: boolean } = {}
): string | undefined {
  const tokenSha = extractSubmissionCommitToken(coderOutput);
  if (tokenSha && isCommitReachableWithFetch(projectPath, tokenSha, { forceFetch: true })) {
    try {
      return execSync(`git rev-parse ${tokenSha}^{commit}`, {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return tokenSha;
    }
  }

  if (options.requireExplicitToken) {
    return undefined;
  }

  return getCurrentCommitSha(projectPath) || undefined;
}
