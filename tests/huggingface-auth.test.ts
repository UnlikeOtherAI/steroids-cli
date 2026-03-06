import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HuggingFaceTokenAuth } from '../src/huggingface/auth.js';
import { HubAPIError } from '../src/huggingface/hub-client.js';

describe('HuggingFaceTokenAuth', () => {
  const getWhoAmIWithHeaders = jest.fn<(token: string) => Promise<any>>();
  let tokenDir: string;
  let tokenPath: string;

  beforeEach(() => {
    getWhoAmIWithHeaders.mockReset();
    tokenDir = mkdtempSync(join(tmpdir(), 'hf-auth-'));
    tokenPath = join(tokenDir, 'token');
  });

  afterEach(() => {
    rmSync(tokenDir, { recursive: true, force: true });
  });

  it('stores token with restrictive permissions', () => {
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmIWithHeaders } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');

    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe('hf_secret');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenDir).mode & 0o777).toBe(0o700);
  });

  it('validates token and flags broad scopes', async () => {
    getWhoAmIWithHeaders.mockResolvedValueOnce({
      account: {
        name: 'user-1',
        isPro: true,
        auth: {
          accessToken: {
            scopes: ['read', 'inference', 'write'],
          },
        },
      },
      rateLimit: '\"api\";r=900;t=60',
      rateLimitPolicy: '\"fixed window\";\"api\";q=1000;w=300',
    });

    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmIWithHeaders } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');
    const result = await auth.validateToken();

    expect(result.valid).toBe(true);
    expect(result.hasBroadScopes).toBe(true);
    expect(result.scopes).toEqual(['read', 'inference', 'write']);
    expect(result.rateLimit).toMatchObject({
      remaining: 900,
      limit: 1000,
    });
  });

  it('returns invalid for unauthorized token', async () => {
    getWhoAmIWithHeaders.mockRejectedValueOnce(new HubAPIError('Unauthorized', 401));
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmIWithHeaders } as any,
      tokenFilePath: tokenPath,
    });

    const result = await auth.validateToken('hf_invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid Hugging Face token');
  });

  it('flags broad token role from whoami metadata', async () => {
    getWhoAmIWithHeaders.mockResolvedValueOnce({
      account: {
        name: 'user-2',
        auth: {
          accessToken: {
            role: 'admin',
          },
        },
      },
    });

    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmIWithHeaders } as any,
      tokenFilePath: tokenPath,
    });

    const result = await auth.validateToken('hf_admin_token');
    expect(result.valid).toBe(true);
    expect(result.hasBroadScopes).toBe(true);
  });

  it('clears token from disk', () => {
    const auth = new HuggingFaceTokenAuth({
      client: { getWhoAmIWithHeaders } as any,
      tokenFilePath: tokenPath,
    });

    auth.saveToken('hf_secret');
    expect(auth.hasToken()).toBe(true);
    auth.clearToken();
    expect(auth.hasToken()).toBe(false);
    expect(auth.getToken()).toBeNull();
  });
});
