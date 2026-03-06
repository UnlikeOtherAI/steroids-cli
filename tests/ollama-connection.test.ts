import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  getResolvedConnectionConfig,
  getCloudApiKey,
  getOllamaTokenPath,
  isVersionSupported,
  loadConnectionConfig,
  setCloudConnection,
  setLocalConnection,
  testConnection,
} from '../src/ollama/connection.js';

describe('ollama connection config', () => {
  const originalHome = process.env.HOME;
  const originalSteroidsHome = process.env.STEROIDS_HOME;
  const originalHost = process.env.STEROIDS_OLLAMA_HOST;
  const originalPort = process.env.STEROIDS_OLLAMA_PORT;
  const originalApiKey = process.env.OLLAMA_API_KEY;
  const originalFetch = global.fetch;

  let tempHome = '';
  let fetchMock: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    tempHome = mkdtempSync(join('/tmp', 'steroids-ollama-connection-'));
    process.env.HOME = tempHome;
    process.env.STEROIDS_HOME = tempHome;
    delete process.env.STEROIDS_OLLAMA_HOST;
    delete process.env.STEROIDS_OLLAMA_PORT;
    delete process.env.OLLAMA_API_KEY;
    fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalSteroidsHome === undefined) {
      delete process.env.STEROIDS_HOME;
    } else {
      process.env.STEROIDS_HOME = originalSteroidsHome;
    }

    if (originalHost === undefined) {
      delete process.env.STEROIDS_OLLAMA_HOST;
    } else {
      process.env.STEROIDS_OLLAMA_HOST = originalHost;
    }

    if (originalPort === undefined) {
      delete process.env.STEROIDS_OLLAMA_PORT;
    } else {
      process.env.STEROIDS_OLLAMA_PORT = originalPort;
    }

    if (originalApiKey === undefined) {
      delete process.env.OLLAMA_API_KEY;
    } else {
      process.env.OLLAMA_API_KEY = originalApiKey;
    }

    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
    }

    global.fetch = originalFetch;
  });

  it('persists local config and reloads it', () => {
    setLocalConnection('http://localhost:12434');

    const config = loadConnectionConfig();
    expect(config).toMatchObject({
      endpoint: 'http://localhost:12434',
      mode: 'local',
    });
  });

  it('writes cloud token with 0600 permissions', () => {
    setCloudConnection('secret-token', 'https://ollama.com');

    const tokenPath = join(tempHome, '.steroids', 'ollama', 'token');
    expect(readFileSync(tokenPath, 'utf8')).toBe('secret-token');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(getCloudApiKey()).toBe('secret-token');
  });

  it('uses env host/port override over file config endpoint', () => {
    setLocalConnection('http://localhost:11434');
    process.env.STEROIDS_OLLAMA_HOST = '127.0.0.1';
    process.env.STEROIDS_OLLAMA_PORT = '12400';

    const resolved = getResolvedConnectionConfig();

    expect(resolved.endpoint).toBe('http://127.0.0.1:12400');
  });

  it('checks minimum version support correctly', () => {
    expect(isVersionSupported('0.1.14')).toBe(true);
    expect(isVersionSupported('0.1.13')).toBe(false);
    expect(isVersionSupported('v0.6.2')).toBe(true);
  });

  it('rejects local connection when health endpoint body is not Ollama sentinel', async () => {
    fetchMock.mockResolvedValue(
      new Response('hello from nginx', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const status = await testConnection({
      endpoint: 'http://localhost:11434',
      mode: 'local',
      cloudTier: null,
    });

    expect(status.connected).toBe(false);
    expect(status.error).toContain('endpoint is not an Ollama instance');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears persisted cloud token after 401 during cloud validation', async () => {
    setCloudConnection('bad-token', 'https://ollama.com');
    const tokenPath = getOllamaTokenPath();
    expect(existsSync(tokenPath)).toBe(true);

    fetchMock.mockResolvedValue(
      new Response('unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const status = await testConnection({
      endpoint: 'https://ollama.com',
      mode: 'cloud',
      cloudTier: null,
    });

    expect(status.connected).toBe(false);
    expect(existsSync(tokenPath)).toBe(false);
  });
});
