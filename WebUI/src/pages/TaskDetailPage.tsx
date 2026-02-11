import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { AuditEntry, TaskDetails, TaskStatus, TaskTimelineEvent } from '../types';
import { API_BASE_URL, tasksApi, projectsApi } from '../services/api';
import { Badge } from '../components/atoms/Badge';
import { PageLayout } from '../components/templates/PageLayout';
import { AuditLogRow, DisputePanel, formatDuration, formatTimestamp, InvocationsPanel } from './TaskDetailComponents';
import { LiveInvocationActivityPanel, InvocationTimelineEventRow, StreamState } from './TaskLiveTimelineComponents';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  review: 'Review',
  completed: 'Completed',
  skipped: 'Skipped',
  failed: 'Failed',
  disputed: 'Disputed',
};

const STATUS_VARIANTS: Record<TaskStatus, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  pending: 'default',
  in_progress: 'info',
  review: 'warning',
  completed: 'success',
  skipped: 'warning',
  failed: 'danger',
  disputed: 'danger',
};

// Strip GUID prefix from task title (format: "#<uuid>: <title>")
function stripGuidPrefix(title: string): string {
  const match = title.match(/^#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*/i);
  return match ? title.slice(match[0].length) : title;
}

export const TaskDetailPage: React.FC = () => {
  const { taskId } = useParams<{ taskId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const projectPath = searchParams.get('project');

  const [task, setTask] = useState<TaskDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(true);
  const [timeline, setTimeline] = useState<TaskTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>({ status: 'disconnected' });
  const [liveActivity, setLiveActivity] = useState<TaskTimelineEvent[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [restartNotes, setRestartNotes] = useState('');
  const [showLiveModal, setShowLiveModal] = useState(false);
  const [viewMode, setViewMode] = useState<'basic' | 'full'>('basic');
  const intervalRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const fetchTask = useCallback(async () => {
    if (!taskId || !projectPath) return;

    try {
      const data = await tasksApi.getDetails(taskId, projectPath);
      setTask(data);
      setError(null);

      // Stop live updates if task is in a terminal state
      if (['completed', 'failed', 'skipped', 'disputed'].includes(data.status)) {
        setIsLive(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load task');
    } finally {
      setLoading(false);
    }
  }, [taskId, projectPath]);

  const fetchTimeline = useCallback(async () => {
    if (!taskId || !projectPath) return;
    setTimelineLoading(true);
    try {
      const events = await tasksApi.getTimeline(taskId, projectPath);
      setTimeline(events);
      setTimelineError(null);
    } catch (err) {
      setTimelineError(err instanceof Error ? err.message : 'Failed to load timeline');
    } finally {
      setTimelineLoading(false);
    }
  }, [taskId, projectPath]);

  useEffect(() => {
    fetchTask();
  }, [fetchTask]);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  const handleRestart = async (notes?: string) => {
    if (!taskId || !projectPath || restarting || !task) return;

    if (task.status === 'in_progress' || task.status === 'review') {
      alert('Cannot restart a task that is already in progress or under review.');
      return;
    }

    if (task.status === 'completed') {
      const confirmed = confirm('Are you sure you want to restart this task? It has been completed successfully.');
      if (!confirmed) return;
    }

    setRestarting(true);
    try {
      await tasksApi.restart(taskId, projectPath, notes || undefined);
      setRestartNotes('');
      setIsLive(true);
      await fetchTask();
    } catch (err) {
      alert('Failed to restart task: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setRestarting(false);
    }
  };

  const canRestart = task && !['in_progress', 'review'].includes(task.status);

  const handleOpenSourceFile = async () => {
    if (projectPath && task?.source_file) {
      const fullPath = `${projectPath}/${task.source_file}`;
      try {
        await projectsApi.openFolder(fullPath);
      } catch (err) {
        console.error('Failed to open file:', err);
      }
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

  useEffect(() => {
    if (!taskId || !projectPath) return;

    const isTerminal = task && ['completed', 'failed', 'skipped', 'disputed'].includes(task.status);
    const closeStream = () => { try { eventSourceRef.current?.close(); } catch {} eventSourceRef.current = null; };
    if (!isLive || isTerminal) { closeStream(); setStreamState({ status: 'disconnected' }); return; }
    closeStream();

    setStreamState({ status: 'connecting' });
    const url = `${API_BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/stream?project=${encodeURIComponent(projectPath)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setStreamState({ status: 'connected' });
    };

    es.onmessage = (ev) => {
      let entry: any;
      try {
        entry = JSON.parse(ev.data);
      } catch {
        return;
      }

      const type = String(entry?.type ?? '');
      const invId = typeof entry?.invocationId === 'number' ? entry.invocationId : undefined;
      if (type === 'no_active_invocation') { setStreamState({ status: 'no_active_invocation' }); try { es.close(); } catch {} return; }
      if (type === 'waiting_for_log') { setStreamState({ status: 'waiting_for_log', invocationId: invId }); return; }
      if (type === 'log_not_found') { setStreamState({ status: 'log_not_found', invocationId: invId }); try { es.close(); } catch {} return; }
      if (type === 'error' && (typeof entry?.error === 'string' || typeof entry?.message === 'string'))
        setStreamState({ status: 'error', message: String(entry?.error ?? entry?.message) });
      if (typeof entry?.ts !== 'number') entry.ts = Date.now();
      if (type) setLiveActivity((prev) => { const next = [...prev, entry as TaskTimelineEvent]; return next.length > 300 ? next.slice(-300) : next; });
      if (type === 'complete' || type === 'error') void fetchTimeline().finally(() => { try { es.close(); } catch {} });
    };

    es.onerror = () => { setStreamState({ status: 'error', message: 'Stream connection error' }); try { es.close(); } catch {} };
    return () => { closeStream(); };
  }, [fetchTimeline, isLive, projectPath, task?.status, taskId]);

  const projectName = projectPath?.split('/').pop() || 'Project';

  if (!projectPath) {
    return (
      <PageLayout
        title="Error"
        error="Missing project parameter. Please provide a project path."
        backTo={() => navigate(-1)}
      >
        <div />
      </PageLayout>
    );
  }

  const mergedTimelineItems: Array<
    | { kind: 'audit'; key: string; ts: number; entry: AuditEntry }
    | { kind: 'invocation'; key: string; ts: number; event: TaskTimelineEvent }
  > = [
    ...(task?.audit_trail || []).map((entry) => ({
      kind: 'audit' as const,
      key: `audit-${entry.id}`,
      ts: new Date(entry.created_at).getTime(),
      entry,
    })),
    ...timeline
      .filter((e) => {
        const t = e.type;
        // Always exclude raw JSONL lifecycle and output events
        if (t === 'start' || t === 'complete' || t === 'output') return false;
        // In basic mode, only keep invocation lifecycle markers
        if (viewMode === 'basic' && t !== 'invocation.started' && t !== 'invocation.completed') return false;
        return true;
      })
      .map((event, idx) => ({
        kind: 'invocation' as const,
        key: `inv-${String(event.invocationId ?? 'none')}-${event.ts}-${idx}`,
        ts: event.ts,
        event,
      })),
  ].sort((a, b) => b.ts - a.ts);

  return (
    <PageLayout
      title={task ? stripGuidPrefix(task.title) : 'Task Details'}
      backTo={() => navigate(-1)}
      backLabel="Back"
      loading={loading}
      loadingMessage="Loading task details..."
      error={error}
      maxWidth="max-w-4xl"
      actions={
        task && (
          <>
            <Badge variant={STATUS_VARIANTS[task.status]} className="text-base px-4 py-2">
              {STATUS_LABELS[task.status]}
            </Badge>
            {canRestart && !['failed', 'disputed'].includes(task.status) && (
              <button
                onClick={() => handleRestart()}
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
          </>
        )
      }
    >
      {task && (
        <>
          {/* Task metadata */}
          <div className="flex items-center gap-3 text-sm text-text-muted -mt-4 mb-6">
            {task.section_name && (
              <span>
                <i className="fa-solid fa-folder mr-1"></i>
                {task.section_name}
              </span>
            )}
            {task.source_file && (
              <button
                onClick={handleOpenSourceFile}
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

          {/* Human Intervention Panel - for failed/disputed tasks */}
          {['failed', 'disputed'].includes(task.status) && (
            <DisputePanel
              status={task.status}
              rejectionCount={task.rejection_count}
              disputes={task.disputes || []}
              restartNotes={restartNotes}
              onNotesChange={setRestartNotes}
              onRestart={(notes) => handleRestart(notes)}
              restarting={restarting}
            />
          )}

          {/* Live Indicator */}
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-text-primary">
              <i className="fa-solid fa-clock-rotate-left mr-2"></i>
              Activity Timeline
              <span className="text-sm font-normal text-text-muted ml-2">
                ({task.audit_trail.length} status changes, {task.invocations?.length || 0} invocations)
              </span>
            </h2>
            <div className="flex items-center gap-2">
              {/* View mode toggle */}
              {(['basic', 'full'] as const).map((mode) => (
                <button key={mode} onClick={() => setViewMode(mode)}
                  className={`px-2.5 py-1 text-sm rounded transition-colors ${viewMode === mode ? 'bg-accent text-white' : 'bg-bg-surface text-text-muted hover:text-text-primary'}`}
                >{mode.charAt(0).toUpperCase() + mode.slice(1)}</button>
              ))}
              {isLive && (
                <span className="flex items-center gap-2 text-sm text-success">
                  <span className="w-2 h-2 bg-success rounded-full animate-pulse"></span>
                  Live
                </span>
              )}
              <button
                onClick={() => setShowLiveModal(true)}
                className="px-3 py-1 text-sm bg-info/20 text-info hover:bg-info/30 rounded transition-colors"
              >
                <i className="fa-solid fa-bolt mr-1"></i>
                Live Stream
              </button>
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
                onClick={() => {
                  fetchTask();
                  fetchTimeline();
                }}
                className="px-3 py-1 text-sm bg-bg-surface text-text-muted hover:text-text-primary rounded transition-colors"
              >
                <i className="fa-solid fa-refresh mr-1"></i>
                Refresh
              </button>
            </div>
          </div>

          {/* Live Stream Modal */}
          {showLiveModal && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowLiveModal(false)}>
              <div className="bg-bg-primary rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] overflow-hidden m-4" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-border">
                  <h3 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                    <i className="fa-solid fa-bolt text-info"></i>
                    Live Invocation Stream
                    {liveActivity.length > 0 && (
                      <span className="text-sm font-normal text-text-muted">
                        ({liveActivity.length} events)
                      </span>
                    )}
                  </h3>
                  <button
                    onClick={() => setShowLiveModal(false)}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <i className="fa-solid fa-times text-xl"></i>
                  </button>
                </div>
                <div className="overflow-y-auto max-h-[calc(80vh-64px)]">
                  <LiveInvocationActivityPanel
                    isLive={isLive}
                    streamState={streamState}
                    liveActivity={liveActivity}
                    onClear={() => setLiveActivity([])}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Merged Timeline */}
          <div className="card overflow-hidden">
            {(mergedTimelineItems.length === 0 && !timelineLoading) ? (
              <div className="p-8 text-center text-text-muted">
                <i className="fa-solid fa-list text-4xl mb-4"></i>
                <p>No activity recorded yet</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {timelineError && (
                  <div className="p-4 text-sm text-danger">
                    <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                    Failed to load invocation timeline: {timelineError}
                  </div>
                )}
                {timelineLoading && (
                  <div className="p-4 text-sm text-text-muted">
                    <i className="fa-solid fa-spinner fa-spin mr-2"></i>
                    Loading invocation timeline...
                  </div>
                )}
                {mergedTimelineItems.map((item, index) => {
                  if (item.kind === 'audit') {
                    return (
                      <AuditLogRow
                        key={item.key}
                        entry={item.entry}
                        isLatest={index === 0}
                        githubUrl={task.github_url}
                      />
                    );
                  }

                  return <InvocationTimelineEventRow key={item.key} event={item.event} ts={item.ts} />;
                })}
              </div>
            )}
          </div>

          {viewMode === 'full' && (
            <InvocationsPanel invocations={task.invocations} taskId={taskId!} projectPath={projectPath!} />
          )}

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
              Project: {projectName}
            </span>
          </div>
        </>
      )}
    </PageLayout>
  );
};
