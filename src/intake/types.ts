export type IntakeSource = 'sentry' | 'github';

export type IntakeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type IntakeReportStatus = 'open' | 'triaged' | 'in_progress' | 'resolved' | 'ignored';

export type IntakeResolutionCode = 'fixed' | 'duplicate' | 'wontfix' | 'invalid';

export interface IntakeReportReference {
  source: IntakeSource;
  externalId: string;
  url: string;
}

export interface IntakeReport extends IntakeReportReference {
  fingerprint: string;
  title: string;
  summary?: string;
  severity: IntakeSeverity;
  status: IntakeReportStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  tags: string[];
  payload: Record<string, unknown>;
}

export interface PullIntakeReportsRequest {
  cursor?: string;
  limit: number;
  since?: string;
}

export interface PullIntakeReportsResult {
  reports: IntakeReport[];
  nextCursor?: string;
}

export type IntakePushUpdateKind = 'comment' | 'status' | 'link';

export interface PushIntakeUpdateRequest {
  report: IntakeReportReference;
  kind: IntakePushUpdateKind;
  message?: string;
  status?: IntakeReportStatus;
  linkedTaskId?: string;
  metadata?: Record<string, unknown>;
}

export interface PushIntakeUpdateResult {
  accepted: boolean;
  remoteId?: string;
}

export interface IntakeResolutionRequest {
  report: IntakeReportReference;
  resolvedAt: string;
  resolution: IntakeResolutionCode;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface IntakeConnectorCapabilities {
  pull: boolean;
  pushUpdates: boolean;
  resolutionNotifications: boolean;
}

export interface IntakeConnector {
  readonly source: IntakeSource;
  readonly capabilities: IntakeConnectorCapabilities;

  /**
   * Pull normalized reports from the external intake system.
   * Implementations use the cursor to fetch the next page deterministically.
   */
  pullReports(request: PullIntakeReportsRequest): Promise<PullIntakeReportsResult>;

  /**
   * Push a comment, status update, or internal link back to the external report.
   * Callers should check `capabilities.pushUpdates` before using this method.
   */
  pushUpdate(request: PushIntakeUpdateRequest): Promise<PushIntakeUpdateResult>;

  /**
   * Notify the external system that the linked internal work reached a terminal resolution.
   * Callers should check `capabilities.resolutionNotifications` before using this method.
   */
  notifyResolution(request: IntakeResolutionRequest): Promise<void>;
}

export interface SentryIntakeConnectorConfig {
  enabled?: boolean;
  baseUrl?: string;
  organization?: string;
  project?: string;
  authTokenEnvVar?: string;
  defaultAssignee?: string;
}

export interface GitHubIntakeConnectorConfig {
  enabled?: boolean;
  apiBaseUrl?: string;
  owner?: string;
  repo?: string;
  tokenEnvVar?: string;
  labels?: string[];
}

export interface IntakeConnectorsConfig {
  sentry?: SentryIntakeConnectorConfig;
  github?: GitHubIntakeConnectorConfig;
}

export interface IntakeConfig {
  enabled?: boolean;
  pollIntervalMinutes?: number;
  maxReportsPerPoll?: number;
  connectors?: IntakeConnectorsConfig;
}
