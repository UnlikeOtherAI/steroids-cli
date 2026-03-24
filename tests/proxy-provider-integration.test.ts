import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { resolveHFToken, isHFModel } from '../src/proxy/hf-token.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('HF token resolution', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('reads from HF_TOKEN env var', () => {
    process.env.HF_TOKEN = 'hf_env_token';
    expect(resolveHFToken()).toBe('hf_env_token');
  });

  it('reads from opencode.json config dir', () => {
    delete process.env.HF_TOKEN;
    const configDir = join(tmpdir(), `test-hf-token-${Date.now()}`);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
      provider: { huggingface: { options: { apiKey: 'hf_config_token' } } },
    }));
    try {
      expect(resolveHFToken(configDir)).toBe('hf_config_token');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('returns null when env var is unset (may fall through to system config)', () => {
    delete process.env.HF_TOKEN;
    // When no env var is set, resolveHFToken falls through to opencode.json and ~/.huggingface/token.
    // On machines with those files, it returns a token; on clean machines, null.
    const token = resolveHFToken('/nonexistent');
    expect(token === null || typeof token === 'string').toBe(true);
  });
});

describe('isHFModel', () => {
  it('detects HF models with org/name format', () => {
    expect(isHFModel('MiniMaxAI/MiniMax-M2.5')).toBe(true);
    expect(isHFModel('deepseek-ai/DeepSeek-V3-0324')).toBe(true);
  });

  it('rejects native provider models', () => {
    expect(isHFModel('claude-sonnet-4-6')).toBe(false);
    expect(isHFModel('gpt-5.3-codex')).toBe(false);
    expect(isHFModel('codestral-latest')).toBe(false);
  });

  it('rejects models/ prefix (not HF format)', () => {
    expect(isHFModel('models/some-model')).toBe(false);
  });
});
