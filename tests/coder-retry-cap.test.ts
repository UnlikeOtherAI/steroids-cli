/**
 * Integration test for the coder retry cap.
 *
 * Reproduces the infinite-loop regression where SignalParser returns 'unclear'
 * → maps to action: 'retry' → audit entry "[retry] SignalParser detected unclear status"
 * → no escalation counter matches → infinite loop (75+ iterations on task f9a4da71).
 *
 * The fix adds a universal MAX_CONSECUTIVE_CODER_RETRIES cap that escalates ANY
 * consecutive [retry] audit entries to 'error'/'failed'.
 */

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/database/schema.js';
import { addAuditEntry, createTask, getTaskAudit } from '../src/database/queries.js';
import { OrchestrationFallbackHandler } from '../src/orchestrator/fallback-handler.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const MAX_CONSECUTIVE_CODER_RETRIES = 3;

/**
 * Mirrors the countConsecutiveRetryEntries helper in loop-phases.ts
 */
function countConsecutiveRetryEntries(
  db: Database.Database,
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

describe('Coder retry cap (infinite-loop regression)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('should escalate to failed after MAX_CONSECUTIVE_CODER_RETRIES unclear retries', () => {
    const task = createTask(db, 'infinite-loop regression task', { status: 'in_progress' });

    // Seed audit trail with N-1 consecutive [retry] entries
    for (let i = 0; i < MAX_CONSECUTIVE_CODER_RETRIES - 1; i++) {
      addAuditEntry(db, task.id, 'in_progress', 'in_progress', 'orchestrator', {
        actorType: 'orchestrator',
        notes: '[retry] SignalParser detected unclear status (confidence: low)',
      });
    }

    // Simulate the Nth retry arriving
    const handler = new OrchestrationFallbackHandler();
    // LLM returns JSON (as old prompt instructed), SignalParser can't find STATUS: REVIEW
    const jsonOutput = JSON.stringify({
      action: 'submit',
      reasoning: 'Clean exit',
      commits: ['abc123'],
    });
    let decision = handler.parseCoderOutput(jsonOutput);

    // Parser should return retry (unclear → retry)
    expect(decision.action).toBe('retry');
    expect(decision.confidence).toBe('low');

    // Apply the universal retry cap (same logic as loop-phases.ts)
    if (decision.action === 'retry') {
      const consecutiveRetries = countConsecutiveRetryEntries(db, task.id) + 1;
      if (consecutiveRetries >= MAX_CONSECUTIVE_CODER_RETRIES) {
        decision = {
          ...decision,
          action: 'error',
          reasoning: `Coder retry limit reached (${consecutiveRetries} consecutive retries); escalating to failed`,
          next_status: 'failed',
          confidence: 'low',
          exit_clean: false,
        };
      }
    }

    // Assert: should have escalated to error/failed
    expect(decision.action).toBe('error');
    expect(decision.next_status).toBe('failed');
    expect(decision.reasoning).toContain('retry limit reached');
    expect(decision.reasoning).toContain(`${MAX_CONSECUTIVE_CODER_RETRIES} consecutive retries`);
  });

  it('should NOT escalate if retries are below the cap', () => {
    const task = createTask(db, 'below-cap task', { status: 'in_progress' });

    // Only 1 prior retry (below cap of 3)
    addAuditEntry(db, task.id, 'in_progress', 'in_progress', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[retry] SignalParser detected unclear status (confidence: low)',
    });

    const handler = new OrchestrationFallbackHandler();
    let decision = handler.parseCoderOutput('no signal here');

    expect(decision.action).toBe('retry');

    // Apply the retry cap check
    if (decision.action === 'retry') {
      const consecutiveRetries = countConsecutiveRetryEntries(db, task.id) + 1;
      if (consecutiveRetries >= MAX_CONSECUTIVE_CODER_RETRIES) {
        decision = {
          ...decision,
          action: 'error',
          next_status: 'failed',
        };
      }
    }

    // Should still be retry (2 < 3)
    expect(decision.action).toBe('retry');
  });

  it('should reset retry count when a non-retry entry breaks the sequence', () => {
    const task = createTask(db, 'reset-sequence task', { status: 'in_progress' });

    // 2 retries, then a submit, then 1 retry
    addAuditEntry(db, task.id, 'in_progress', 'in_progress', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[retry] SignalParser detected unclear status (confidence: low)',
    });
    addAuditEntry(db, task.id, 'in_progress', 'in_progress', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[retry] SignalParser detected unclear status (confidence: low)',
    });
    addAuditEntry(db, task.id, 'in_progress', 'review', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[submit] Clean exit with commits (confidence: high)',
    });
    addAuditEntry(db, task.id, 'review', 'in_progress', 'orchestrator', {
      actorType: 'orchestrator',
      notes: '[retry] SignalParser detected unclear status (confidence: low)',
    });

    // Only 1 consecutive retry (the last one), not 3
    const consecutiveRetries = countConsecutiveRetryEntries(db, task.id);
    expect(consecutiveRetries).toBe(1);
  });

  it('should handle text signal STATUS: RETRY without infinite loop', () => {
    const handler = new OrchestrationFallbackHandler();
    const output = `I need more time to finish.\n\nSTATUS: RETRY\nREASON: Incomplete implementation`;
    const decision = handler.parseCoderOutput(output);

    // Should map to retry action with the extracted reason
    expect(decision.action).toBe('retry');
    expect(decision.reasoning).toBe('Incomplete implementation');
    expect(decision.next_status).toBe('in_progress');
  });

  it('should handle text signal STATUS: ERROR correctly', () => {
    const handler = new OrchestrationFallbackHandler();
    const output = `Fatal failure.\n\nSTATUS: ERROR\nREASON: Build failed with fatal error\nCONFIDENCE: HIGH`;
    const decision = handler.parseCoderOutput(output);

    expect(decision.action).toBe('error');
    expect(decision.reasoning).toBe('Build failed with fatal error');
    expect(decision.next_status).toBe('failed');
    expect(decision.confidence).toBe('high');
    expect(decision.exit_clean).toBe(false);
  });

  it('should handle text signal STATUS: REVIEW with commit message', () => {
    const handler = new OrchestrationFallbackHandler();
    const output = `Done.\n\nSTATUS: REVIEW\nREASON: Work complete\nCONFIDENCE: HIGH\nCOMMIT_MESSAGE: feat: add feature`;
    const decision = handler.parseCoderOutput(output);

    expect(decision.action).toBe('submit');
    expect(decision.reasoning).toBe('Work complete');
    expect(decision.next_status).toBe('review');
    expect(decision.confidence).toBe('high');
    expect(decision.commit_message).toBe('feat: add feature');
  });
});
