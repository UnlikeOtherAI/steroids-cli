import React from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
  TrashIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';

import { MonitorRun } from '../services/api';

function formatEpochMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function outcomeVariant(outcome: string): { color: string; icon: React.ReactNode } {
  switch (outcome) {
    case 'clean':
      return { color: 'bg-green-100 text-green-800', icon: <CheckCircleIcon className="w-4 h-4" /> };
    case 'anomalies_found':
      return { color: 'bg-yellow-100 text-yellow-800', icon: <ExclamationTriangleIcon className="w-4 h-4" /> };
    case 'first_responder_dispatched':
      return { color: 'bg-blue-100 text-blue-800', icon: <MagnifyingGlassIcon className="w-4 h-4" /> };
    case 'first_responder_complete':
    case 'investigation_complete':
      return { color: 'bg-purple-100 text-purple-800', icon: <CheckCircleIcon className="w-4 h-4" /> };
    case 'error':
      return { color: 'bg-red-100 text-red-800', icon: <XCircleIcon className="w-4 h-4" /> };
    default:
      return { color: 'bg-gray-100 text-gray-800', icon: <ClockIcon className="w-4 h-4" /> };
  }
}

interface MonitorStatusCardProps {
  latestRun: MonitorRun | undefined;
  onOpenIssues: () => void;
}

export function MonitorStatusCard({ latestRun, onOpenIssues }: MonitorStatusCardProps) {
  const anomalies = latestRun?.scan_results?.anomalies ?? [];
  const criticals = anomalies.filter((anomaly) => anomaly.severity === 'critical').length;
  const warnings = anomalies.filter((anomaly) => anomaly.severity === 'warning').length;
  const infos = anomalies.filter((anomaly) => anomaly.severity === 'info').length;
  const hasIssues = anomalies.length > 0;
  const isHealthy = Boolean(latestRun && anomalies.length === 0);
  const projectsAffected = new Set(anomalies.map((anomaly) => anomaly.projectPath)).size;

  return (
    <div
      onClick={onOpenIssues}
      className={`mb-8 p-5 rounded-lg border cursor-pointer transition-all hover:shadow-md ${
        !latestRun
          ? 'bg-bg-surface border-border'
          : isHealthy
            ? 'bg-green-50 border-green-200 hover:border-green-300'
            : criticals > 0
              ? 'bg-red-50 border-red-200 hover:border-red-300'
              : 'bg-yellow-50 border-yellow-200 hover:border-yellow-300'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {!latestRun ? (
            <ShieldCheckIcon className="w-10 h-10 text-text-muted" />
          ) : isHealthy ? (
            <CheckCircleIcon className="w-10 h-10 text-green-500" />
          ) : (
            <ExclamationTriangleIcon className="w-10 h-10 text-orange-500" />
          )}
          <div>
            <h3 className="text-lg font-semibold text-text-primary">
              {!latestRun
                ? 'No scans yet'
                : isHealthy
                  ? 'All Systems Healthy'
                  : `${anomalies.length} Issue${anomalies.length !== 1 ? 's' : ''} Detected`}
            </h3>
            <p className="text-sm text-text-muted mt-0.5">
              {!latestRun
                ? 'Run a scan to check system health'
                : isHealthy
                  ? `${latestRun.scan_results?.projectCount ?? 0} projects scanned — no anomalies`
                  : `${projectsAffected} project${projectsAffected !== 1 ? 's' : ''} affected`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {hasIssues && (
            <div className="flex items-center gap-3">
              {criticals > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                  <span className="text-sm font-medium text-red-700">{criticals}</span>
                </div>
              )}
              {warnings > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
                  <span className="text-sm font-medium text-yellow-700">{warnings}</span>
                </div>
              )}
              {infos > 0 && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                  <span className="text-sm font-medium text-blue-700">{infos}</span>
                </div>
              )}
            </div>
          )}
          <ChevronRightIcon className="w-5 h-5 text-text-muted" />
        </div>
      </div>
    </div>
  );
}

interface MonitorRunHistorySectionProps {
  runs: MonitorRun[];
  runsTotal: number;
  runsLoading: boolean;
  runsPage: number;
  pageSize: number;
  onClearHistory: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onOpenRun: (runId: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}

export function MonitorRunHistorySection({
  runs,
  runsTotal,
  runsLoading,
  runsPage,
  pageSize,
  onClearHistory,
  onRefresh,
  onOpenRun,
  onPreviousPage,
  onNextPage,
}: MonitorRunHistorySectionProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-text-primary">Run History</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{runsTotal} runs</span>
          {runs.length > 0 && (
            <button
              onClick={onClearHistory}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-text-muted hover:text-danger hover:border-danger/50 text-xs transition-colors"
            >
              <TrashIcon className="w-3 h-3" />
              Clear
            </button>
          )}
          <button
            onClick={onRefresh}
            disabled={runsLoading}
            className="p-1.5 rounded-lg hover:bg-bg-surface2 text-text-secondary"
          >
            <ArrowPathIcon className={`w-4 h-4 ${runsLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="text-center py-12 bg-bg-surface rounded-lg border border-border">
          <ShieldCheckIcon className="w-12 h-12 text-text-muted mx-auto mb-3" />
          <p className="text-text-muted">No monitor runs yet</p>
          <p className="text-xs text-text-muted mt-1">
            Enable the monitor or click "Run Now" to start
          </p>
        </div>
      ) : (
        <div className="bg-bg-surface rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Time</th>
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Outcome</th>
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Anomalies</th>
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Escalation</th>
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider">Duration</th>
                <th className="px-4 py-3 text-xs text-text-muted font-medium uppercase tracking-wider w-8"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const variant = outcomeVariant(run.outcome);
                const anomalyCount = run.scan_results?.anomalies?.length ?? 0;

                return (
                  <tr
                    key={run.id}
                    className="border-b border-border/50 hover:bg-bg-base cursor-pointer transition-colors"
                    onClick={() => onOpenRun(run.id)}
                  >
                    <td className="px-4 py-3 text-text-secondary">
                      {formatEpochMs(run.started_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${variant.color}`}>
                        {variant.icon}
                        {(run.outcome === 'investigation_complete' ? 'first_responder_complete' : run.outcome).replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {anomalyCount > 0 ? anomalyCount : '--'}
                    </td>
                    <td className="px-4 py-3 text-text-secondary text-xs truncate max-w-[200px]">
                      {run.escalation_reason || (run.error ? <span className="text-red-600">{run.error}</span> : '--')}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {formatDuration(run.duration_ms)}
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      <ChevronRightIcon className="w-4 h-4" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {runsTotal > pageSize && (
        <div className="flex items-center justify-between mt-3">
          <span className="text-xs text-text-muted">
            {runsPage * pageSize + 1}–{Math.min((runsPage + 1) * pageSize, runsTotal)} of {runsTotal}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onPreviousPage}
              disabled={runsPage === 0}
              className="px-3 py-1 rounded border border-border text-xs text-text-secondary hover:bg-bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={onNextPage}
              disabled={(runsPage + 1) * pageSize >= runsTotal}
              className="px-3 py-1 rounded border border-border text-xs text-text-secondary hover:bg-bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
