import { describe, expect, it } from '@jest/globals';

import { DEFAULT_CONFIG, type SteroidsConfig } from '../src/config/loader.js';
import { getCategoryJsonSchema } from '../src/config/json-schema.js';
import { validateConfig } from '../src/config/validator.js';
import type {
  IntakeConnector,
  IntakeReport,
  PullIntakeReportsRequest,
  PushIntakeUpdateRequest,
} from '../src/intake/types.js';

describe('intake config schema and validation', () => {
  it('exposes intake defaults in the central config', () => {
    expect(DEFAULT_CONFIG.intake).toEqual({
      enabled: false,
      pollIntervalMinutes: 15,
      maxReportsPerPoll: 50,
      connectors: {
        sentry: {
          enabled: false,
          baseUrl: 'https://sentry.io',
          organization: '',
          project: '',
          authTokenEnvVar: 'SENTRY_AUTH_TOKEN',
          defaultAssignee: '',
        },
        github: {
          enabled: false,
          apiBaseUrl: 'https://api.github.com',
          owner: '',
          repo: '',
          tokenEnvVar: 'GITHUB_TOKEN',
          labels: [],
        },
      },
    });
  });

  it('exports intake through the JSON schema category plumbing', () => {
    const intakeSchema = getCategoryJsonSchema('intake');

    expect(intakeSchema).not.toBeNull();
    expect(intakeSchema?.properties?.enabled?.default).toBe(false);
    expect(intakeSchema?.properties?.connectors?.properties?.sentry?.properties?.organization?.type).toBe(
      'string'
    );
    expect(intakeSchema?.properties?.connectors?.properties?.github?.properties?.labels?.type).toBe('array');
  });

  it('rejects intake.enabled without any enabled connector', () => {
    const config: SteroidsConfig = {
      intake: {
        enabled: true,
        connectors: {
          sentry: { enabled: false },
          github: { enabled: false },
        },
      },
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'intake.connectors',
        }),
      ])
    );
  });

  it('rejects enabled connectors with blank required identifiers', () => {
    const config: SteroidsConfig = {
      intake: {
        enabled: true,
        pollIntervalMinutes: 15,
        maxReportsPerPoll: 50,
        connectors: {
          sentry: {
            enabled: true,
            baseUrl: ' ',
            organization: '',
            project: '',
            authTokenEnvVar: ' ',
          },
          github: {
            enabled: true,
            apiBaseUrl: '',
            owner: '',
            repo: ' ',
            tokenEnvVar: '',
          },
        },
      },
    };

    const result = validateConfig(config);
    const errorPaths = result.errors.map((error) => error.path);

    expect(result.valid).toBe(false);
    expect(errorPaths).toEqual(
      expect.arrayContaining([
        'intake.connectors.sentry.baseUrl',
        'intake.connectors.sentry.organization',
        'intake.connectors.sentry.project',
        'intake.connectors.sentry.authTokenEnvVar',
        'intake.connectors.github.apiBaseUrl',
        'intake.connectors.github.owner',
        'intake.connectors.github.repo',
        'intake.connectors.github.tokenEnvVar',
      ])
    );
  });

  it('allows disabled connectors to keep empty values', () => {
    const config: SteroidsConfig = {
      intake: {
        enabled: false,
        pollIntervalMinutes: 15,
        maxReportsPerPoll: 50,
        connectors: {
          sentry: {
            enabled: false,
            organization: '',
            project: '',
            authTokenEnvVar: '',
          },
          github: {
            enabled: false,
            owner: '',
            repo: '',
            tokenEnvVar: '',
          },
        },
      },
    };

    const result = validateConfig(config);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('provides a typed connector contract for future implementations', async () => {
    const sampleReport: IntakeReport = {
      source: 'sentry',
      externalId: 'issue-123',
      url: 'https://sentry.io/issues/123',
      fingerprint: 'abc123',
      title: 'Unhandled exception in checkout',
      summary: 'TypeError in payment handler',
      severity: 'high',
      status: 'open',
      createdAt: '2026-03-12T10:00:00.000Z',
      updatedAt: '2026-03-12T10:05:00.000Z',
      tags: ['checkout', 'payments'],
      payload: { culprit: 'payment.ts' },
    };

    const connector: IntakeConnector = {
      source: 'sentry',
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      async pullReports(_request: PullIntakeReportsRequest) {
        return { reports: [sampleReport], nextCursor: 'cursor-2' };
      },
      async pushUpdate(_request: PushIntakeUpdateRequest) {
        return { accepted: true, remoteId: 'comment-1' };
      },
      async notifyResolution() {
        return;
      },
    };

    const pullResult = await connector.pullReports({ limit: 1 });
    const pushResult = await connector.pushUpdate({
      report: {
        source: sampleReport.source,
        externalId: sampleReport.externalId,
        url: sampleReport.url,
      },
      kind: 'comment',
      message: 'Linked internal task created',
      linkedTaskId: 'task-1',
    });

    expect(pullResult.reports[0]).toEqual(sampleReport);
    expect(pushResult).toEqual({ accepted: true, remoteId: 'comment-1' });
  });
});
