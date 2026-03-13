import type { SteroidsConfig } from '../config/loader.js';
import { GitHubIssuesConnector } from './github-issues-connector.js';
import type {
  GitHubIntakeConnectorConfig,
  IntakeConnector,
  IntakeSource,
} from './types.js';

export interface CreateIntakeRegistryOptions {
  env?: NodeJS.ProcessEnv;
  runGitHubCommand?: (args: string[], env: NodeJS.ProcessEnv) => string;
}

export class IntakeRegistry {
  private readonly connectors = new Map<IntakeSource, IntakeConnector>();

  register(connector: IntakeConnector): void {
    if (this.connectors.has(connector.source)) {
      throw new Error(`Intake connector '${connector.source}' is already registered`);
    }

    this.connectors.set(connector.source, connector);
  }

  get(source: IntakeSource): IntakeConnector {
    const connector = this.connectors.get(source);
    if (!connector) {
      const available = this.getSources().join(', ');
      throw new Error(`Intake connector '${source}' not found. Available connectors: ${available || 'none'}`);
    }

    return connector;
  }

  tryGet(source: IntakeSource): IntakeConnector | undefined {
    return this.connectors.get(source);
  }

  has(source: IntakeSource): boolean {
    return this.connectors.has(source);
  }

  getSources(): IntakeSource[] {
    return Array.from(this.connectors.keys());
  }

  getAll(): IntakeConnector[] {
    return Array.from(this.connectors.values());
  }
}

function normalizeGitHubConfig(
  config: GitHubIntakeConnectorConfig | undefined
): GitHubIntakeConnectorConfig | null {
  if (!config?.enabled) {
    return null;
  }

  return config;
}

export function createIntakeRegistry(
  config: Partial<SteroidsConfig>,
  options: CreateIntakeRegistryOptions = {}
): IntakeRegistry {
  const registry = new IntakeRegistry();
  const connectors = config.intake?.connectors;

  const githubConfig = normalizeGitHubConfig(connectors?.github);
  if (githubConfig) {
    registry.register(
      new GitHubIssuesConnector(githubConfig, {
        env: options.env,
        runGhCommand: options.runGitHubCommand,
      })
    );
  }

  if (connectors?.sentry?.enabled) {
    throw new Error("Intake connector 'sentry' is enabled but not implemented in this workspace");
  }

  return registry;
}
