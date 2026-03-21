import { describe, expect, it, jest } from '@jest/globals';

import { SentryConnector } from '../src/intake/sentry-connector.js';

describe('SentryConnector', () => {
  type FetchMock = jest.Mock<typeof globalThis.fetch>;

  function createConnector(fetchFn: FetchMock, baseUrl = 'https://sentry.io') {
    return new SentryConnector(
      {
        enabled: true,
        baseUrl,
        organization: 'acme-org',
        project: 'web-app',
        authTokenEnvVar: 'SENTRY_AUTH_TOKEN',
      },
      {
        env: { SENTRY_AUTH_TOKEN: 'secret-token-123' },
        fetch: fetchFn as typeof globalThis.fetch,
      }
    );
  }

  function mockJsonResponse(data: unknown, headers: Record<string, string> = {}) {
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(headers),
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response);
  }

  function mockErrorResponse(status: number, message: string) {
    return Promise.resolve({
      ok: false,
      status,
      headers: new Headers(),
      json: () => Promise.reject(new Error('Not JSON')),
      text: () => Promise.resolve(message),
    } as Response);
  }

  it('pulls issues via Sentry API and normalizes reports', async () => {
    const fetchFn = jest.fn().mockReturnValue(
      mockJsonResponse([
        {
          id: '12345',
          title: 'TypeError: Cannot read property of undefined',
          culprit: 'app/checkout.js',
          status: 'unresolved',
          level: 'error',
          permalink: 'https://sentry.io/organizations/acme-org/issues/12345/',
          firstSeen: '2026-03-10T10:00:00Z',
          lastSeen: '2026-03-10T11:00:00Z',
          count: 42,
          userCount: 15,
          metadata: {
            title: 'TypeError: Cannot read property of undefined',
            value: "Cannot read property 'price' of undefined",
            type: 'TypeError',
          },
          tags: [
            { key: 'environment', value: 'production' },
            { key: 'release', value: 'v1.2.3' },
          ],
        },
        {
          id: '67890',
          title: 'Warning in component render',
          status: 'ignored',
          level: 'warning',
          permalink: 'https://sentry.io/organizations/acme-org/issues/67890/',
          firstSeen: '2026-03-09T09:00:00Z',
          lastSeen: '2026-03-09T09:30:00Z',
          count: 3,
          userCount: 2,
          tags: [{ key: 'browser', value: 'chrome' }],
        },
      ])
    ) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pullReports({ limit: 10 });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://sentry.io/api/0/projects/acme-org/web-app/issues/?statsPeriod=14d&query=is%3Aunresolved&limit=10',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'Authorization': 'Bearer secret-token-123',
          'Content-Type': 'application/json',
        },
      })
    );
    expect(result).toEqual({
      reports: [
        {
          source: 'sentry',
          externalId: '12345',
          url: 'https://sentry.io/organizations/acme-org/issues/12345/',
          fingerprint: 'sentry:acme-org/web-app#12345',
          title: 'TypeError: Cannot read property of undefined',
          summary: "Cannot read property 'price' of undefined\nType: TypeError",
          severity: 'high',
          status: 'open',
          createdAt: '2026-03-10T10:00:00Z',
          updatedAt: '2026-03-10T11:00:00Z',
          resolvedAt: undefined,
          tags: ['environment:production', 'release:v1.2.3'],
          payload: {
            level: 'error',
            culprit: 'app/checkout.js',
            count: 42,
            userCount: 15,
            metadata: {
              title: 'TypeError: Cannot read property of undefined',
              value: "Cannot read property 'price' of undefined",
              type: 'TypeError',
            },
          },
        },
        {
          source: 'sentry',
          externalId: '67890',
          url: 'https://sentry.io/organizations/acme-org/issues/67890/',
          fingerprint: 'sentry:acme-org/web-app#67890',
          title: 'Warning in component render',
          summary: undefined,
          severity: 'medium',
          status: 'ignored',
          createdAt: '2026-03-09T09:00:00Z',
          updatedAt: '2026-03-09T09:30:00Z',
          resolvedAt: undefined,
          tags: ['browser:chrome'],
          payload: {
            level: 'warning',
            culprit: null,
            count: 3,
            userCount: 2,
            metadata: null,
          },
        },
      ],
      nextCursor: undefined,
    });
  });

  it('extracts next cursor from Link header when pagination is available', async () => {
    const fetchFn = jest.fn().mockReturnValue(
      mockJsonResponse(
        [
          {
            id: '12345',
            title: 'Test issue',
            status: 'unresolved',
            level: 'error',
            firstSeen: '2026-03-10T10:00:00Z',
            lastSeen: '2026-03-10T11:00:00Z',
          },
        ],
        {
          Link: '<https://sentry.io/api/0/projects/acme-org/web-app/issues/?cursor=abc123>; rel="next"; results="true"',
        }
      )
    ) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pullReports({ limit: 1 });

    expect(result.nextCursor).toBe('abc123');
  });

  it('uses cursor parameter for pagination', async () => {
    const fetchFn = jest.fn().mockReturnValue(mockJsonResponse([])) as FetchMock;
    const connector = createConnector(fetchFn);

    await connector.pullReports({ limit: 10, cursor: 'xyz789' });

    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('cursor=xyz789'),
      expect.any(Object)
    );
  });

  it('posts comment updates through Sentry API and returns the remote comment id', async () => {
    const fetchFn = jest.fn().mockReturnValue(mockJsonResponse({ id: '999' })) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pushUpdate({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      kind: 'comment',
      message: 'Internal task created as TASK-42',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://sentry.io/api/0/issues/12345/notes/',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Authorization': 'Bearer secret-token-123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Internal task created as TASK-42' }),
      })
    );
    expect(result).toEqual({ accepted: true, remoteId: '999' });
  });

  it('posts link updates with combined message and task ID', async () => {
    const fetchFn = jest.fn().mockReturnValue(mockJsonResponse({ id: '888' })) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pushUpdate({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      kind: 'link',
      message: 'Investigating this issue',
      linkedTaskId: 'TASK-99',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://sentry.io/api/0/issues/12345/notes/',
      expect.objectContaining({
        body: JSON.stringify({ text: 'Investigating this issue\n\nLinked internal task: TASK-99' }),
      })
    );
    expect(result).toEqual({ accepted: true, remoteId: '888' });
  });

  it('maps status updates to Sentry status writes', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(mockJsonResponse({ id: '12345' })) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pushUpdate({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      kind: 'status',
      status: 'resolved',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://sentry.io/api/0/issues/12345/',
      expect.objectContaining({
        method: 'PUT',
        headers: {
          'Authorization': 'Bearer secret-token-123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'resolved' }),
      })
    );
    expect(result).toEqual({ accepted: true, remoteId: '12345' });
  });

  it('posts optional comment after status update', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(mockJsonResponse({ id: '12345' }))
      .mockReturnValueOnce(mockJsonResponse({ id: '777' })) as FetchMock;
    const connector = createConnector(fetchFn);

    await connector.pushUpdate({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      kind: 'status',
      status: 'resolved',
      message: 'Fixed in commit abc123',
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://sentry.io/api/0/issues/12345/',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'resolved' }),
      })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://sentry.io/api/0/issues/12345/notes/',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Fixed in commit abc123' }),
      })
    );
  });

  it('notifies resolution by updating status and posting a comment', async () => {
    const fetchFn = jest.fn()
      .mockReturnValueOnce(mockJsonResponse({ id: '12345' }))
      .mockReturnValueOnce(mockJsonResponse({ id: '666' })) as FetchMock;
    const connector = createConnector(fetchFn);

    await connector.notifyResolution({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      resolvedAt: '2026-03-12T11:30:00Z',
      resolution: 'fixed',
      message: 'Deployed fix in production.',
    });

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      'https://sentry.io/api/0/issues/12345/',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ status: 'resolved' }),
      })
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      'https://sentry.io/api/0/issues/12345/notes/',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Deployed fix in production.' }),
      })
    );
  });

  it('maps wontfix resolution to ignored status', async () => {
    const fetchFn = jest.fn().mockReturnValue(mockJsonResponse({ id: '12345' })) as FetchMock;
    const connector = createConnector(fetchFn);

    await connector.notifyResolution({
      report: {
        source: 'sentry',
        externalId: '12345',
        url: 'https://sentry.io/organizations/acme-org/issues/12345/',
      },
      resolvedAt: '2026-03-12T11:30:00Z',
      resolution: 'wontfix',
    });

    expect(fetchFn).toHaveBeenCalledWith(
      'https://sentry.io/api/0/issues/12345/',
      expect.objectContaining({
        body: JSON.stringify({ status: 'ignored' }),
      })
    );
  });

  it('throws on API errors with response status and message', async () => {
    const fetchFn = jest.fn().mockReturnValue(
      mockErrorResponse(403, 'Forbidden: Invalid auth token')
    ) as FetchMock;
    const connector = createConnector(fetchFn);

    await expect(connector.pullReports({ limit: 10 })).rejects.toThrow(
      'Sentry API request failed with status 403: Forbidden: Invalid auth token'
    );
  });

  it('throws when required config fields are missing', () => {
    expect(() => {
      new SentryConnector(
        {
          enabled: true,
          baseUrl: '',
          organization: 'acme-org',
          project: 'web-app',
          authTokenEnvVar: 'SENTRY_AUTH_TOKEN',
        },
        { env: { SENTRY_AUTH_TOKEN: 'token' } }
      );
    }).not.toThrow();

    const connector = new SentryConnector(
      {
        enabled: true,
        baseUrl: '',
        organization: 'acme-org',
        project: 'web-app',
        authTokenEnvVar: 'SENTRY_AUTH_TOKEN',
      },
      { env: { SENTRY_AUTH_TOKEN: 'token' } }
    );

    expect(
      connector.pullReports({ limit: 10 })
    ).rejects.toThrow('Sentry intake connector requires baseUrl');
  });

  it('throws when auth token env var is not set', async () => {
    const fetchFn = jest.fn() as FetchMock;
    const connector = new SentryConnector(
      {
        enabled: true,
        baseUrl: 'https://sentry.io',
        organization: 'acme-org',
        project: 'web-app',
        authTokenEnvVar: 'MISSING_TOKEN',
      },
      { env: {}, fetch: fetchFn as typeof globalThis.fetch }
    );

    await expect(connector.pullReports({ limit: 10 })).rejects.toThrow(
      'Sentry intake connector could not read auth token from env var MISSING_TOKEN'
    );
  });

  it('throws when pushing updates to non-Sentry reports', async () => {
    const fetchFn = jest.fn() as FetchMock;
    const connector = createConnector(fetchFn);

    await expect(
      connector.pushUpdate({
        report: {
          source: 'github',
          externalId: '12',
          url: 'https://github.com/acme/repo/issues/12',
        },
        kind: 'comment',
        message: 'Test',
      })
    ).rejects.toThrow('Sentry intake connector cannot handle github reports');
  });

  it('infers severity from Sentry level field', async () => {
    const fetchFn = jest.fn().mockReturnValue(
      mockJsonResponse([
        { id: '1', title: 'Fatal', status: 'unresolved', level: 'fatal', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
        { id: '2', title: 'Error', status: 'unresolved', level: 'error', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
        { id: '3', title: 'Warning', status: 'unresolved', level: 'warning', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
        { id: '4', title: 'Info', status: 'unresolved', level: 'info', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
        { id: '5', title: 'Debug', status: 'unresolved', level: 'debug', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z' },
      ])
    ) as FetchMock;
    const connector = createConnector(fetchFn);

    const result = await connector.pullReports({ limit: 10 });

    expect(result.reports.map((r) => ({ id: r.externalId, severity: r.severity }))).toEqual([
      { id: '1', severity: 'critical' },
      { id: '2', severity: 'high' },
      { id: '3', severity: 'medium' },
      { id: '4', severity: 'low' },
      { id: '5', severity: 'info' },
    ]);
  });
});
