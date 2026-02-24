/**
 * Gemini Provider Tests
 */

import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GeminiProvider } from '../src/providers/gemini.js';
import { SessionNotFoundError } from '../src/providers/interface.js';

describe('GeminiProvider', () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('gemini');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('Google (gemini)');
    });
  });

  describe('persistent home', () => {
    it('should use project-scoped persistent home when .steroids exists', () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'gemini-provider-project-'));
      mkdirSync(join(projectDir, '.steroids'), { recursive: true });

      try {
        const result = (provider as any).getPersistentHome(projectDir);
        expect(result.isPersistent).toBe(true);
        expect(result.home).toContain('.steroids');
        expect(result.home).toContain(join('provider-homes', 'gemini'));
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });

  describe('session markers', () => {
    it('should remember and detect resumable sessions', () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'gemini-provider-home-'));
      const sessionId = 'test-session-123';

      try {
        expect((provider as any).hasRememberedSession(homeDir, sessionId)).toBe(false);
        (provider as any).rememberSession(homeDir, sessionId);
        expect((provider as any).hasRememberedSession(homeDir, sessionId)).toBe(true);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('native session artifacts', () => {
    it('should detect native session file hints for resume compatibility', () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'gemini-provider-native-'));
      const sessionId = 'native-session-abc';
      const nativeDir = join(homeDir, '.vibe', 'logs', 'session');

      try {
        mkdirSync(nativeDir, { recursive: true });
        mkdirSync(join(nativeDir, `${sessionId}-folder`), { recursive: true });
        expect((provider as any).hasNativeSessionArtifact(homeDir, sessionId)).toBe(true);
      } finally {
        rmSync(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('resume preflight', () => {
    it('should reject unknown resume session deterministically before provider run', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'gemini-provider-resume-'));
      mkdirSync(join(projectDir, '.steroids'), { recursive: true });

      try {
        await expect(
          provider.invoke('test prompt', {
            model: 'gemini-2.5-flash',
            cwd: projectDir,
            streamOutput: false,
            resumeSessionId: 'missing-session-id',
          })
        ).rejects.toBeInstanceOf(SessionNotFoundError);
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });
});
