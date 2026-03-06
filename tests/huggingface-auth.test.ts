import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuggingFaceTokenAuth } from '../src/huggingface/auth.js';
import { HubAPIError } from '../src/huggingface/hub-client.js';

describe('HuggingFaceTokenAuth', () => {
  const getWhoAmI = jest.fn<(token: string) => Promise<any>>();
  let tokenDir: string;
  let tokenPath: string;

  beforeEach(() => {
    getWhoAmI.mockReset();
    tokenDir = mkdtempSync(join(tmpdir(), 'hf-auth-'));
    tokenPath = join(tokenDir, 'token');
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  it('stores token with restrictive permissions', () => {
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmI } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');

    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe('hf_secret');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
  });

  it('validates token and flags broad scopes', async () => {
    getWhoAmI.mockResolvedValueOnce({
      name: 'user-1',
      isPro: true,
      auth: {
        accessToken: {
          scopes: ['read', 'inference', 'write'],
        },
      },
    });

    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmI } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');
    const result = await auth.validateToken();

    expect(result.valid).toBe(true);
    expect(result.hasBroadScopes).toBe(true);
    expect(result.scopes).toEqual(['read', 'inference', 'write']);
  });

  it('returns invalid for unauthorized token', async () => {
    getWhoAmI.mockRejectedValueOnce(new HubAPIError('Unauthorized', 401));
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmI } as any,
      tokenFilePath: tokenPath,
    });

    const result = await auth.validateToken('hf_invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid Hugging Face token');
  });

  it('clears token from disk', () => {
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmI } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');
    expect(auth.hasToken()).toBe(true);
    auth.clearToken();
    expect(auth.hasToken()).toBe(false);
    expect(auth.getToken()).toBeNull();
  });
});
