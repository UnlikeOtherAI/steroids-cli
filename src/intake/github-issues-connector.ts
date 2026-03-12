import { execFileSync } from 'node:child_process';
import type {
  GitHubIntakeConnectorConfig,
  IntakeConnector,
  IntakeReport,
  IntakeReportStatus,
  IntakeResolutionCode,
  IntakeResolutionRequest,
  PullIntakeReportsRequest,
  PullIntakeReportsResult,
  PushIntakeUpdateRequest,
  PushIntakeUpdateResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const GITHUB_PUBLIC_HOST = 'github.com';
const GITHUB_PUBLIC_API_HOST = 'api.github.com';

interface GitHubIssueLabel {
  name?: string;
}

interface GitHubIssueUser {
  login?: string;
}

interface GitHubIssueResponse {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  state_reason?: string | null;
  html_url?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  labels?: GitHubIssueLabel[] | string[];
  user?: GitHubIssueUser | null;
  comments?: number;
  pull_request?: unknown;
}

interface GitHubConnectorRuntime {
  host: string;
  env: NodeJS.ProcessEnv;
}

interface GitHubIssuesConnectorOptions {
  env?: NodeJS.ProcessEnv;
  runGhCommand?: (args: string[], env: NodeJS.ProcessEnv) => string;
}

function defaultRunGhCommand(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: DEFAULT_TIMEOUT_MS,
    env,
  }).trim();
}

function requireNonBlankString(value: string | undefined, fieldName: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`GitHub intake connector requires ${fieldName}`);
  }

  return value.trim();
}

function normalizeHost(apiBaseUrl: string | undefined): string {
  const rawBaseUrl = requireNonBlankString(apiBaseUrl, 'apiBaseUrl');

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`GitHub intake connector apiBaseUrl is invalid: ${rawBaseUrl}`);
  }

  if (parsed.hostname === GITHUB_PUBLIC_API_HOST) {
    return GITHUB_PUBLIC_HOST;
  }

  return parsed.hostname;
}

function resolveTokenEnvVar(
  host: string,
  sourceEnv: NodeJS.ProcessEnv,
  tokenEnvVar: string
): NodeJS.ProcessEnv {
  const token = sourceEnv[tokenEnvVar];
  if (!token || token.trim() === '') {
    throw new Error(`GitHub intake connector could not read token from env var ${tokenEnvVar}`);
  }

  const env = { ...sourceEnv };
  if (host === GITHUB_PUBLIC_HOST) {
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
    delete env.GH_HOST;
  } else {
    env.GH_HOST = host;
    env.GH_ENTERPRISE_TOKEN = token;
    env.GITHUB_ENTERPRISE_TOKEN = token;
  }

  return env;
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 1;
  }

  const page = Number.parseInt(cursor, 10);
  if (!Number.isInteger(page) || page <= 0) {
    throw new Error(`GitHub intake connector cursor must be a positive integer page number, got: ${cursor}`);
  }

  return page;
}

function parseIssueNumber(externalId: string): number {
  const issueNumber = Number.parseInt(externalId, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`GitHub intake report externalId must be a positive integer issue number, got: ${externalId}`);
  }

  return issueNumber;
}

function collectTagNames(labels: GitHubIssueResponse['labels']): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) => {
      if (typeof label === 'string') {
        return label;
      }

      return label.name;
    })
    .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
    .map((label) => label.trim());
}

function inferSeverity(tags: string[]): IntakeReport['severity'] {
  const normalizedTags = tags.map((tag) => tag.toLowerCase());

  if (normalizedTags.some((tag) => tag.includes('critical') || tag === 'sev:0' || tag === 'severity:critical')) {
    return 'critical';
  }
  if (normalizedTags.some((tag) => tag.includes('high') || tag === 'sev:1' || tag === 'severity:high')) {
    return 'high';
  }
  if (normalizedTags.some((tag) => tag.includes('low') || tag === 'sev:3' || tag === 'severity:low')) {
    return 'low';
  }
  if (normalizedTags.some((tag) => tag.includes('info') || tag === 'sev:4' || tag === 'severity:info')) {
    return 'info';
  }

  return 'medium';
}

function inferStatus(
  state: string | undefined,
  stateReason: string | null | undefined,
  tags: string[]
): IntakeReportStatus {
  const normalizedState = (state ?? '').toLowerCase();
  if (normalizedState === 'closed') {
    return stateReason === 'not_planned' ? 'ignored' : 'resolved';
  }

  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  if (normalizedTags.some((tag) => tag === 'triaged' || tag === 'status:triaged')) {
    return 'triaged';
  }
  if (
    normalizedTags.some(
      (tag) =>
        tag === 'in-progress' ||
        tag === 'in progress' ||
        tag === 'status:in-progress' ||
        tag === 'status:in_progress'
    )
  ) {
    return 'in_progress';
  }

  return 'open';
}

function buildSummary(body: string | null | undefined): string | undefined {
  if (!body || body.trim() === '') {
    return undefined;
  }

  return body.trim();
}

function normalizeIssue(
  issue: GitHubIssueResponse,
  owner: string,
  repo: string
): IntakeReport {
  const issueNumber = issue.number;
  if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`GitHub intake connector received issue payload without a valid number: ${JSON.stringify(issue)}`);
  }

  const title = requireNonBlankString(issue.title, 'issue title');
  const createdAt = requireNonBlankString(issue.created_at, 'issue created_at');
  const updatedAt = requireNonBlankString(issue.updated_at, 'issue updated_at');
  const tags = collectTagNames(issue.labels);

  return {
    source: 'github',
    externalId: String(issueNumber),
    url: issue.html_url ?? requireNonBlankString(issue.url, 'issue url'),
    fingerprint: `github:${owner}/${repo}#${issueNumber}`,
    title,
    summary: buildSummary(issue.body),
    severity: inferSeverity(tags),
    status: inferStatus(issue.state, issue.state_reason, tags),
    createdAt,
    updatedAt,
    resolvedAt: issue.closed_at ?? undefined,
    tags,
    payload: {
      body: issue.body ?? '',
      state: issue.state ?? null,
      stateReason: issue.state_reason ?? null,
      authorLogin: issue.user?.login ?? null,
      commentCount: issue.comments ?? 0,
    },
  };
}

function buildLinkMessage(request: PushIntakeUpdateRequest): string {
  const parts: string[] = [];
  if (request.message && request.message.trim() !== '') {
    parts.push(request.message.trim());
  }
  if (request.linkedTaskId && request.linkedTaskId.trim() !== '') {
    parts.push(`Linked internal task: ${request.linkedTaskId.trim()}`);
  }

  if (parts.length === 0) {
    throw new Error('GitHub intake link updates require message or linkedTaskId');
  }

  return parts.join('\n\n');
}

function requireCommentMessage(message: string | undefined): string {
  if (!message || message.trim() === '') {
    throw new Error('GitHub intake comment updates require a non-empty message');
  }

  return message.trim();
}

function mapStatusToGitHubState(status: IntakeReportStatus): { state: 'open' | 'closed'; stateReason?: string } {
  switch (status) {
    case 'resolved':
      return { state: 'closed', stateReason: 'completed' };
    case 'ignored':
      return { state: 'closed', stateReason: 'not_planned' };
    case 'open':
    case 'triaged':
    case 'in_progress':
      return { state: 'open' };
  }
}

function mapResolutionToStateReason(resolution: IntakeResolutionCode): 'completed' | 'not_planned' {
  return resolution === 'fixed' ? 'completed' : 'not_planned';
}

export class GitHubIssuesConnector implements IntakeConnector {
  readonly source = 'github' as const;
  readonly capabilities = {
    pull: true,
    pushUpdates: true,
    resolutionNotifications: true,
  };

  private readonly config: GitHubIntakeConnectorConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runGhCommand: (args: string[], env: NodeJS.ProcessEnv) => string;

  constructor(config: GitHubIntakeConnectorConfig, options: GitHubIssuesConnectorOptions = {}) {
    this.config = config;
    this.env = options.env ?? process.env;
    this.runGhCommand = options.runGhCommand ?? defaultRunGhCommand;
  }

  async pullReports(request: PullIntakeReportsRequest): Promise<PullIntakeReportsResult> {
    const runtime = this.getRuntime();
    const page = parseCursor(request.cursor);
    if (!Number.isInteger(request.limit) || request.limit <= 0) {
      throw new Error(`GitHub intake connector limit must be a positive integer, got: ${request.limit}`);
    }

    const args = [
      'api',
      '--hostname',
      runtime.host,
      '--method',
      'GET',
      `repos/${this.config.owner}/${this.config.repo}/issues`,
      '-f',
      'state=all',
      '-f',
      'sort=updated',
      '-f',
      'direction=asc',
      '-f',
      `per_page=${request.limit}`,
      '-f',
      `page=${page}`,
    ];

    if (request.since) {
      args.push('-f', `since=${request.since}`);
    }

    if (Array.isArray(this.config.labels) && this.config.labels.length > 0) {
      args.push('-f', `labels=${this.config.labels.join(',')}`);
    }

    const output = this.runGhCommand(args, runtime.env);
    const payload = JSON.parse(output) as GitHubIssueResponse[];
    if (!Array.isArray(payload)) {
      throw new Error('GitHub intake connector expected gh api to return a JSON array of issues');
    }

    const reports = payload
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => normalizeIssue(issue, this.config.owner!, this.config.repo!));

    return {
      reports,
      nextCursor: payload.length === request.limit ? String(page + 1) : undefined,
    };
  }

  async pushUpdate(request: PushIntakeUpdateRequest): Promise<PushIntakeUpdateResult> {
    this.assertGitHubReference(request.report.source);

    const runtime = this.getRuntime();
    const issueNumber = parseIssueNumber(request.report.externalId);

    switch (request.kind) {
      case 'comment': {
        const remoteId = this.createComment(issueNumber, requireCommentMessage(request.message), runtime);
        return { accepted: true, remoteId };
      }
      case 'link': {
        const remoteId = this.createComment(issueNumber, buildLinkMessage(request), runtime);
        return { accepted: true, remoteId };
      }
      case 'status': {
        if (!request.status) {
          throw new Error('GitHub intake status updates require a target status');
        }

        const remoteId = this.updateIssueStatus(issueNumber, request.status, request.message, runtime);
        return { accepted: true, remoteId };
      }
    }
  }

  async notifyResolution(request: IntakeResolutionRequest): Promise<void> {
    this.assertGitHubReference(request.report.source);

    const runtime = this.getRuntime();
    const issueNumber = parseIssueNumber(request.report.externalId);
    const stateReason = mapResolutionToStateReason(request.resolution);

    this.runGhCommand(
      [
        'api',
        '--hostname',
        runtime.host,
        '--method',
        'PATCH',
        `repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}`,
        '-f',
        'state=closed',
        '-f',
        `state_reason=${stateReason}`,
        '--jq',
        '.id',
      ],
      runtime.env
    );

    if (request.message && request.message.trim() !== '') {
      this.createComment(issueNumber, request.message.trim(), runtime);
    }
  }

  private getRuntime(): GitHubConnectorRuntime {
    const owner = requireNonBlankString(this.config.owner, 'owner');
    const repo = requireNonBlankString(this.config.repo, 'repo');
    const host = normalizeHost(this.config.apiBaseUrl);
    const tokenEnvVar = requireNonBlankString(this.config.tokenEnvVar, 'tokenEnvVar');

    return {
      host,
      env: resolveTokenEnvVar(host, this.env, tokenEnvVar),
    };
  }

  private createComment(issueNumber: number, body: string, runtime: GitHubConnectorRuntime): string {
    return this.runGhCommand(
      [
        'api',
        '--hostname',
        runtime.host,
        '--method',
        'POST',
        `repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}/comments`,
        '-f',
        `body=${body}`,
        '--jq',
        '.id',
      ],
      runtime.env
    );
  }

  private updateIssueStatus(
    issueNumber: number,
    status: IntakeReportStatus,
    message: string | undefined,
    runtime: GitHubConnectorRuntime
  ): string {
    const state = mapStatusToGitHubState(status);
    const args = [
      'api',
      '--hostname',
      runtime.host,
      '--method',
      'PATCH',
      `repos/${this.config.owner}/${this.config.repo}/issues/${issueNumber}`,
      '-f',
      `state=${state.state}`,
    ];

    if (state.stateReason) {
      args.push('-f', `state_reason=${state.stateReason}`);
    }

    args.push('--jq', '.id');

    const remoteId = this.runGhCommand(args, runtime.env);

    if (message && message.trim() !== '') {
      this.createComment(issueNumber, message.trim(), runtime);
    }

    return remoteId;
  }

  private assertGitHubReference(source: string): void {
    if (source !== 'github') {
      throw new Error(`GitHub intake connector cannot handle ${source} reports`);
    }
  }
}
