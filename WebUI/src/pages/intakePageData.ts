import { API_BASE_URL, ApiError } from '../services/api';

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

export interface IntakePageData {
  stats: IntakeStats;
  reports: IntakeReport[];
  connectors: ConnectorHealth[];
}

interface StatsResponse {
  success: boolean;
  stats: IntakeStats;
}

interface ReportsResponse {
  success: boolean;
  reports: IntakeReport[];
}

interface ConnectorHealthResponse {
  success: boolean;
  intakeEnabled: boolean;
  connectors: ConnectorHealth[];
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(
      error.error || error.message || `HTTP ${response.status}`,
      response.status
    );
  }

  return response.json() as Promise<T>;
}

export async function loadIntakePageData(projectPath: string): Promise<IntakePageData> {
  const project = encodeURIComponent(projectPath);
  const [statsResponse, reportsResponse, connectorResponse] = await Promise.all([
    fetchJson<StatsResponse>(`/api/intake/stats?project=${project}`),
    fetchJson<ReportsResponse>(`/api/intake/reports?project=${project}&limit=200`),
    fetchJson<ConnectorHealthResponse>(`/api/intake/connectors/health?project=${project}`),
  ]);

  return {
    stats: statsResponse.stats,
    reports: reportsResponse.reports,
    connectors: connectorResponse.connectors,
  };
}
