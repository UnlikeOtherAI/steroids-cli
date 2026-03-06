import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalSteroidsDir } from '../runners/global-db-connection.js';
import { OllamaApiClient, OllamaApiError } from './api-client.js';

export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434';
export const DEFAULT_CLOUD_ENDPOINT = 'https://ollama.com';
export const MINIMUM_OLLAMA_VERSION = '0.1.14';

export type OllamaConnectionMode = 'local' | 'cloud';

export interface OllamaConnectionConfig {
  endpoint: string;
  mode: OllamaConnectionMode;
  cloudTier: string | null;
}

export interface OllamaConnectionStatus {
  connected: boolean;
  endpoint: string;
  mode: OllamaConnectionMode;
  version?: string;
  minimumVersionMet?: boolean;
  loadedModels?: number;
  error?: string;
}

const CONFIG_FILE = 'config.json';
const TOKEN_FILE = 'token';

export function getOllamaConfigDir(): string {
  return join(getGlobalSteroidsDir(), 'ollama');
}

export function getOllamaConfigPath(): string {
  return join(getOllamaConfigDir(), CONFIG_FILE);
}

export function getOllamaTokenPath(): string {
  return join(getOllamaConfigDir(), TOKEN_FILE);
}

export function getDefaultConnectionConfig(): OllamaConnectionConfig {
  return {
    endpoint: DEFAULT_LOCAL_ENDPOINT,
    mode: 'local',
    cloudTier: null,
  };
}

export function loadConnectionConfig(): OllamaConnectionConfig {
  const configPath = getOllamaConfigPath();
  if (!existsSync(configPath)) {
    return getDefaultConnectionConfig();
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<OllamaConnectionConfig>;
    const mode: OllamaConnectionMode = parsed.mode === 'cloud' ? 'cloud' : 'local';
    const endpoint = normalizeEndpoint(parsed.endpoint || getDefaultConnectionConfig().endpoint);
    return {
      endpoint,
      mode,
      cloudTier: parsed.cloudTier ?? null,
    };
  } catch {
    return getDefaultConnectionConfig();
  }
}

export function saveConnectionConfig(config: OllamaConnectionConfig): void {
  ensureOllamaConfigDir();
  writeFileSync(
    getOllamaConfigPath(),
    JSON.stringify(
      {
        endpoint: normalizeEndpoint(config.endpoint),
        mode: config.mode,
        cloudTier: config.cloudTier,
      },
      null,
      2,
    ),
    'utf8',
  );
}

export function setLocalConnection(endpoint: string = DEFAULT_LOCAL_ENDPOINT): OllamaConnectionConfig {
  const config: OllamaConnectionConfig = {
    endpoint: normalizeEndpoint(endpoint),
    mode: 'local',
    cloudTier: null,
  };
  saveConnectionConfig(config);
  return config;
}

export function setCloudConnection(
  apiKey: string,
  endpoint: string = DEFAULT_CLOUD_ENDPOINT,
): OllamaConnectionConfig {
  const token = apiKey.trim();
  if (!token) {
    throw new Error('Cloud API key is required');
  }

  ensureOllamaConfigDir();
  const tokenPath = getOllamaTokenPath();
  writeFileSync(tokenPath, token, 'utf8');
  chmodSync(tokenPath, 0o600);

  const config: OllamaConnectionConfig = {
    endpoint: normalizeEndpoint(endpoint),
    mode: 'cloud',
    cloudTier: null,
  };
  saveConnectionConfig(config);
  return config;
}

export function clearCloudApiKey(): void {
  const tokenPath = getOllamaTokenPath();
  if (existsSync(tokenPath)) {
    rmSync(tokenPath, { force: true });
  }
}

export function getCloudApiKey(): string | undefined {
  const fromEnv = process.env.OLLAMA_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const tokenPath = getOllamaTokenPath();
  if (!existsSync(tokenPath)) {
    return undefined;
  }

  const token = readFileSync(tokenPath, 'utf8').trim();
  return token || undefined;
}

export function resolveEndpoint(config: OllamaConnectionConfig): string {
  const override = getEndpointOverrideFromEnv();
  if (override) {
    return override;
  }

  return normalizeEndpoint(config.endpoint);
}

export function getResolvedConnectionConfig(): OllamaConnectionConfig {
  const config = loadConnectionConfig();
  return {
    ...config,
    endpoint: resolveEndpoint(config),
  };
}

export function createOllamaApiClient(config: OllamaConnectionConfig = getResolvedConnectionConfig()): OllamaApiClient {
  const endpoint = resolveEndpoint(config);
  const apiKey = config.mode === 'cloud' ? getCloudApiKey() : undefined;

  return new OllamaApiClient({
    endpoint,
    apiKey,
  });
}

export async function testConnection(
  config: OllamaConnectionConfig = getResolvedConnectionConfig(),
): Promise<OllamaConnectionStatus> {
  const client = createOllamaApiClient(config);
  const endpoint = client.getEndpoint();

  try {
    if (config.mode === 'local') {
      const health = await client.healthCheck();
      if (health.status < 200 || health.status >= 300) {
        return {
          connected: false,
          endpoint,
          mode: config.mode,
          error: `Unexpected health status: ${health.status}`,
        };
      }

      if (!isOllamaHealthResponse(health.body)) {
        return {
          connected: false,
          endpoint,
          mode: config.mode,
          error: 'Unexpected health response: endpoint is not an Ollama instance',
        };
      }
    } else {
      await client.listInstalledModels();
    }

    const [versionResult, psResult] = await Promise.allSettled([
      client.getVersion(),
      client.listRunningModels(),
    ]);

    const version = versionResult.status === 'fulfilled' ? versionResult.value.version : undefined;
    const loadedModels = psResult.status === 'fulfilled' ? psResult.value.models.length : undefined;

    return {
      connected: true,
      endpoint,
      mode: config.mode,
      version,
      minimumVersionMet: version ? isVersionSupported(version) : undefined,
      loadedModels,
    };
  } catch (error) {
    if (config.mode === 'cloud' && error instanceof OllamaApiError && error.status === 401) {
      clearCloudApiKey();
    }

    return {
      connected: false,
      endpoint,
      mode: config.mode,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isVersionSupported(version: string, minimumVersion: string = MINIMUM_OLLAMA_VERSION): boolean {
  const current = parseVersion(version);
  const required = parseVersion(minimumVersion);

  for (let i = 0; i < Math.max(current.length, required.length); i += 1) {
    const currentPart = current[i] ?? 0;
    const requiredPart = required[i] ?? 0;

    if (currentPart > requiredPart) {
      return true;
    }

    if (currentPart < requiredPart) {
      return false;
    }
  }

  return true;
}

function parseVersion(version: string): number[] {
  const cleaned = version.trim().replace(/^v/i, '');
  return cleaned
    .split('.')
    .map((part) => parseInt(part.replace(/[^0-9].*$/, ''), 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}

function ensureOllamaConfigDir(): void {
  const dir = getOllamaConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function isOllamaHealthResponse(body: string): boolean {
  return body.toLowerCase().includes('ollama is running');
}

function getEndpointOverrideFromEnv(): string | undefined {
  const hostRaw = process.env.STEROIDS_OLLAMA_HOST?.trim();
  const portRaw = process.env.STEROIDS_OLLAMA_PORT?.trim();

  if (!hostRaw && !portRaw) {
    return undefined;
  }

  if (!hostRaw) {
    return normalizeEndpoint(`http://localhost:${portRaw}`);
  }

  if (hostRaw.startsWith('http://') || hostRaw.startsWith('https://')) {
    const endpoint = new URL(hostRaw);
    if (portRaw) {
      endpoint.port = portRaw;
    }
    return normalizeEndpoint(endpoint.toString());
  }

  const port = portRaw || '11434';
  return normalizeEndpoint(`http://${hostRaw}:${port}`);
}
