import { API_BASE_URL, ApiError } from './api';

export type IntakeSource = 'github' | 'sentry';
export type IntakeStatus = 'open' | 'triaged' | 'in_progress' | 'resolved' | 'ignored';
export type IntakeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ConnectorHealthStatus = 'disabled' | 'idle' | 'healthy' | 'error' | 'unsupported';

export interface IntakeReport {
  source: IntakeSource;
  externalId: string;
  fingerprint: string;
  title: string;
  summary?: string;
  severity: IntakeSeverity;
  status: IntakeStatus;
  url: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  linkedTaskId?: string | null;
  tags: string[];
  payload: Record<string, unknown>;
}

export interface IntakeStats {
  total: number;
  linked: number;
  unlinked: number;
  bySource: Record<IntakeSource, number>;
  byStatus: Record<IntakeStatus, number>;
  bySeverity: Record<IntakeSeverity, number>;
}

export interface IntakePollState {
  source: IntakeSource;
  cursor?: string | null;
  lastPolledAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastErrorMessage?: string | null;
}

export interface ConnectorHealth {
  source: IntakeSource;
  enabled: boolean;
  implemented: boolean;
  status: ConnectorHealthStatus;
  reason: string;
  configErrors: string[];
  stats: {
    totalReports: number;
    openReports: number;
    linkedReports: number;
  };
  pollState?: IntakePollState | null;
}

export interface IntakeReportsResponse {
  success: boolean;
  project: string;
  total: number;
  reports: IntakeReport[];
}

export interface IntakeReportResponse {
  success: boolean;
  project: string;
  report: IntakeReport;
  created?: boolean;
}

export interface IntakeStatsResponse {
  success: boolean;
  project: string;
  stats: IntakeStats;
}

export interface ConnectorHealthResponse {
  success: boolean;
  project: string;
  intakeEnabled: boolean;
  connectors: ConnectorHealth[];
}

export interface DeleteIntakeReportResponse {
  success: boolean;
  project: string;
  source: IntakeSource;
  externalId: string;
  deleted: boolean;
}

export interface ListIntakeReportsOptions {
  source?: IntakeSource;
  status?: IntakeStatus;
  severity?: IntakeSeverity;
  linkedTaskId?: string;
  hasLinkedTask?: boolean;
  limit?: number;
}

export interface UpsertIntakeReportInput {
  report: IntakeReport;
  linkedTaskId?: string | null;
}

export interface UpdateIntakeReportInput {
  title?: string;
  summary?: string | null;
  severity?: IntakeSeverity;
  status?: IntakeStatus;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
  linkedTaskId?: string | null;
  tags?: string[];
  payload?: Record<string, unknown>;
}

async function fetchIntakeJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(error.error || error.message || `HTTP ${response.status}`, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function buildQuery(projectPath: string, options?: ListIntakeReportsOptions): string {
  const params = new URLSearchParams();
  params.set('project', projectPath);

  if (!options) {
    return params.toString();
  }

  if (options.source) params.set('source', options.source);
  if (options.status) params.set('status', options.status);
  if (options.severity) params.set('severity', options.severity);
  if (options.linkedTaskId) params.set('linkedTaskId', options.linkedTaskId);
  if (options.hasLinkedTask !== undefined) params.set('hasLinkedTask', String(options.hasLinkedTask));
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  return params.toString();
}

export const intakeApi = {
  async listReports(projectPath: string, options?: ListIntakeReportsOptions): Promise<IntakeReportsResponse> {
    return fetchIntakeJson<IntakeReportsResponse>(`/api/intake/reports?${buildQuery(projectPath, options)}`);
  },

  async getReport(projectPath: string, source: IntakeSource, externalId: string): Promise<IntakeReportResponse> {
    const query = new URLSearchParams({ project: projectPath }).toString();
    return fetchIntakeJson<IntakeReportResponse>(
      `/api/intake/reports/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}?${query}`,
    );
  },

  async createReport(projectPath: string, input: UpsertIntakeReportInput): Promise<IntakeReportResponse> {
    return fetchIntakeJson<IntakeReportResponse>('/api/intake/reports', {
      method: 'POST',
      body: JSON.stringify({
        project: projectPath,
        report: input.report,
        linkedTaskId: input.linkedTaskId,
      }),
    });
  },

  async updateReport(
    projectPath: string,
    source: IntakeSource,
    externalId: string,
    updates: UpdateIntakeReportInput,
  ): Promise<IntakeReportResponse> {
    return fetchIntakeJson<IntakeReportResponse>(
      `/api/intake/reports/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          project: projectPath,
          ...updates,
        }),
      },
    );
  },

  async deleteReport(
    projectPath: string,
    source: IntakeSource,
    externalId: string,
  ): Promise<DeleteIntakeReportResponse> {
    const query = new URLSearchParams({ project: projectPath }).toString();
    return fetchIntakeJson<DeleteIntakeReportResponse>(
      `/api/intake/reports/${encodeURIComponent(source)}/${encodeURIComponent(externalId)}?${query}`,
      { method: 'DELETE' },
    );
  },

  async getStats(projectPath: string): Promise<IntakeStatsResponse> {
    const query = new URLSearchParams({ project: projectPath }).toString();
    return fetchIntakeJson<IntakeStatsResponse>(`/api/intake/stats?${query}`);
  },

  async getConnectorHealth(projectPath: string): Promise<ConnectorHealthResponse> {
    const query = new URLSearchParams({ project: projectPath }).toString();
    return fetchIntakeJson<ConnectorHealthResponse>(`/api/intake/connectors/health?${query}`);
  },
};
