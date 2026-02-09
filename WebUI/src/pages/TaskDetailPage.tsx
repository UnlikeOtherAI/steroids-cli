import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { TaskDetails, AuditEntry, TaskStatus } from '../types';
import { tasksApi, projectsApi } from '../services/api';
import { Badge } from '../components/atoms/Badge';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  review: 'Review',
  completed: 'Completed',
  skipped: 'Skipped',
  failed: 'Failed',
};

const STATUS_VARIANTS: Record<TaskStatus, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  pending: 'default',
  in_progress: 'info',
  review: 'warning',
  completed: 'success',
  skipped: 'warning',
  failed: 'danger',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString();
}

// Strip GUID prefix from task title (format: "#<uuid>: <title>")
function stripGuidPrefix(title: string): string {
  const match = title.match(/^#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*/i);
  return match ? title.slice(match[0].length) : title;
}

function getActorIcon(actor: string): string {
  if (actor.toLowerCase().includes('coder')) return 'fa-code';
  if (actor.toLowerCase().includes('review')) return 'fa-magnifying-glass';
  if (actor.toLowerCase().includes('loop')) return 'fa-arrows-rotate';
  if (actor.toLowerCase().includes('user')) return 'fa-user';
  return 'fa-robot';
}

interface AuditLogRowProps {
  entry: AuditEntry;
  isLatest: boolean;
  githubUrl: string | null;
}

const AuditLogRow: React.FC<AuditLogRowProps> = ({ entry, isLatest, githubUrl }) => {
  return (
    <div className={`p-4 border-l-4 ${isLatest ? 'border-accent bg-bg-surface' : 'border-border bg-bg-base'}`}>
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-bg-surface flex items-center justify-center">
          <i className={`fa-solid ${getActorIcon(entry.actor)} text-text-muted text-sm`}></i>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary">{entry.actor}</span>
            {entry.from_status && (
              <>
                <span className="text-text-muted">changed status from</span>
                <Badge variant="default">{entry.from_status}</Badge>
                <span className="text-text-muted">to</span>
              </>
            )}
            {!entry.from_status && (
              <span className="text-text-muted">set status to</span>
            )}
            <Badge variant={STATUS_VARIANTS[entry.to_status as TaskStatus] || 'default'}>
              {entry.to_status}
            </Badge>
          </div>
          {entry.notes && (
            <div className="mt-2 p-3 bg-bg-base rounded-lg text-sm text-text-secondary font-mono whitespace-pre-wrap">
              {entry.notes}
            </div>
          )}
          {entry.commit_sha && (
            <div className="mt-2 text-xs text-text-muted">
              {githubUrl ? (
                <a
                  href={`${githubUrl}/commit/${entry.commit_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-accent transition-colors"
                >
                  <i className="fa-brands fa-github"></i>
                  <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                  <i className="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                </a>
              ) : (
                <>
                  <i className="fa-solid fa-code-commit mr-1"></i>
                  Commit: <code className="bg-bg-surface px-1 rounded">{entry.commit_sha.slice(0, 7)}</code>
                </>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
            <span>
              <i className="fa-regular fa-clock mr-1"></i>
              {formatTimestamp(entry.created_at)}
            </span>
            {entry.duration_seconds !== undefined && entry.duration_seconds > 0 && (
              <span>
                <i className="fa-solid fa-hourglass-half mr-1"></i>
                Duration: {formatDuration(entry.duration_seconds)}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const TaskDetailPage: React.FC = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const projectPath = searchParams.get('project');

  const [task, setTask] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const fetchTask = useCallback(async () => {
    if (!taskId || !projectPath) return;

    try {
      const data = await tasksApi.getDetails(taskId, projectPath);
      setTask(data);
      setError(null);

      // Stop live updates if task is completed or failed
      if (['completed', 'failed', 'skipped'].includes(data.status)) {
        setIsLive(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setLoading(false);
    }
  }, [taskId, projectPath]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  const handleRestart = async () => {
    if (!taskId || !projectPath || restarting) return;

    setRestarting(true);
    try {
      await tasksApi.restart(taskId, projectPath);
      setIsLive(true); // Resume live updates after restart
      await fetchTask(); // Refresh task data
    } catch (err) {
      alert('Failed to restart task: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setRestarting(false);
    }
  };

  useEffect(() => {
    if (isLive) {
      intervalRef.current = window.setInterval(() => {
        fetchTask();
      }, 3000);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isLive, fetchTask]);

  if (!projectPath) {
    return (
      <div className="p-8">
        <div className="card p-8 text-center">
          <i className="fa-solid fa-exclamation-triangle text-4xl text-danger mb-4"></i>
          <p className="text-text-muted">Missing project parameter. Please provide a project path.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-center py-8 text-text-muted">
          <i className="fa-solid fa-spinner fa-spin text-2xl mb-4"></i>
          <p>Loading task details...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8">
        <div className="card p-8 text-center">
          <i className="fa-solid fa-exclamation-circle text-4xl text-danger mb-4"></i>
          <p className="text-danger mb-4">{error}</p>
          <button
            onClick={() => navigate(-1)}
            className="px-4 py-2 bg-bg-surface text-text-primary rounded hover:bg-border transition-colors"
          >
            <i className="fa-solid fa-arrow-left mr-2"></i>
            Go Back
          </button>
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="p-8">
        <div className="card p-8 text-center">
          <p className="text-text-muted">Task not found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate(-1)}
          className="text-text-muted hover:text-text-primary transition-colors mb-4 inline-flex items-center"
        >
          <i className="fa-solid fa-arrow-left mr-2"></i>
          Back
        </button>

        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-text-primary mb-2">
              {stripGuidPrefix(task.title)}
            </h1>
            <div className="flex items-center gap-3 text-sm text-text-muted">
              {task.section_name && (
                <span>
                  <i className="fa-solid fa-folder mr-1"></i>
                  {task.section_name}
                </span>
              )}
              {task.source_file && (
                <button
                  onClick={async () => {
                    if (projectPath) {
                      const fullPath = `${projectPath}/${task.source_file}`;
                      try {
                        await projectsApi.openFolder(fullPath);
                      } catch (err) {
                        console.error('Failed to open file:', err);
                      }
                    }
                  }}
                  className="hover:text-accent transition-colors"
                >
                  <i className="fa-solid fa-file-code mr-1"></i>
                  {task.source_file}
                  <i className="fa-solid fa-arrow-up-right-from-square text-xs ml-1"></i>
                </button>
              )}
              {task.rejection_count > 0 && (
                <span className="text-warning">
                  <i className="fa-solid fa-rotate-left mr-1"></i>
                  {task.rejection_count} rejection{task.rejection_count > 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={STATUS_VARIANTS[task.status]} className="text-base px-4 py-2">
              {STATUS_LABELS[task.status]}
            </Badge>
            {task.status === 'failed' && (
              <button
                onClick={handleRestart}
                disabled={restarting}
                className="px-4 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {restarting ? (
                  <>
                    <i className="fa-solid fa-spinner fa-spin"></i>
                    Restarting...
                  </>
                ) : (
                  <>
                    <i className="fa-solid fa-rotate-right"></i>
                    Restart
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-text-primary">
            {formatDuration(task.duration.total_seconds)}
          </div>
          <div className="text-sm text-text-muted">Total Time</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-info">
            {formatDuration(task.duration.in_progress_seconds)}
          </div>
          <div className="text-sm text-text-muted">Coding Time</div>
        </div>
        <div className="card p-4 text-center">
          <div className="text-2xl font-bold text-warning">
            {formatDuration(task.duration.review_seconds)}
          </div>
          <div className="text-sm text-text-muted">Review Time</div>
        </div>
      </div>

      {/* Live Indicator */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-text-primary">
          <i className="fa-solid fa-clock-rotate-left mr-2"></i>
          Activity Log
        </h2>
        <div className="flex items-center gap-2">
          {isLive && (
            <span className="flex items-center gap-2 text-sm text-success">
              <span className="w-2 h-2 bg-success rounded-full animate-pulse"></span>
              Live
            </span>
          )}
          <button
            onClick={() => setIsLive(!isLive)}
            className={`px-3 py-1 text-sm rounded transition-colors ${
              isLive
                ? 'bg-success/20 text-success'
                : 'bg-bg-surface text-text-muted hover:text-text-primary'
            }`}
          >
            <i className={`fa-solid ${isLive ? 'fa-pause' : 'fa-play'} mr-1`}></i>
            {isLive ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={fetchTask}
            className="px-3 py-1 text-sm bg-bg-surface text-text-muted hover:text-text-primary rounded transition-colors"
          >
            <i className="fa-solid fa-refresh mr-1"></i>
            Refresh
          </button>
        </div>
      </div>

      {/* Audit Trail */}
      <div className="card overflow-hidden">
        {task.audit_trail.length === 0 ? (
          <div className="p-8 text-center text-text-muted">
            <i className="fa-solid fa-list text-4xl mb-4"></i>
            <p>No activity recorded yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {task.audit_trail.map((entry, index) => (
              <AuditLogRow key={entry.id} entry={entry} isLatest={index === 0} githubUrl={task.github_url} />
            ))}
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="mt-6 text-xs text-text-muted flex items-center gap-4">
        <span>
          <i className="fa-regular fa-calendar mr-1"></i>
          Created: {formatTimestamp(task.created_at)}
        </span>
        <span>
          <i className="fa-regular fa-calendar-check mr-1"></i>
          Updated: {formatTimestamp(task.updated_at)}
        </span>
        <span title={projectPath} className="cursor-help">
          <i className="fa-solid fa-folder-tree mr-1"></i>
          Project: {projectPath.split('/').pop()}
        </span>
      </div>
    </div>
  );
};
