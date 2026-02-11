/**
 * Credit Exhaustion Detection Tests
 * Tests for credit_exhaustion classification in BaseAIProvider
 * Spec: docs/credit-exhaustion-handling.md (Phase 6)
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ClaudeProvider } from '../src/providers/claude.js';
import type { InvokeResult } from '../src/providers/interface.js';

function makeResult(overrides: Partial<InvokeResult> = {}): InvokeResult {
  return {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: '',
    duration: 100,
    timedOut: false,
    ...overrides,
  };
}

describe('Credit Exhaustion Detection', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider();
  });

  // === classifyError() — Credit Exhaustion Patterns (spec #1–#10) ===

  describe('classifyError — credit exhaustion patterns', () => {
    it('#1 Claude stderr: insufficient credits -> credit_exhaustion', () => {
      const err = provider.classifyError(
        1,
        'Error: Insufficient credits. Please add credits to your account.',
      );
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#2 Codex stderr (structured JSON): insufficient_quota -> credit_exhaustion', () => {
      const stderr = JSON.stringify({
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota' },
      });
      const err = provider.classifyError(1, stderr);
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
      expect(err?.message).toBe('You exceeded your current quota');
    });

    it('#3 Codex stderr (plain text): billing_hard_limit_reached -> credit_exhaustion', () => {
      const err = provider.classifyError(1, 'Error: billing_hard_limit_reached');
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#4 Codex stderr: exceeded your current quota -> credit_exhaustion', () => {
      const err = provider.classifyError(
        1,
        'You exceeded your current quota, please check your plan and billing details.',
      );
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#5 Gemini stderr (billing): RESOURCE_EXHAUSTED Billing account not active -> credit_exhaustion', () => {
      const err = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: Billing account not active',
      );
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#6 Gemini stderr (transient quota): RESOURCE_EXHAUSTED per-minute -> rate_limit', () => {
      const err = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: Quota exceeded for per-minute requests',
      );
      expect(err?.type).toBe('rate_limit');
      expect(err?.retryable).toBe(true);
    });

    it('#7 Generic: payment required -> credit_exhaustion', () => {
      const err = provider.classifyError(1, 'payment required');
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#8 Generic: subscription expired -> credit_exhaustion', () => {
      const err = provider.classifyError(1, 'subscription expired');
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#9 Generic: out of tokens -> credit_exhaustion', () => {
      const err = provider.classifyError(1, 'out of tokens');
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#10 Generic: usage limit reached -> credit_exhaustion', () => {
      const err = provider.classifyError(1, 'usage limit reached');
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });
  });

  // === classifyError() — Existing Patterns Still Work (spec #11–#16) ===

  describe('classifyError — existing patterns still work', () => {
    it('#11 rate limit exceeded -> rate_limit', () => {
      const err = provider.classifyError(1, 'rate limit exceeded');
      expect(err?.type).toBe('rate_limit');
      expect(err?.retryable).toBe(true);
    });

    it('#12 429 Too Many Requests -> rate_limit', () => {
      const err = provider.classifyError(1, '429 Too Many Requests');
      expect(err?.type).toBe('rate_limit');
      expect(err?.retryable).toBe(true);
    });

    it('#13 unauthorized -> auth_error', () => {
      const err = provider.classifyError(1, 'unauthorized');
      expect(err?.type).toBe('auth_error');
      expect(err?.retryable).toBe(false);
    });

    it('#14 model not found -> model_not_found', () => {
      const err = provider.classifyError(1, 'model not found');
      expect(err?.type).toBe('model_not_found');
      expect(err?.retryable).toBe(false);
    });

    it('#15 context limit exceeded -> context_exceeded', () => {
      const err = provider.classifyError(1, 'context limit exceeded');
      expect(err?.type).toBe('context_exceeded');
      expect(err?.retryable).toBe(false);
    });

    it('#16 unknown random error -> unknown', () => {
      const err = provider.classifyError(1, 'unknown random error');
      expect(err?.type).toBe('unknown');
    });
  });

  // === classifyResult() (spec #17–#20) ===

  describe('classifyResult', () => {
    it('#17 success result (exit 0) -> returns null', () => {
      const result = makeResult({ success: true, exitCode: 0 });
      expect(provider.classifyResult(result)).toBeNull();
    });

    it('#18 credit error in stderr -> credit_exhaustion', () => {
      const result = makeResult({
        stderr: 'Error: Insufficient credits. Please add credits to your account.',
      });
      const err = provider.classifyResult(result);
      expect(err?.type).toBe('credit_exhaustion');
      expect(err?.retryable).toBe(false);
    });

    it('#19 credit error in stdout (JSON error response) -> credit_exhaustion', () => {
      const result = makeResult({
        stderr: 'process exited with error',
        stdout: JSON.stringify({
          error: { code: 'insufficient_quota', message: 'Quota exceeded' },
        }),
      });
      const err = provider.classifyResult(result);
      expect(err?.type).toBe('credit_exhaustion');
    });

    it('#20 unknown error in both stderr and stdout -> unknown', () => {
      const result = makeResult({
        stderr: 'mysterious failure',
        stdout: 'no useful info',
      });
      const err = provider.classifyResult(result);
      expect(err?.type).toBe('unknown');
    });
  });
});
