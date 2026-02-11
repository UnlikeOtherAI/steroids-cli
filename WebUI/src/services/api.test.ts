import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creditAlertsApi, projectsApi, API_BASE_URL } from './api';

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

describe('projectsApi', () => {
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

  describe('getStorage', () => {
    it('sends GET to /api/projects/storage with encoded path', async () => {
      const storageData = {
        total_bytes: 52428800,
        total_human: '50.0 MB',
        breakdown: {
          database: { bytes: 2097152, human: '2.0 MB' },
          invocations: { bytes: 35651584, human: '34.0 MB', file_count: 847 },
          logs: { bytes: 12582912, human: '12.0 MB', file_count: 423 },
          backups: { bytes: 2097152, human: '2.0 MB', backup_count: 3 },
          other: { bytes: 0, human: '0 B' },
        },
        clearable_bytes: 48234496,
        clearable_human: '46.0 MB',
        threshold_warning: null,
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(storageData));

      const result = await projectsApi.getStorage('/my/project');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/projects/storage?path=${encodeURIComponent('/my/project')}`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
      expect(result).toEqual(storageData);
    });

    it('encodes special characters in project path', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ total_bytes: 0, total_human: '0 B' }));

      await projectsApi.getStorage('/path/with spaces & special');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/projects/storage?path=${encodeURIComponent('/path/with spaces & special')}`,
        expect.anything(),
      );
    });
  });

  describe('clearLogs', () => {
    it('sends POST to /api/projects/clear-logs with path and retention_days', async () => {
      const clearResult = {
        ok: true,
        deleted_files: 100,
        freed_bytes: 48234496,
        freed_human: '46.0 MB',
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(clearResult));

      const result = await projectsApi.clearLogs('/my/project', 7);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/projects/clear-logs`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/my/project', retention_days: 7 }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
      expect(result).toEqual(clearResult);
    });

    it('uses default retention of 7 days when not specified', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, deleted_files: 0, freed_bytes: 0, freed_human: '0 B' }));

      await projectsApi.clearLogs('/my/project');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/projects/clear-logs`,
        expect.objectContaining({
          body: JSON.stringify({ path: '/my/project', retention_days: 7 }),
        }),
      );
    });

    it('encodes project path in the JSON payload', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true, deleted_files: 0, freed_bytes: 0, freed_human: '0 B' }));

      await projectsApi.clearLogs('/path/with spaces & special', 14);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/api/projects/clear-logs`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/path/with spaces & special', retention_days: 14 }),
        }),
      );
    });
  });
});
