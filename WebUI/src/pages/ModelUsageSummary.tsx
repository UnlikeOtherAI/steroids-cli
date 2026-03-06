import React from 'react';
import { StatTile } from '../components/molecules/StatTile';
import { formatTokenCount, formatUsdCost } from '../services/modelUsageFormat';

export interface ModelUsageSummaryData {
  totalDurationMs: number;
  totalInvocations: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

interface Props {
  summary: ModelUsageSummaryData;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export const ModelUsageSummary: React.FC<Props> = ({ summary }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
    <StatTile label="Total Exec Time" value={formatDuration(summary.totalDurationMs)} />
    <StatTile label="Invocations" value={summary.totalInvocations} />
    <StatTile label="Cost" value={formatUsdCost(summary.totalCostUsd)} />
    <StatTile
      label="Tokens"
      value={formatTokenCount(summary.totalInputTokens + summary.totalOutputTokens)}
      description={`${formatTokenCount(summary.totalInputTokens)} in / ${formatTokenCount(summary.totalOutputTokens)} out`}
    />
  </div>
);
