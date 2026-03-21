import type {
  IntakeConnector,
  IntakeReport,
  IntakeReportStatus,
  IntakeResolutionCode,
  IntakeResolutionRequest,
  PullIntakeReportsRequest,
  PullIntakeReportsResult,
  PushIntakeUpdateRequest,
  PushIntakeUpdateResult,
  SentryIntakeConnectorConfig,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface SentryIssue {
  id: string;
  title?: string;
  culprit?: string;
  status?: string;
  level?: string;
  permalink?: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: number | string;
  userCount?: number;
  metadata?: {
    title?: string;
    value?: string;
    type?: string;
  };
  tags?: Array<{ key: string; value: string }>;
  [key: string]: unknown;
}

interface SentryConnectorRuntime {
  baseUrl: string;
  organization: string;
  project: string;
  authToken: string;
}

interface SentryConnectorOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

function requireNonBlankString(value: string | undefined, fieldName: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`Sentry intake connector requires ${fieldName}`);
  }

  return value.trim();
}

function resolveAuthToken(sourceEnv: NodeJS.ProcessEnv, authTokenEnvVar: string): string {
  const token = sourceEnv[authTokenEnvVar];
  if (!token || token.trim() === '') {
    throw new Error(`Sentry intake connector could not read auth token from env var ${authTokenEnvVar}`);
  }

  return token.trim();
}

function parseCursor(cursor: string | undefined): string | undefined {
  if (!cursor || cursor.trim() === '') {
    return undefined;
  }

  return cursor.trim();
}

function inferSeverity(level: string | undefined): IntakeReport['severity'] {
  const normalized = (level ?? '').toLowerCase();

  switch (normalized) {
    case 'fatal':
    case 'critical':
      return 'critical';
    case 'error':
      return 'high';
    case 'warning':
      return 'medium';
    case 'info':
      return 'low';
    case 'debug':
      return 'info';
    default:
      return 'medium';
  }
}

function inferStatus(status: string | undefined): IntakeReportStatus {
  const normalized = (status ?? '').toLowerCase();

  switch (normalized) {
    case 'resolved':
      return 'resolved';
    case 'ignored':
    case 'muted':
      return 'ignored';
    case 'unresolved':
    default:
      return 'open';
  }
}

function collectTags(tags: SentryIssue['tags']): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .filter((tag) => tag.key && tag.value)
    .map((tag) => `${tag.key}:${tag.value}`)
    .filter((tag) => tag.trim() !== '');
}

function buildTitle(issue: SentryIssue): string {
  if (issue.title && issue.title.trim() !== '') {
    return issue.title.trim();
  }

  if (issue.metadata?.title && issue.metadata.title.trim() !== '') {
    return issue.metadata.title.trim();
  }

  if (issue.culprit && issue.culprit.trim() !== '') {
    return issue.culprit.trim();
  }

  return `Sentry Issue ${issue.id}`;
}

function buildSummary(issue: SentryIssue): string | undefined {
  const parts: string[] = [];

  if (issue.metadata?.value && issue.metadata.value.trim() !== '') {
    parts.push(issue.metadata.value.trim());
  }

  if (issue.metadata?.type && issue.metadata.type.trim() !== '') {
    parts.push(`Type: ${issue.metadata.type.trim()}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join('\n');
}

function normalizeIssue(
  issue: SentryIssue,
  organization: string,
  project: string,
  baseUrl: string
): IntakeReport {
  const externalId = requireNonBlankString(issue.id, 'issue id');
  const title = buildTitle(issue);
  const tags = collectTags(issue.tags);

  const url = issue.permalink ?? `${baseUrl}/organizations/${organization}/issues/${externalId}/`;

  const createdAt = issue.firstSeen ?? new Date().toISOString();
  const updatedAt = issue.lastSeen ?? createdAt;

  return {
    source: 'sentry',
    externalId,
    url,
    fingerprint: `sentry:${organization}/${project}#${externalId}`,
    title,
    summary: buildSummary(issue),
    severity: inferSeverity(issue.level),
    status: inferStatus(issue.status),
    createdAt,
    updatedAt,
    resolvedAt: issue.status?.toLowerCase() === 'resolved' ? updatedAt : undefined,
    tags,
    payload: {
      level: issue.level ?? null,
      culprit: issue.culprit ?? null,
      count: issue.count ?? 0,
      userCount: issue.userCount ?? 0,
      metadata: issue.metadata ?? null,
    },
  };
}

function mapStatusToSentryStatus(status: IntakeReportStatus): string {
  switch (status) {
    case 'resolved':
      return 'resolved';
    case 'ignored':
      return 'ignored';
    case 'open':
    case 'triaged':
    case 'in_progress':
      return 'unresolved';
  }
}

function mapResolutionToSentryStatus(resolution: IntakeResolutionCode): string {
  switch (resolution) {
    case 'fixed':
      return 'resolved';
    case 'duplicate':
    case 'wontfix':
    case 'invalid':
      return 'ignored';
  }
}

export class SentryConnector implements IntakeConnector {
  readonly source = 'sentry' as const;
  readonly capabilities = {
    pull: true,
    pushUpdates: true,
    resolutionNotifications: true,
  };

  private readonly config: SentryIntakeConnectorConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: SentryIntakeConnectorConfig, options: SentryConnectorOptions = {}) {
    this.config = config;
    this.env = options.env ?? process.env;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async pullReports(request: PullIntakeReportsRequest): Promise<PullIntakeReportsResult> {
    const runtime = this.getRuntime();
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      throw new Error(`Sentry intake connector limit must be a positive integer, got: ${request.limit}`);
    }

    const cursor = parseCursor(request.cursor);
    const url = new URL(
      `/api/0/projects/${runtime.organization}/${runtime.project}/issues/`,
      runtime.baseUrl
    );

    url.searchParams.set('statsPeriod', '14d');
    url.searchParams.set('query', 'is:unresolved');
    url.searchParams.set('limit', String(request.limit));

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await this.fetchFn(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${runtime.authToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Sentry API request failed with status ${response.status}: ${errorText}`
      );
    }

    const payload = (await response.json()) as SentryIssue[];
    if (!Array.isArray(payload)) {
      throw new Error('Sentry intake connector expected API to return a JSON array of issues');
    }

    const reports = payload.map((issue) =>
      normalizeIssue(issue, runtime.organization, runtime.project, runtime.baseUrl)
    );

    const linkHeader = response.headers.get('Link');
    const nextCursor = this.extractNextCursor(linkHeader);

    return {
      reports,
      nextCursor,
    };
  }

  async pushUpdate(request: PushIntakeUpdateRequest): Promise<PushIntakeUpdateResult> {
    this.assertSentryReference(request.report.source);

    const runtime = this.getRuntime();
    const issueId = request.report.externalId;

    switch (request.kind) {
      case 'comment': {
        if (!request.message || request.message.trim() === '') {
          throw new Error('Sentry intake comment updates require a non-empty message');
        }

        const remoteId = await this.createComment(issueId, request.message.trim(), runtime);
        return { accepted: true, remoteId };
      }
      case 'link': {
        const message = this.buildLinkMessage(request);
        const remoteId = await this.createComment(issueId, message, runtime);
        return { accepted: true, remoteId };
      }
      case 'status': {
        if (!request.status) {
          throw new Error('Sentry intake status updates require a target status');
        }

        await this.updateIssueStatus(issueId, request.status, runtime);

        if (request.message && request.message.trim() !== '') {
          await this.createComment(issueId, request.message.trim(), runtime);
        }

        return { accepted: true, remoteId: issueId };
      }
    }
  }

  async notifyResolution(request: IntakeResolutionRequest): Promise<void> {
    this.assertSentryReference(request.report.source);

    const runtime = this.getRuntime();
    const issueId = request.report.externalId;
    const sentryStatus = mapResolutionToSentryStatus(request.resolution);

    await this.updateIssueStatusRaw(issueId, sentryStatus, runtime);

    if (request.message && request.message.trim() !== '') {
      await this.createComment(issueId, request.message.trim(), runtime);
    }
  }

  private getRuntime(): SentryConnectorRuntime {
    const baseUrl = requireNonBlankString(this.config.baseUrl, 'baseUrl');
    const organization = requireNonBlankString(this.config.organization, 'organization');
    const project = requireNonBlankString(this.config.project, 'project');
    const authTokenEnvVar = requireNonBlankString(this.config.authTokenEnvVar, 'authTokenEnvVar');

    return {
      baseUrl,
      organization,
      project,
      authToken: resolveAuthToken(this.env, authTokenEnvVar),
    };
  }

  private async createComment(
    issueId: string,
    text: string,
    runtime: SentryConnectorRuntime
  ): Promise<string> {
    const url = `${runtime.baseUrl}/api/0/issues/${issueId}/notes/`;

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${runtime.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Sentry create comment failed with status ${response.status}: ${errorText}`
      );
    }

    const result = (await response.json()) as { id?: string };
    return result.id ?? issueId;
  }

  private async updateIssueStatus(
    issueId: string,
    status: IntakeReportStatus,
    runtime: SentryConnectorRuntime
  ): Promise<void> {
    const sentryStatus = mapStatusToSentryStatus(status);
    await this.updateIssueStatusRaw(issueId, sentryStatus, runtime);
  }

  private async updateIssueStatusRaw(
    issueId: string,
    status: string,
    runtime: SentryConnectorRuntime
  ): Promise<void> {
    const url = `${runtime.baseUrl}/api/0/issues/${issueId}/`;

    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${runtime.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Sentry update status failed with status ${response.status}: ${errorText}`
      );
    }
  }

  private buildLinkMessage(request: PushIntakeUpdateRequest): string {
    const parts: string[] = [];
    if (request.message && request.message.trim() !== '') {
      parts.push(request.message.trim());
    }
    if (request.linkedTaskId && request.linkedTaskId.trim() !== '') {
      parts.push(`Linked internal task: ${request.linkedTaskId.trim()}`);
    }

    if (parts.length === 0) {
      throw new Error('Sentry intake link updates require message or linkedTaskId');
    }

    return parts.join('\n\n');
  }

  private extractNextCursor(linkHeader: string | null): string | undefined {
    if (!linkHeader) {
      return undefined;
    }

    const nextMatch = linkHeader.match(/<[^>]*[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/);
    if (!nextMatch) {
      return undefined;
    }

    return decodeURIComponent(nextMatch[1]);
  }

  private assertSentryReference(source: string): void {
    if (source !== 'sentry') {
      throw new Error(`Sentry intake connector cannot handle ${source} reports`);
    }
  }
}
