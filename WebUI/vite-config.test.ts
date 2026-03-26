// @vitest-environment node
import { describe, expect, it } from 'vitest';
import config from './vite.config';

describe('vite host policy', () => {
  it('allows remote hosts in dev and preview mode', () => {
    expect(config.server?.host).toBe('0.0.0.0');
    expect(config.server?.allowedHosts).toBe(true);
    expect(config.preview?.host).toBe('0.0.0.0');
    expect(config.preview?.allowedHosts).toBe(true);
  });
});
