/**
 * Credit Exhaustion Detection Tests
 * Tests for credit_exhaustion classification in BaseAIProvider
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

  describe('classifyError — credit exhaustion patterns', () => {
    it('Claude: "insufficient credits" in stderr -> credit_exhaustion', () => {
      const error = provider.classifyError(1, 'Error: insufficient credits on your account');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('Codex: JSON {"error":{"code":"insufficient_quota"}} -> credit_exhaustion', () => {
      const stderr = JSON.stringify({
        error: { code: 'insufficient_quota', message: 'You have exceeded your quota' },
      });
      const error = provider.classifyError(1, stderr);
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
      expect(error?.message).toBe('You have exceeded your quota');
    });

    it('Codex: "exceeded your current quota" in stderr -> credit_exhaustion', () => {
      const error = provider.classifyError(1, 'Error: You exceeded your current quota');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('Codex: "billing_hard_limit_reached" in JSON -> credit_exhaustion', () => {
      const stderr = JSON.stringify({
        error: { code: 'billing_hard_limit_reached', message: 'Billing hard limit reached' },
      });
      const error = provider.classifyError(1, stderr);
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "out of credits"', () => {
      const error = provider.classifyError(1, 'Your account is out of credits');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "payment required"', () => {
      const error = provider.classifyError(1, 'Payment required to continue');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "usage limit reached"', () => {
      const error = provider.classifyError(1, 'usage limit reached for this billing period');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "plan limit"', () => {
      const error = provider.classifyError(1, 'You have exceeded your plan limit');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "subscription expired"', () => {
      const error = provider.classifyError(1, 'Your subscription expired');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects "insufficient balance" (case insensitive)', () => {
      const error = provider.classifyError(1, 'Insufficient Balance on account');
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });
  });

  describe('classifyError — Gemini RESOURCE_EXHAUSTED disambiguation', () => {
    it('RESOURCE_EXHAUSTED + "per minute" -> rate_limit (NOT credit_exhaustion)', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: Quota exceeded for model requests per minute',
      );
      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
    });

    it('RESOURCE_EXHAUSTED + "per second" -> rate_limit', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: Rate limit per second exceeded',
      );
      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
    });

    it('RESOURCE_EXHAUSTED + "retry after" -> rate_limit', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: Please retry after 30 seconds',
      );
      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
    });

    it('RESOURCE_EXHAUSTED + "billing" -> credit_exhaustion', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: billing account has been suspended',
      );
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('RESOURCE_EXHAUSTED + "budget" -> credit_exhaustion', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: project budget has been exceeded',
      );
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('RESOURCE_EXHAUSTED + "hard limit" -> credit_exhaustion', () => {
      const error = provider.classifyError(
        1,
        'RESOURCE_EXHAUSTED: hard limit for this project reached',
      );
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });
  });

  describe('classifyError — existing detections still work', () => {
    it('rate limit: "429" -> rate_limit', () => {
      const error = provider.classifyError(1, 'HTTP 429 Too Many Requests');
      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
    });

    it('rate limit: "rate limit" -> rate_limit', () => {
      const error = provider.classifyError(1, 'rate limit exceeded');
      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
    });

    it('auth error: "unauthorized" -> auth_error', () => {
      const error = provider.classifyError(1, 'unauthorized: invalid API key');
      expect(error?.type).toBe('auth_error');
      expect(error?.retryable).toBe(false);
    });

    it('network error: "connection timeout" -> network_error', () => {
      const error = provider.classifyError(1, 'connection timeout');
      expect(error?.type).toBe('network_error');
      expect(error?.retryable).toBe(true);
    });

    it('model not found: "model not found" -> model_not_found', () => {
      const error = provider.classifyError(1, 'model not found');
      expect(error?.type).toBe('model_not_found');
      expect(error?.retryable).toBe(false);
    });

    it('context exceeded: "context limit exceeded" -> context_exceeded', () => {
      const error = provider.classifyError(1, 'context limit exceeded');
      expect(error?.type).toBe('context_exceeded');
      expect(error?.retryable).toBe(false);
    });

    it('exit code 0 returns null', () => {
      const error = provider.classifyError(0, 'some output');
      expect(error).toBeNull();
    });

    it('unrecognized error -> unknown', () => {
      const error = provider.classifyError(1, 'something went wrong');
      expect(error?.type).toBe('unknown');
    });
  });

  describe('classifyResult', () => {
    it('returns null when result.success is true', () => {
      const result = makeResult({ success: true, exitCode: 0 });
      expect(provider.classifyResult(result)).toBeNull();
    });

    it('detects credit error in stderr', () => {
      const result = makeResult({ stderr: 'insufficient credits' });
      const error = provider.classifyResult(result);
      expect(error?.type).toBe('credit_exhaustion');
      expect(error?.retryable).toBe(false);
    });

    it('detects credit error in stdout when stderr is generic', () => {
      const result = makeResult({
        stderr: 'process exited with error',
        stdout: JSON.stringify({
          error: { code: 'insufficient_quota', message: 'Quota exceeded' },
        }),
      });
      const error = provider.classifyResult(result);
      expect(error?.type).toBe('credit_exhaustion');
    });

    it('returns stderr classification when both are unknown', () => {
      const result = makeResult({ stderr: 'mysterious failure', stdout: 'no clue' });
      const error = provider.classifyResult(result);
      expect(error?.type).toBe('unknown');
      expect(error?.message).toContain('mysterious failure');
    });

    it('prefers stderr classification over stdout', () => {
      const result = makeResult({
        stderr: 'rate limit exceeded',
        stdout: 'insufficient credits',
      });
      const error = provider.classifyResult(result);
      expect(error?.type).toBe('rate_limit');
    });
  });
});
