import {
  ConnectorHealth,
  intakeApi,
  IntakeReport,
  IntakeSeverity,
  IntakeSource,
  IntakeStats,
  IntakeStatus,
} from '../services/intakeApi';

export type { ConnectorHealth, IntakeReport, IntakeSeverity, IntakeSource, IntakeStats, IntakeStatus };

export interface IntakePageData {
  stats: IntakeStats;
  reports: IntakeReport[];
  connectors: ConnectorHealth[];
}

export async function loadIntakePageData(projectPath: string): Promise<IntakePageData> {
  const [statsResponse, reportsResponse, connectorResponse] = await Promise.all([
    intakeApi.getStats(projectPath),
    intakeApi.listReports(projectPath, { limit: 200 }),
    intakeApi.getConnectorHealth(projectPath),
  ]);

  return {
    stats: statsResponse.stats,
    reports: reportsResponse.reports,
    connectors: connectorResponse.connectors,
  };
}
