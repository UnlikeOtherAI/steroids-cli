import { describe, it, expect, afterEach } from '@jest/globals';
import { startProxy, stopProxy, isProxyRunning, ensureProxy } from '../src/proxy/lifecycle.js';

describe('HF Proxy lifecycle', () => {
  afterEach(() => {
    try { stopProxy(); } catch { /* ignore */ }
  });

  it('starts and stops the proxy', async () => {
    const { port, pid } = await startProxy({
      hfToken: 'hf_test',
      hfBaseUrl: 'https://router.huggingface.co/v1',
      port: 0, // random port
    });
    expect(port).toBeGreaterThan(0);
    expect(pid).toBeGreaterThan(0);
    expect(isProxyRunning()).toBe(true);

    stopProxy();
    await new Promise((r) => setTimeout(r, 100));
    expect(isProxyRunning()).toBe(false);
  });

  it('ensureProxy is idempotent', async () => {
    const port1 = await ensureProxy({ hfToken: 'hf_test', hfBaseUrl: 'https://router.huggingface.co/v1', port: 0 });
    const port2 = await ensureProxy({ hfToken: 'hf_test', hfBaseUrl: 'https://router.huggingface.co/v1', port: 0 });
    expect(port1).toBe(port2);
  });
});
