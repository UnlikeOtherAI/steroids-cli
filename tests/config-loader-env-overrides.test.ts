import { afterEach, describe, expect, it } from '@jest/globals';
import { applyEnvOverrides } from '../src/config/loader.js';

describe('applyEnvOverrides reviewers parser', () => {
  const originalReviewersEnv = process.env.STEROIDS_AI_REVIEWERS;

  afterEach(() => {
    if (originalReviewersEnv === undefined) {
      delete process.env.STEROIDS_AI_REVIEWERS;
      return;
    }
    process.env.STEROIDS_AI_REVIEWERS = originalReviewersEnv;
  });

  it('preserves model names that contain additional colons', () => {
    process.env.STEROIDS_AI_REVIEWERS = 'ollama:deepseek-coder-v2:33b,claude:claude-sonnet-4-6';

    const result = applyEnvOverrides({});

    expect(result.ai?.reviewers).toEqual([
      { provider: 'ollama', model: 'deepseek-coder-v2:33b' },
      { provider: 'claude', model: 'claude-sonnet-4-6' },
    ]);
  });
});
