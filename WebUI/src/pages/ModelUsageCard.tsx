import React from 'react';
import { formatTokenCount, formatUsdCost } from '../services/modelUsageFormat';

export interface ModelUsageCardEntry {
  provider: string;
  model: string;
  invocationCount: number;
  coderCount: number;
  reviewerCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  successRate: number | null;
  failedCount: number;
  timeoutCount: number;
  tokens: {
    input: number;
    output: number;
    cachedInput: number;
    cacheRead: number;
    cacheCreation: number;
  };
  cacheHitRate: number;
  totalCostUsd: number;
}

interface Props {
  entry: ModelUsageCardEntry;
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

export const ModelUsageCard: React.FC<Props> = ({ entry }) => {
  const successColor =
    entry.successRate === null
      ? 'text-text-muted'
      : entry.successRate >= 90
        ? 'text-success'
        : entry.successRate >= 70
          ? 'text-warning'
          : 'text-danger';

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="badge-accent text-xs">{entry.provider}</span>
        <span className="text-sm font-semibold text-text-primary truncate" title={entry.model}>
          {entry.model}
        </span>
      </div>

      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-text-secondary">Exec Time</span>
          <span className="font-medium text-text-primary">{formatDuration(entry.totalDurationMs)}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-text-secondary">Invocations</span>
          <span className="text-text-primary">
            <span className="font-medium">{entry.invocationCount}</span>
            <span className="text-text-muted text-xs ml-1">({entry.coderCount}c / {entry.reviewerCount}r)</span>
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-text-secondary">Success Rate</span>
          <span className={`font-medium ${successColor}`}>
            {entry.successRate === null ? '--' : `${entry.successRate}%`}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-text-secondary">Avg Duration</span>
          <span className="text-text-primary">{formatDuration(entry.avgDurationMs)}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-text-secondary">Tokens</span>
          <span className="text-text-primary">
            {formatTokenCount(entry.tokens.input)} in / {formatTokenCount(entry.tokens.output)} out
          </span>
        </div>

        {entry.cacheHitRate > 0 && (
          <div className="flex justify-between">
            <span className="text-text-secondary">Cache Hit Rate</span>
            <span className="text-text-primary">{entry.cacheHitRate}%</span>
          </div>
        )}

        <div className="flex justify-between">
          <span className="text-text-secondary">Cost</span>
          <span className="font-medium text-text-primary">{formatUsdCost(entry.totalCostUsd)}</span>
        </div>

        {(entry.failedCount > 0 || entry.timeoutCount > 0) && (
          <div className="flex gap-2 pt-1">
            {entry.failedCount > 0 && <span className="badge-danger text-xs">{entry.failedCount} failed</span>}
            {entry.timeoutCount > 0 && <span className="badge-warning text-xs">{entry.timeoutCount} timeout</span>}
          </div>
        )}
      </div>
    </div>
  );
};
