import { describe, expect, it, jest } from '@jest/globals';

import { GitHubIssuesConnector } from '../src/intake/github-issues-connector.js';

describe('GitHubIssuesConnector', () => {
  type GhRunner = (args: string[], env: NodeJS.ProcessEnv) => string;

  function createConnector(
    runGhCommand: GhRunner,
    apiBaseUrl = 'https://api.github.com'
  ) {
    return new GitHubIssuesConnector(
      {
        enabled: true,
        apiBaseUrl,
        owner: 'acme',
        repo: 'widgets',
        tokenEnvVar: 'CUSTOM_GH_TOKEN',
        labels: ['bug', 'customer'],
      },
      {
        env: { CUSTOM_GH_TOKEN: 'secret-token' },
        runGhCommand,
      }
    );
  }

  it('pulls issues via gh api, filters pull requests, and normalizes reports', async () => {
    const runGhCommand = jest.fn().mockReturnValue(
      JSON.stringify([
        {
          number: 12,
          title: 'Checkout throws on empty cart',
          body: 'Steps to reproduce',
          state: 'open',
          state_reason: null,
          html_url: 'https://github.com/acme/widgets/issues/12',
          created_at: '2026-03-10T10:00:00Z',
          updated_at: '2026-03-10T11:00:00Z',
          labels: [{ name: 'bug' }, { name: 'sev:1' }, { name: 'triaged' }],
          user: { login: 'octocat' },
          comments: 2,
        },
        {
          number: 99,
          title: 'Ignore PR payloads',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/99',
          created_at: '2026-03-10T09:00:00Z',
          updated_at: '2026-03-10T09:30:00Z',
          pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/99' },
        },
        {
          number: 100,
          title: 'Internal intake approval gate',
          body: 'Approve or reject this intake report',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/issues/100',
          created_at: '2026-03-10T09:40:00Z',
          updated_at: '2026-03-10T09:50:00Z',
          labels: [{ name: 'steroids:intake-gate' }, { name: 'steroids:intake-awaiting-approval' }],
        },
      ])
    ) as GhRunner;
    const connector = createConnector(runGhCommand);

    const result = await connector.pullReports({
      limit: 3,
      since: '2026-03-10T00:00:00Z',
    });

    expect(runGhCommand).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'GET',
        'repos/acme/widgets/issues',
        '-f',
        'state=all',
        '-f',
        'sort=updated',
        '-f',
        'direction=asc',
        '-f',
        'per_page=3',
        '-f',
        'page=1',
        '-f',
        'since=2026-03-10T00:00:00Z',
        '-f',
        'labels=bug,customer',
      ],
      expect.objectContaining({
        CUSTOM_GH_TOKEN: 'secret-token',
        GH_TOKEN: 'secret-token',
        GITHUB_TOKEN: 'secret-token',
      })
    );
    expect(result).toEqual({
      reports: [
        {
          source: 'github',
          externalId: '12',
          url: 'https://github.com/acme/widgets/issues/12',
          fingerprint: 'github:acme/widgets#12',
          title: 'Checkout throws on empty cart',
          summary: 'Steps to reproduce',
          severity: 'high',
          status: 'triaged',
          createdAt: '2026-03-10T10:00:00Z',
          updatedAt: '2026-03-10T11:00:00Z',
          resolvedAt: undefined,
          tags: ['bug', 'sev:1', 'triaged'],
          payload: {
            body: 'Steps to reproduce',
            state: 'open',
            stateReason: null,
            authorLogin: 'octocat',
            commentCount: 2,
          },
        },
      ],
      nextCursor: '2',
    });
  });

  it('posts comment updates through gh api and returns the remote comment id', async () => {
    const runGhCommand = jest.fn().mockReturnValue('456') as GhRunner;
    const connector = createConnector(runGhCommand);

    const result = await connector.pushUpdate({
      report: {
        source: 'github',
        externalId: '12',
        url: 'https://github.com/acme/widgets/issues/12',
      },
      kind: 'comment',
      message: 'Internal task created as TASK-42',
    });

    expect(runGhCommand).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/acme/widgets/issues/12/comments',
        '-f',
        'body=Internal task created as TASK-42',
        '--jq',
        '.id',
      ],
      expect.objectContaining({
        GH_TOKEN: 'secret-token',
      })
    );
    expect(result).toEqual({ accepted: true, remoteId: '456' });
  });

  it('maps status updates to deterministic issue state writes and optional comments', async () => {
    const runGhCommand = jest.fn().mockReturnValueOnce('12').mockReturnValueOnce('789') as GhRunner;
    const connector = createConnector(runGhCommand);

    const result = await connector.pushUpdate({
      report: {
        source: 'github',
        externalId: '12',
        url: 'https://github.com/acme/widgets/issues/12',
      },
      kind: 'status',
      status: 'resolved',
      message: 'Fixed in commit abc123',
    });

    expect(runGhCommand).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'PATCH',
        'repos/acme/widgets/issues/12',
        '-f',
        'state=closed',
        '-f',
        'state_reason=completed',
        '--jq',
        '.id',
      ],
      expect.any(Object)
    );
    expect(runGhCommand).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/acme/widgets/issues/12/comments',
        '-f',
        'body=Fixed in commit abc123',
        '--jq',
        '.id',
      ],
      expect.any(Object)
    );
    expect(result).toEqual({ accepted: true, remoteId: '12' });
  });

  it('uses enterprise host routing and enterprise token env vars for GitHub Enterprise', async () => {
    const runGhCommand = jest.fn().mockReturnValue('[]') as GhRunner;
    const connector = createConnector(runGhCommand, 'https://github.example.com/api/v3');

    await connector.pullReports({ limit: 1, cursor: '2' });

    expect(runGhCommand).toHaveBeenCalledWith(
      expect.arrayContaining(['--hostname', 'github.example.com']),
      expect.objectContaining({
        CUSTOM_GH_TOKEN: 'secret-token',
        GH_HOST: 'github.example.com',
        GH_ENTERPRISE_TOKEN: 'secret-token',
        GITHUB_ENTERPRISE_TOKEN: 'secret-token',
      })
    );
  });

  it('notifies resolution by closing the issue with a mapped reason and comment', async () => {
    const runGhCommand = jest.fn().mockReturnValueOnce('12').mockReturnValueOnce('991') as GhRunner;
    const connector = createConnector(runGhCommand);

    await connector.notifyResolution({
      report: {
        source: 'github',
        externalId: '12',
        url: 'https://github.com/acme/widgets/issues/12',
      },
      resolvedAt: '2026-03-12T11:30:00Z',
      resolution: 'wontfix',
      message: 'Closing after triage review.',
    });

    expect(runGhCommand).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'PATCH',
        'repos/acme/widgets/issues/12',
        '-f',
        'state=closed',
        '-f',
        'state_reason=not_planned',
        '--jq',
        '.id',
      ],
      expect.any(Object)
    );
    expect(runGhCommand).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/acme/widgets/issues/12/comments',
        '-f',
        'body=Closing after triage review.',
        '--jq',
        '.id',
      ],
      expect.any(Object)
    );
  });
});
