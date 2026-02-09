/**
 * Tests for webhook hook runner
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { executeWebhook, parseTimeout, validateWebhookConfig } from '../src/hooks/webhook-runner.js';
import type { HookPayload } from '../src/hooks/payload.js';

// Mock fetch for testing
const mockFetch: any = jest.fn();
global.fetch = mockFetch;

// Helper to create mock Response
const mockResponse = (options: {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}): any => ({
  ok: options.ok,
  status: options.status,
  statusText: options.statusText,
  text: async () => options.body,
});

describe('parseTimeout', () => {
  it('should parse number as seconds', () => {
    expect(parseTimeout(30)).toBe(30000);
    expect(parseTimeout(60)).toBe(60000);
  });

  it('should parse timeout strings', () => {
    expect(parseTimeout('30s')).toBe(30000);
    expect(parseTimeout('5m')).toBe(300000);
    expect(parseTimeout('1h')).toBe(3600000);
  });

  it('should use default timeout when undefined', () => {
    expect(parseTimeout(undefined)).toBe(30000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseTimeout('invalid')).toThrow('Invalid timeout format');
    expect(() => parseTimeout('30x')).toThrow('Invalid timeout format');
  });
});

describe('validateWebhookConfig', () => {
  it('should validate correct config', () => {
    const result = validateWebhookConfig({
      name: 'test-hook',
      url: 'https://example.com/webhook',
      method: 'POST',
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject missing name', () => {
    const result = validateWebhookConfig({
      name: '',
      url: 'https://example.com',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
  });

  it('should reject missing url', () => {
    const result = validateWebhookConfig({
      name: 'test',
      url: '',
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: url');
  });

  it('should reject invalid HTTP method', () => {
    const result = validateWebhookConfig({
      name: 'test',
      url: 'https://example.com',
      method: 'INVALID' as any,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid HTTP method'))).toBe(true);
  });

  it('should reject invalid retry count', () => {
    const result = validateWebhookConfig({
      name: 'test',
      url: 'https://example.com',
      retry: 20,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Retry count must be between 0 and 10');
  });
});

describe('executeWebhook', () => {
  const mockPayload: HookPayload = {
    event: 'task.completed',
    timestamp: '2024-01-01T00:00:00Z',
    project: {
      name: 'test-project',
      path: '/path/to/project',
    },
    task: {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TEST_TOKEN;
  });

  it('should execute successful webhook', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'Success' })
    );

    const result = await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        method: 'POST',
        body: { message: 'Hello' },
      },
      mockPayload
    );

    expect(result.success).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.responseBody).toBe('Success');
    expect(result.retries).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should template URL variables', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'OK' })
    );

    await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/{{task.id}}',
      },
      mockPayload
    );

    expect(mockFetch).toHaveBeenCalledWith('https://example.com/task-123', expect.any(Object));
  });

  it('should resolve environment variables in headers', async () => {
    process.env.API_TOKEN = 'secret-token-123';

    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'OK' })
    );

    await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        headers: {
          Authorization: 'Bearer ${API_TOKEN}',
        },
      },
      mockPayload
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer secret-token-123',
        },
      })
    );

    delete process.env.API_TOKEN;
  });

  it('should retry on 5xx errors with exponential backoff', async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 503, statusText: 'Service Unavailable', body: 'Error' })
      )
      .mockResolvedValueOnce(
        mockResponse({ ok: false, status: 500, statusText: 'Internal Server Error', body: 'Error' })
      )
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'Success' })
      );

    const result = await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        retry: 3,
      },
      mockPayload
    );

    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should not retry on 4xx client errors', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid' })
    );

    const result = await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        retry: 3,
      },
      mockPayload
    );

    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(400);
    expect(result.retries).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should handle network errors with retry', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce(
        mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'Success' })
      );

    const result = await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        retry: 3,
      },
      mockPayload
    );

    expect(result.success).toBe(true);
    expect(result.retries).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should combine environment variables and template variables', async () => {
    process.env.API_KEY = 'secret-key';

    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, statusText: 'OK', body: 'OK' })
    );

    await executeWebhook(
      {
        name: 'test-hook',
        url: 'https://example.com/webhook',
        headers: {
          'X-API-Key': '${API_KEY}',
          'X-Task-ID': '{{task.id}}',
        },
      },
      mockPayload
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        headers: {
          'X-API-Key': 'secret-key',
          'X-Task-ID': 'task-123',
        },
      })
    );

    delete process.env.API_KEY;
  });
});
