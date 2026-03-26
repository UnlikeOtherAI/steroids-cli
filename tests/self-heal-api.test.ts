import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockScheduleReloadSelfHeal = jest.fn();

jest.unstable_mockModule('../dist/self-heal/reload-sweep.js', () => ({
  scheduleReloadSelfHeal: mockScheduleReloadSelfHeal,
}));

const { createApp } = await import('../API/src/index.js');

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unexpected address'));
        return;
      }
      resolve(address.port);
    });
  });
}

describe('self-heal API route', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockScheduleReloadSelfHeal.mockReturnValue({ scheduled: true, reason: 'scheduled' });

    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts a valid reload request and schedules the sweep', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'task_page', projectPath: '/tmp/project-a' }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(expect.objectContaining({
      success: true,
      scheduled: true,
      reason: 'scheduled',
    }));
    expect(mockScheduleReloadSelfHeal).toHaveBeenCalledWith({
      source: 'task_page',
      projectPath: '/tmp/project-a',
    });
  });

  it('rejects invalid request bodies without scheduling', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/self-heal/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'unknown' }),
    });

    expect(response.status).toBe(400);
    expect(mockScheduleReloadSelfHeal).not.toHaveBeenCalled();
  });
});
