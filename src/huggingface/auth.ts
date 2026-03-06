import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HuggingFaceHubClient, HubAPIError, type HFWhoAmI } from './hub-client.js';
import { parseHubRateLimitHeaders, type HFHubRateLimitSnapshot } from './metrics.js';

export interface HFTokenValidationResult {
  valid: boolean;
  account?: HFWhoAmI;
  rateLimit?: HFHubRateLimitSnapshot | null;
  hasBroadScopes?: boolean;
  scopes?: string[];
  error?: string;
}

export class HuggingFaceTokenAuth {
  private readonly client: HuggingFaceHubClient;
  private readonly tokenFilePath: string;

  constructor(options: { client?: HuggingFaceHubClient; tokenFilePath?: string } = {}) {
    this.client = options.client ?? new HuggingFaceHubClient();
    this.tokenFilePath = options.tokenFilePath ?? join(homedir(), '.steroids', 'huggingface', 'token');
  }

  getTokenFilePath(): string {
    return this.tokenFilePath;
  }

  hasToken(): boolean {
    return existsSync(this.tokenFilePath);
  }

  getToken(): string | null {
    if (!existsSync(this.tokenFilePath)) {
      return null;
    }
    const token = readFileSync(this.tokenFilePath, 'utf-8').trim();
    return token.length > 0 ? token : null;
  }

  saveToken(token: string): void {
    const value = token.trim();
    if (!value) {
      throw new Error('Hugging Face token cannot be empty');
    }

    const tokenDir = dirname(this.tokenFilePath);
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    chmodSync(tokenDir, 0o700);
    writeFileSync(this.tokenFilePath, `${value}\n`, { mode: 0o600 });
    chmodSync(this.tokenFilePath, 0o600);
  }

  clearToken(): void {
    rmSync(this.tokenFilePath, { force: true });
  }

  async validateToken(token?: string): Promise<HFTokenValidationResult> {
    const value = (token ?? this.getToken() ?? '').trim();
    if (!value) {
      return {
        valid: false,
        error: 'No Hugging Face token configured',
      };
    }

    try {
      const whoAmI = await this.client.getWhoAmIWithHeaders(value);
      const account = whoAmI.account;
      const scopes = extractScopes(account);
      const privilegeMarkers = extractPrivilegeMarkers(account);
      return {
        valid: true,
        account,
        rateLimit: parseHubRateLimitHeaders({
          rateLimit: whoAmI.rateLimit,
          rateLimitPolicy: whoAmI.rateLimitPolicy,
        }),
        scopes,
        hasBroadScopes: [...scopes, ...privilegeMarkers]
          .some((scope) => scope.includes('write') || scope.includes('admin')),
      };
    } catch (error) {
      if (error instanceof HubAPIError && error.status === 401) {
        return {
          valid: false,
          error: 'Invalid Hugging Face token',
        };
      }

      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Token validation failed',
      };
    }
  }
}

function extractScopes(account: HFWhoAmI): string[] {
  const rawScopes = [
    account.scopes,
    account.auth?.accessToken?.scopes,
    account.accessToken?.scopes,
  ];

  const scopes = rawScopes.flatMap((entry) => {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    return entry.split(/[,\s]+/g);
  });

  return Array.from(
    new Set(
      scopes
        .map((scope) => scope.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function extractPrivilegeMarkers(account: HFWhoAmI): string[] {
  const rawPrivileges = [
    account.role,
    account.permissions,
    account.auth?.accessToken?.role,
    account.auth?.accessToken?.permissions,
    account.accessToken?.role,
    account.accessToken?.permissions,
  ];

  const values = rawPrivileges.flatMap((entry) => {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    return entry.split(/[,\s]+/g);
  });

  return values
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}
