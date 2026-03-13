import { execFileSync } from 'node:child_process';
import type { SteroidsConfig } from '../config/loader.js';
import type { StoredIntakeReport } from '../database/intake-queries.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const GITHUB_PUBLIC_HOST = 'github.com';
const GITHUB_PUBLIC_API_HOST = 'api.github.com';

export const GITHUB_GATE_LABEL = 'steroids:intake-gate';
export const GITHUB_GATE_PENDING_LABEL = 'steroids:intake-awaiting-approval';
export const GITHUB_GATE_APPROVED_LABEL = 'steroids:intake-approved';
export const GITHUB_GATE_REJECTED_LABEL = 'steroids:intake-rejected';

export const GITHUB_GATE_MANAGED_LABELS = [
  GITHUB_GATE_LABEL,
  GITHUB_GATE_PENDING_LABEL,
  GITHUB_GATE_APPROVED_LABEL,
  GITHUB_GATE_REJECTED_LABEL,
] as const;

export type GitHubGateDecision = 'pending' | 'approved' | 'rejected';

interface GitHubIssueLabel {
  name?: string;
}

export interface GitHubIssueResponse {
  number?: number;
  html_url?: string;
  state?: string;
  labels?: GitHubIssueLabel[] | string[];
}

export interface GitHubConnectorRuntime {
  host: string;
  env: NodeJS.ProcessEnv;
  owner: string;
  repo: string;
}

export function defaultRunGhCommand(args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: DEFAULT_TIMEOUT_MS,
    env,
  }).trim();
}

function requireNonBlankString(value: string | undefined, fieldName: string): string {
  if (!value || value.trim() === '') {
    throw new Error(`GitHub intake gate requires ${fieldName}`);
  }

  return value.trim();
}

function normalizeHost(apiBaseUrl: string | undefined): string {
  const rawBaseUrl = requireNonBlankString(apiBaseUrl, 'apiBaseUrl');

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error(`GitHub intake gate apiBaseUrl is invalid: ${rawBaseUrl}`);
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
    throw new Error(`GitHub intake gate could not read token from env var ${tokenEnvVar}`);
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

export function getGitHubGateRuntime(
  config: SteroidsConfig,
  env: NodeJS.ProcessEnv
): GitHubConnectorRuntime | null {
  if (config.intake?.enabled !== true || config.intake.connectors?.github?.enabled !== true) {
    return null;
  }

  const githubConfig = config.intake.connectors.github;
  const owner = requireNonBlankString(githubConfig.owner, 'owner');
  const repo = requireNonBlankString(githubConfig.repo, 'repo');
  const host = normalizeHost(githubConfig.apiBaseUrl);
  const tokenEnvVar = requireNonBlankString(githubConfig.tokenEnvVar, 'tokenEnvVar');

  return {
    host,
    owner,
    repo,
    env: resolveTokenEnvVar(host, env, tokenEnvVar),
  };
}

export function buildGateIssueTitle(report: StoredIntakeReport): string {
  return `Approve intake report ${report.source}#${report.externalId}: ${report.title.replace(/\s+/g, ' ').trim()}`;
}

function buildGateIssueBody(report: StoredIntakeReport): string {
  const lines = [
    'Approve or reject this intake report for internal triage.',
    '',
    `External report: ${report.source}#${report.externalId}`,
    `Report URL: ${report.url}`,
    `Severity: ${report.severity}`,
    `Current intake status: ${report.status}`,
    '',
    'Decision process:',
    `- Keep \`${GITHUB_GATE_PENDING_LABEL}\` while awaiting review.`,
    `- Apply \`${GITHUB_GATE_APPROVED_LABEL}\` to approve internal triage creation.`,
    `- Apply \`${GITHUB_GATE_REJECTED_LABEL}\` to reject this report from the intake pipeline.`,
  ];

  if (report.summary && report.summary.trim() !== '') {
    lines.push('', `Summary: ${report.summary.trim()}`);
  }

  return lines.join('\n');
}

function parseIssueResponse(raw: string, context: string): GitHubIssueResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`GitHub intake gate ${context} returned invalid JSON: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`GitHub intake gate ${context} returned a non-object payload`);
  }

  return parsed as GitHubIssueResponse;
}

export function collectLabelNames(labels: GitHubIssueResponse['labels']): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
    .map((label) => label.trim());
}

export function createApprovalIssue(
  runtime: GitHubConnectorRuntime,
  report: StoredIntakeReport,
  runGhCommand: (args: string[], env: NodeJS.ProcessEnv) => string
): { issueNumber: number; issueUrl: string } {
  const issue = parseIssueResponse(
    runGhCommand(
      [
        'api',
        '--hostname',
        runtime.host,
        '--method',
        'POST',
        `repos/${runtime.owner}/${runtime.repo}/issues`,
        '-f',
        `title=${buildGateIssueTitle(report)}`,
        '-f',
        `body=${buildGateIssueBody(report)}`,
        '-f',
        `labels[]=${GITHUB_GATE_LABEL}`,
        '-f',
        `labels[]=${GITHUB_GATE_PENDING_LABEL}`,
      ],
      runtime.env
    ),
    'issue creation'
  );

  if (typeof issue.number !== 'number' || !Number.isInteger(issue.number) || issue.number <= 0) {
    throw new Error('GitHub intake gate issue creation did not return a valid issue number');
  }

  if (!issue.html_url || issue.html_url.trim() === '') {
    throw new Error('GitHub intake gate issue creation did not return html_url');
  }

  return {
    issueNumber: issue.number,
    issueUrl: issue.html_url.trim(),
  };
}

export function fetchGateIssue(
  runtime: GitHubConnectorRuntime,
  issueNumber: number,
  runGhCommand: (args: string[], env: NodeJS.ProcessEnv) => string
): GitHubIssueResponse {
  return parseIssueResponse(
    runGhCommand(
      [
        'api',
        '--hostname',
        runtime.host,
        '--method',
        'GET',
        `repos/${runtime.owner}/${runtime.repo}/issues/${issueNumber}`,
      ],
      runtime.env
    ),
    `issue poll #${issueNumber}`
  );
}

export function replaceManagedLabels(
  runtime: GitHubConnectorRuntime,
  issueNumber: number,
  existingLabels: string[],
  decision: GitHubGateDecision,
  runGhCommand: (args: string[], env: NodeJS.ProcessEnv) => string
): void {
  const unmanaged = existingLabels.filter((label) => !GITHUB_GATE_MANAGED_LABELS.includes(label as never));
  const managed = decision === 'approved'
    ? [GITHUB_GATE_LABEL, GITHUB_GATE_APPROVED_LABEL]
    : decision === 'rejected'
      ? [GITHUB_GATE_LABEL, GITHUB_GATE_REJECTED_LABEL]
      : [GITHUB_GATE_LABEL, GITHUB_GATE_PENDING_LABEL];
  const labels = [...unmanaged, ...managed];
  const args = [
    'api',
    '--hostname',
    runtime.host,
    '--method',
    'PUT',
    `repos/${runtime.owner}/${runtime.repo}/issues/${issueNumber}/labels`,
  ];

  for (const label of labels) {
    args.push('-f', `labels[]=${label}`);
  }

  runGhCommand(args, runtime.env);
}

export function parseGateDecision(labels: string[]): GitHubGateDecision {
  const hasApproved = labels.includes(GITHUB_GATE_APPROVED_LABEL);
  const hasRejected = labels.includes(GITHUB_GATE_REJECTED_LABEL);

  if (hasApproved && hasRejected) {
    throw new Error(
      `GitHub intake gate issue has conflicting labels: ${GITHUB_GATE_APPROVED_LABEL} and ${GITHUB_GATE_REJECTED_LABEL}`
    );
  }

  if (hasApproved) {
    return 'approved';
  }

  if (hasRejected) {
    return 'rejected';
  }

  return 'pending';
}

export function isManagedGitHubGateLabel(label: string): boolean {
  return GITHUB_GATE_MANAGED_LABELS.includes(label as never);
}
