import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creditAlertsApi, API_BASE_URL } from './api';

describe('creditAlertsApi', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockJsonResponse(data: unknown, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
    };
  }

  describe('getActive', () => {
    it('fetches active alerts without project filter', async () => {
      const alerts = [
        { id: '1', provider: 'claude', model: 'opus', role: 'coder', message: 'Out of credits', createdAt: '2025-01-01T00:00:00Z' },
      ];
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ alerts }));

      const result = await creditAlertsApi.getActive();

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
      expect(result).toEqual(alerts);
    });

    it('fetches active alerts with project filter', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ alerts: [] }));

      await creditAlertsApi.getActive('/my/project');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts?project=${encodeURIComponent('/my/project')}`,
        expect.anything(),
      );
    });

    it('returns empty array when no alerts', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ alerts: [] }));

      const result = await creditAlertsApi.getActive();

      expect(result).toEqual([]);
    });
  });

  describe('dismiss', () => {
    it('sends POST with project in JSON body', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await creditAlertsApi.dismiss('alert-123', '/my/project');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts/alert-123/dismiss`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ project: '/my/project' }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });

    it('encodes alert ID in the URL', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await creditAlertsApi.dismiss('alert/special chars', '/proj');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts/${encodeURIComponent('alert/special chars')}/dismiss`,
        expect.anything(),
      );
    });
  });

  describe('retry', () => {
    it('sends POST with project in JSON body', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await creditAlertsApi.retry('alert-456', '/my/project');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts/alert-456/retry`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ project: '/my/project' }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
    });

    it('encodes alert ID in the URL', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));

      await creditAlertsApi.retry('alert/special', '/proj');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/credit-alerts/${encodeURIComponent('alert/special')}/retry`,
        expect.anything(),
      );
    });
  });
});
