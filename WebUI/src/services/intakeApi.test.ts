import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from './api';
import { intakeApi } from './intakeApi';

describe('intakeApi', () => {
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

  it('lists reports with encoded filters', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        success: true,
        project: '/tmp/project path',
        total: 1,
        reports: [],
      }),
    );

    await intakeApi.listReports('/tmp/project path', {
      source: 'github',
      hasLinkedTask: false,
      limit: 25,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/intake/reports?project=%2Ftmp%2Fproject+path&source=github&hasLinkedTask=false&limit=25`,
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('loads a single report by source and external id', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        success: true,
        project: '/tmp/project',
        report: {
          source: 'github',
          externalId: '101',
        },
      }),
    );

    await intakeApi.getReport('/tmp/project', 'github', 'issue/101');

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/intake/reports/github/issue%2F101?project=%2Ftmp%2Fproject`,
      expect.anything(),
    );
  });

  it('sends patch updates in the request body', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        success: true,
        project: '/tmp/project',
        report: {
          source: 'github',
          externalId: '101',
          status: 'resolved',
        },
      }),
    );

    await intakeApi.updateReport('/tmp/project', 'github', '101', {
      status: 'resolved',
      linkedTaskId: null,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/intake/reports/github/101`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          project: '/tmp/project',
          status: 'resolved',
          linkedTaskId: null,
        }),
      }),
    );
  });

  it('throws ApiError for unsuccessful responses', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({ error: 'Unsupported intake source: jira' }, 400),
    );

    await expect(intakeApi.getStats('/tmp/project')).rejects.toEqual(
      expect.objectContaining({
        message: 'Unsupported intake source: jira',
        status: 400,
      }),
    );
  });
});
