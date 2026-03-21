import { describe, expect, it, jest } from '@jest/globals';

import { createIntakeRegistry, IntakeRegistry } from '../src/intake/registry.js';
import type { SteroidsConfig } from '../src/config/loader.js';
import type { IntakeConnector } from '../src/intake/types.js';

function createMockConnector(): IntakeConnector {
  return {
    source: 'github',
    capabilities: {
      pull: true,
      pushUpdates: true,
      resolutionNotifications: true,
    },
    async pullReports() {
      return { reports: [] };
    },
    async pushUpdate() {
      return { accepted: true };
    },
    async notifyResolution() {
      return;
    },
  };
}

describe('IntakeRegistry', () => {
  it('registers and retrieves connectors by source', () => {
    const registry = new IntakeRegistry();
    const connector = createMockConnector();

    registry.register(connector);

    expect(registry.has('github')).toBe(true);
    expect(registry.get('github')).toBe(connector);
    expect(registry.getAll()).toEqual([connector]);
  });

  it('rejects duplicate connector registration', () => {
    const registry = new IntakeRegistry();
    const connector = createMockConnector();

    registry.register(connector);

    expect(() => registry.register(connector)).toThrow("Intake connector 'github' is already registered");
  });

  it('builds the registry from enabled config only', () => {
    const config: Partial<SteroidsConfig> = {
      intake: {
        connectors: {
          github: {
            enabled: true,
            apiBaseUrl: 'https://api.github.com',
            owner: 'acme',
            repo: 'widgets',
            tokenEnvVar: 'GITHUB_TOKEN',
            labels: ['bug'],
          },
          sentry: {
            enabled: false,
          },
        },
      },
    };

    const registry = createIntakeRegistry(config, {
      env: { GITHUB_TOKEN: 'secret' },
      runGitHubCommand: () => '[]',
    });

    expect(registry.getSources()).toEqual(['github']);
    expect(registry.get('github').source).toBe('github');
  });

  it('registers sentry connector when enabled', () => {
    const config: Partial<SteroidsConfig> = {
      intake: {
        connectors: {
          sentry: {
            enabled: true,
            baseUrl: 'https://sentry.io',
            organization: 'acme',
            project: 'widgets',
            authTokenEnvVar: 'SENTRY_AUTH_TOKEN',
          },
        },
      },
    };

    const registry = createIntakeRegistry(config, {
      env: { SENTRY_AUTH_TOKEN: 'secret' },
    });

    expect(registry.getSources()).toEqual(['sentry']);
    expect(registry.get('sentry').source).toBe('sentry');
  });
});
