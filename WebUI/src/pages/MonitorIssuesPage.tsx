import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowPathIcon,
  ArrowLeftIcon,
  ExclamationTriangleIcon,
  WrenchScrewdriverIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { monitorApi, MonitorAnomaly, MonitorScanResult } from '../services/api';

function severityColor(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'bg-red-100 text-red-800';
    case 'warning':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-blue-100 text-blue-800';
  }
}

interface GroupedAnomalies {
  projectName: string;
  projectPath: string;
  anomalies: MonitorAnomaly[];
  highestSeverity: string;
}

function groupByProject(anomalies: MonitorAnomaly[]): GroupedAnomalies[] {
  const map = new Map<string, GroupedAnomalies>();
  for (const a of anomalies) {
    let group = map.get(a.projectPath);
    if (!group) {
      group = { projectName: a.projectName, projectPath: a.projectPath, anomalies: [], highestSeverity: 'info' };
      map.set(a.projectPath, group);
    }
    group.anomalies.push(a);
    if (a.severity === 'critical' || (a.severity === 'warning' && group.highestSeverity !== 'critical')) {
      group.highestSeverity = a.severity;
    }
  }
  // Sort: critical projects first, then warning, then info
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  return [...map.values()].sort((a, b) => (order[a.highestSeverity] ?? 2) - (order[b.highestSeverity] ?? 2));
}

export const MonitorIssuesPage: React.FC = () => {
  const navigate = useNavigate();
  const [scan, setScan] = useState<MonitorScanResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggeringFix, setTriggeringFix] = useState(false);

  const loadScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await monitorApi.triggerScan();
      setScan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadScan();
  }, [loadScan]);

  const handleTryToFix = async () => {
    setTriggeringFix(true);
    setError(null);
    try {
      const { result } = await monitorApi.triggerRun({ preset: 'fix_and_monitor', forceDispatch: true });
      if (result.runId) {
        navigate(`/monitor/run/${result.runId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fix run failed');
    } finally {
      setTriggeringFix(false);
    }
  };

  const anomalies = scan?.anomalies ?? [];
  const groups = groupByProject(anomalies);
  const criticalCount = anomalies.filter(a => a.severity === 'critical').length;
  const warningCount = anomalies.filter(a => a.severity === 'warning').length;
  const infoCount = anomalies.filter(a => a.severity === 'info').length;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Back button */}
      <button
        onClick={() => navigate('/monitor')}
        className="flex items-center gap-2 text-text-muted hover:text-text-primary mb-6 text-sm"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Back to Monitor
      </button>

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ExclamationTriangleIcon className="w-8 h-8 text-orange-500" />
          <div>
            <h1 className="text-3xl font-bold text-text-primary">System Issues</h1>
            <p className="text-text-muted mt-1">
              {loading ? 'Scanning...' : scan ? `${scan.summary}` : 'No scan data'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadScan}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-text-secondary hover:bg-bg-surface2 text-sm transition-colors disabled:opacity-50"
          >
            <ArrowPathIcon className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Rescan
          </button>
          {anomalies.length > 0 && (
            <button
              onClick={handleTryToFix}
              disabled={triggeringFix || loading}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 text-sm font-medium transition-colors disabled:opacity-50"
            >
              {triggeringFix ? (
                <ArrowPathIcon className="w-4 h-4 animate-spin" />
              ) : (
                <WrenchScrewdriverIcon className="w-4 h-4" />
              )}
              Try to Fix All
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <ArrowPathIcon className="w-8 h-8 animate-spin text-accent" />
        </div>
      )}

      {/* No issues */}
      {!loading && anomalies.length === 0 && (
        <div className="text-center py-16 bg-bg-surface rounded-lg border border-border">
          <ShieldCheckIcon className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-text-primary mb-2">All Clear</h2>
          <p className="text-text-muted">No issues detected across {scan?.projectCount ?? 0} projects</p>
        </div>
      )}

      {/* Severity summary bar */}
      {!loading && anomalies.length > 0 && (
        <>
          <div className="flex items-center gap-4 mb-6">
            {criticalCount > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                <span className="text-sm font-medium text-red-800">{criticalCount} critical</span>
              </div>
            )}
            {warningCount > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-50 border border-yellow-200 rounded-lg">
                <span className="w-2.5 h-2.5 rounded-full bg-yellow-500"></span>
                <span className="text-sm font-medium text-yellow-800">{warningCount} warning</span>
              </div>
            )}
            {infoCount > 0 && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                <span className="text-sm font-medium text-blue-800">{infoCount} info</span>
              </div>
            )}
            <span className="text-xs text-text-muted ml-auto">
              {groups.length} project{groups.length !== 1 ? 's' : ''} affected
            </span>
          </div>

          {/* Grouped anomalies by project */}
          <div className="space-y-4">
            {groups.map(group => (
              <div
                key={group.projectPath}
                className="bg-bg-surface rounded-lg border border-border overflow-hidden"
              >
                <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-bg-base">
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${severityColor(group.highestSeverity)}`}>
                      {group.highestSeverity}
                    </span>
                    <span className="font-semibold text-text-primary">{group.projectName}</span>
                  </div>
                  <span className="text-xs text-text-muted">
                    {group.anomalies.length} issue{group.anomalies.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="divide-y divide-border/50">
                  {group.anomalies.map((anomaly, i) => (
                    <div key={i} className="px-5 py-3 flex items-start gap-3">
                      <span className={`mt-0.5 px-2 py-0.5 rounded text-[10px] font-medium uppercase ${severityColor(anomaly.severity)}`}>
                        {anomaly.severity}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-text-primary">{anomaly.details}</p>
                        <p className="text-xs text-text-muted mt-1">
                          {anomaly.type.replace(/_/g, ' ')}
                          {anomaly.taskTitle && <> &middot; {anomaly.taskTitle}</>}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default MonitorIssuesPage;
