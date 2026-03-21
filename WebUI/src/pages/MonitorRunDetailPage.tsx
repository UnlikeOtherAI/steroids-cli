import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowPathIcon,
  ArrowLeftIcon,
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XCircleIcon,
  MagnifyingGlassIcon,
  ClockIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
import { monitorApi, MonitorRun, MonitorAnomaly } from '../services/api';

function formatEpochMs(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '--';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}

function outcomeConfig(outcome: string) {
  switch (outcome) {
    case 'clean':
      return { color: 'bg-green-100 text-green-800', icon: <CheckCircleIcon className="w-5 h-5 text-green-600" />, label: 'Clean' };
    case 'anomalies_found':
      return { color: 'bg-yellow-100 text-yellow-800', icon: <ExclamationTriangleIcon className="w-5 h-5 text-yellow-600" />, label: 'Anomalies Found' };
    case 'investigation_dispatched':
      return { color: 'bg-blue-100 text-blue-800', icon: <ArrowPathIcon className="w-5 h-5 text-blue-600 animate-spin" />, label: 'Investigation In Progress' };
    case 'investigation_complete':
      return { color: 'bg-purple-100 text-purple-800', icon: <CheckCircleIcon className="w-5 h-5 text-purple-600" />, label: 'Investigation Complete' };
    case 'error':
      return { color: 'bg-red-100 text-red-800', icon: <XCircleIcon className="w-5 h-5 text-red-600" />, label: 'Error' };
    default:
      return { color: 'bg-gray-100 text-gray-800', icon: <ClockIcon className="w-5 h-5 text-gray-600" />, label: outcome };
  }
}

function severityBadge(severity: string) {
  switch (severity) {
    case 'critical': return 'bg-red-100 text-red-800';
    case 'warning': return 'bg-yellow-100 text-yellow-800';
    default: return 'bg-gray-100 text-gray-800';
  }
}

export const MonitorRunDetailPage: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<MonitorRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [investigating, setInvestigating] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await monitorApi.getRun(Number(runId));
      setRun(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  // Poll while investigation is in progress
  useEffect(() => {
    const isActive = run?.outcome === 'investigation_dispatched';
    if (isActive) {
      intervalRef.current = window.setInterval(fetchRun, 3000);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [run?.outcome, fetchRun]);

  const handleInvestigate = async () => {
    if (!run) return;
    setInvestigating(true);
    setError(null);
    try {
      await monitorApi.investigate(run.id);
      await fetchRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start investigation');
    } finally {
      setInvestigating(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <ArrowPathIcon className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="p-8">
        <button onClick={() => navigate('/monitor')} className="flex items-center gap-2 text-text-secondary hover:text-text-primary mb-6">
          <ArrowLeftIcon className="w-4 h-4" /> Back to Monitor
        </button>
        <p className="text-text-muted">Run not found.</p>
      </div>
    );
  }

  const oc = outcomeConfig(run.outcome);
  const anomalies: MonitorAnomaly[] = run.scan_results?.anomalies ?? [];
  const isInProgress = run.outcome === 'investigation_dispatched';
  const canInvestigate = run.outcome === 'anomalies_found' || run.outcome === 'error';

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Back */}
      <button onClick={() => navigate('/monitor')} className="flex items-center gap-2 text-text-secondary hover:text-text-primary mb-6 text-sm">
        <ArrowLeftIcon className="w-4 h-4" /> Back to Monitor
      </button>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="flex items-center gap-4">
          {oc.icon}
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Monitor Run #{run.id}</h1>
            <p className="text-text-muted text-sm mt-1">{formatEpochMs(run.started_at)}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium ${oc.color}`}>
            {oc.label}
          </span>
          {run.duration_ms !== null && (
            <span className="text-sm text-text-muted">{formatDuration(run.duration_ms)}</span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
          <ExclamationTriangleIcon className="w-5 h-5 text-red-500 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      )}

      {/* Investigation In Progress Banner */}
      {isInProgress && (
        <div className="mb-6 p-6 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center gap-3 mb-2">
            <ArrowPathIcon className="w-6 h-6 text-blue-600 animate-spin" />
            <h3 className="text-lg font-semibold text-blue-900">Investigation In Progress</h3>
          </div>
          <p className="text-sm text-blue-700">
            The investigator agent is analyzing the anomalies and determining corrective actions.
            This page will update automatically when the investigation completes.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
            </div>
            <span className="text-xs text-blue-500">Polling every 3 seconds...</span>
          </div>
        </div>
      )}

      {/* Investigate Button */}
      {canInvestigate && (
        <div className="mb-6">
          <button
            onClick={handleInvestigate}
            disabled={investigating}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-accent text-white hover:bg-accent/90 font-medium transition-colors disabled:opacity-50"
          >
            {investigating ? (
              <ArrowPathIcon className="w-5 h-5 animate-spin" />
            ) : (
              <PlayIcon className="w-5 h-5" />
            )}
            {investigating ? 'Starting Investigation...' : 'Run Investigation'}
          </button>
        </div>
      )}

      {/* Summary Card */}
      {run.escalation_reason && (
        <div className="mb-6 p-4 bg-bg-surface border border-border rounded-lg">
          <h3 className="text-xs font-medium text-text-muted uppercase mb-2">Escalation Reason</h3>
          <p className="text-sm text-text-primary">{run.escalation_reason}</p>
        </div>
      )}

      {/* Run Error */}
      {run.error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <h3 className="text-xs font-medium text-red-600 uppercase mb-2">Error</h3>
          <p className="text-sm text-red-700">{run.error}</p>
        </div>
      )}

      {/* Anomalies */}
      {anomalies.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
            <ExclamationTriangleIcon className="w-5 h-5 text-yellow-600" />
            Anomalies ({anomalies.length})
          </h2>
          <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
            {anomalies.map((a, i) => (
              <div key={i} className="p-4 flex items-start gap-3">
                <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium flex-shrink-0 mt-0.5 ${severityBadge(a.severity)}`}>
                  {a.severity}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary">{a.details}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-text-muted">
                    <span>{a.projectName}</span>
                    {a.taskTitle && (
                      <>
                        <span>/</span>
                        {a.taskId ? (
                          <Link
                            to={`/task/${a.taskId}?project=${encodeURIComponent(a.projectPath)}`}
                            className="text-accent hover:underline"
                          >
                            {a.taskTitle}
                          </Link>
                        ) : (
                          <span>{a.taskTitle}</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {a.taskId && (
                  <Link
                    to={`/task/${a.taskId}?project=${encodeURIComponent(a.projectPath)}`}
                    className="text-xs text-accent hover:underline flex-shrink-0"
                  >
                    View Task
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Investigator Report */}
      {run.investigator_report && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
            <MagnifyingGlassIcon className="w-5 h-5 text-purple-600" />
            Investigation Report
            {run.investigator_agent && (
              <span className="text-sm font-normal text-text-muted">({run.investigator_agent})</span>
            )}
          </h2>
          <div className="bg-bg-surface border border-border rounded-lg p-5">
            <pre className="text-sm text-text-secondary whitespace-pre-wrap font-mono leading-relaxed">
              {run.investigator_report}
            </pre>
          </div>
        </div>
      )}

      {/* Actions Taken */}
      {run.action_results && Array.isArray(run.action_results) && run.action_results.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-text-primary mb-3 flex items-center gap-2">
            <ShieldCheckIcon className="w-5 h-5 text-accent" />
            Actions Taken ({run.action_results.length})
          </h2>
          <div className="bg-bg-surface border border-border rounded-lg divide-y divide-border">
            {run.action_results.map((action: any, i: number) => (
              <div key={i} className="p-4 flex items-center gap-3">
                {action.success ? (
                  <CheckCircleIcon className="w-5 h-5 text-green-600 flex-shrink-0" />
                ) : (
                  <XCircleIcon className="w-5 h-5 text-red-600 flex-shrink-0" />
                )}
                <div className="flex-1">
                  <p className="text-sm font-medium text-text-primary">{action.action}</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {action.reason || action.error || 'Completed'}
                  </p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${action.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                  {action.success ? 'Success' : 'Failed'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scan Summary */}
      {run.scan_results && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-text-primary mb-3">Scan Summary</h2>
          <div className="bg-bg-surface border border-border rounded-lg p-4">
            <p className="text-sm text-text-secondary">{run.scan_results.summary}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
              <span>{run.scan_results.projectCount} projects scanned</span>
              <span>{run.scan_results.anomalies.length} anomalies</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonitorRunDetailPage;
