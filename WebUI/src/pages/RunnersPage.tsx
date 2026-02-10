import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runnersApi, tasksApi, ApiError } from '../services/api';
import { Runner, TaskDetails } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';

function getStatusBadgeVariant(status: string) {
  const s = status.toLowerCase();
  if (s === 'running' || s === 'active') return 'success';
  if (s === 'idle') return 'warning';
  return 'default';
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

function getTaskStatusBadgeVariant(status: string) {
  const s = status.toLowerCase();
  if (s === 'completed') return 'success';
  if (s === 'in_progress') return 'info';
  if (s === 'review') return 'warning';
  if (s === 'failed' || s === 'disputed') return 'danger';
  return 'default';
}

function stripGuidPrefix(title: string): string {
  const match = title.match(/^#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*/i);
  return match ? title.slice(match[0].length) : title;
}

export const RunnersPage: React.FC = () => {
  const navigate = useNavigate();
  const [runners, setRunners] = useState<Runner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetails>>({});
  const [killing, setKilling] = useState<Set<string>>(new Set());

  const loadRunners = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await runnersApi.list();
      setRunners(data);

      // Load task details for runners with current tasks
      const taskPromises = data
        .filter(r => r.current_task_id && r.project_path)
        .map(async r => {
          try {
            const task = await tasksApi.getDetails(r.current_task_id!, r.project_path!);
            return { taskId: r.current_task_id!, task };
          } catch {
            return null;
          }
        });

      const results = await Promise.all(taskPromises);
      const newTaskDetails: Record<string, TaskDetails> = {};
      results.forEach(result => {
        if (result) {
          newTaskDetails[result.taskId] = result.task;
        }
      });
      setTaskDetails(newTaskDetails);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load runners');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRunners();
    const interval = setInterval(loadRunners, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleKillRunner = async (runnerId: string) => {
    setKilling(prev => new Set(prev).add(runnerId));
    try {
      await runnersApi.kill(runnerId);
      await loadRunners();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to kill runner');
    } finally {
      setKilling(prev => {
        const next = new Set(prev);
        next.delete(runnerId);
        return next;
      });
    }
  };

  const activeRunners = runners.filter(
    (r) => r.status === 'running' || r.status === 'active'
  );
  const idleRunners = runners.filter(
    (r) => r.status !== 'running' && r.status !== 'active'
  );

  if (loading && runners.length === 0) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading runners...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Runners</h1>
          <p className="text-gray-600 mt-1">
            {activeRunners.length} active, {idleRunners.length} idle
          </p>
        </div>
        <Button size="sm" onClick={loadRunners}>
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-800">
            <strong>Error:</strong> {error}
          </p>
        </div>
      )}

      {runners.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No runners registered</p>
          <p className="text-gray-400 mt-2">
            Start a runner with{' '}
            <code className="bg-gray-100 px-2 py-1 rounded">steroids loop</code>
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {runners.map((runner) => (
            <div
              key={runner.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {runner.project_name || (runner.project_path ? runner.project_path.split('/').pop() : 'Unknown Project')}
                    </h3>
                    <Badge variant={getStatusBadgeVariant(runner.status)}>
                      {runner.status.charAt(0).toUpperCase() + runner.status.slice(1)}
                    </Badge>
                    {runner.pid && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleKillRunner(runner.id);
                        }}
                        disabled={killing.has(runner.id)}
                      >
                        {killing.has(runner.id) ? (
                          <>
                            <i className="fa-solid fa-spinner fa-spin mr-1"></i>
                            Killing...
                          </>
                        ) : (
                          <>
                            <i className="fa-solid fa-skull mr-1"></i>
                            Kill
                          </>
                        )}
                      </Button>
                    )}
                  </div>

                  <p className="text-sm text-gray-500 mt-1">
                    Runner: {runner.id.slice(0, 8)}
                    {runner.pid && <span className="ml-2">(PID {runner.pid})</span>}
                  </p>

                  {runner.current_task_id && runner.project_path && (() => {
                    const task = taskDetails[runner.current_task_id];
                    return (
                      <div
                        className="mt-4 p-4 bg-white rounded-lg border-2 border-gray-200 cursor-pointer hover:border-gray-300 transition-colors"
                        onClick={() => navigate(`/task/${runner.current_task_id}?project=${encodeURIComponent(runner.project_path!)}`)}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            <i className="fa-solid fa-tasks text-gray-400 flex-shrink-0"></i>
                            <h4 className="font-semibold text-gray-900 truncate">
                              {task ? stripGuidPrefix(task.title) : (runner.current_task_title || 'Task')}
                            </h4>
                          </div>
                          <Badge variant={task ? getTaskStatusBadgeVariant(task.status) : 'default'}>
                            {task ? task.status.replace('_', ' ') : 'Loading'}
                          </Badge>
                        </div>

                        {task && (
                          <div className="space-y-2 text-sm">
                            {task.section_name && (
                              <div className="flex items-center gap-2 text-gray-600">
                                <i className="fa-solid fa-folder text-xs w-4"></i>
                                <span className="font-medium">Section:</span>
                                <span>{task.section_name}</span>
                              </div>
                            )}

                            {task.source_file && (
                              <div className="flex items-center gap-2 text-gray-600">
                                <i className="fa-solid fa-file text-xs w-4"></i>
                                <span className="font-medium">Spec:</span>
                                <span className="truncate">{task.source_file}</span>
                              </div>
                            )}

                            {task.rejection_count > 0 && (
                              <div className="flex items-center gap-2 text-orange-600">
                                <i className="fa-solid fa-exclamation-triangle text-xs w-4"></i>
                                <span className="font-medium">Rejections:</span>
                                <span>{task.rejection_count}</span>
                              </div>
                            )}

                            <div className="flex items-center gap-2 text-gray-500 text-xs pt-2 border-t border-gray-100">
                              <i className="fa-solid fa-clock w-4"></i>
                              <span>Updated {formatTimeAgo(task.updated_at)}</span>
                              <span className="mx-1">•</span>
                              <span className="text-gray-400">ID: {task.id.slice(0, 8)}</span>
                              <i className="fa-solid fa-arrow-up-right-from-square ml-auto text-gray-400"></i>
                            </div>
                          </div>
                        )}

                        {!task && (
                          <div className="text-sm text-gray-500">
                            <i className="fa-solid fa-spinner fa-spin mr-2"></i>
                            Loading task details...
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <div className="text-right text-sm text-gray-500">
                  <p>Heartbeat: {formatTimeAgo(runner.heartbeat_at)}</p>
                  {runner.started_at && (
                    <p>Started: {formatTimeAgo(runner.started_at)}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-8 text-center text-sm text-gray-500">
        {runners.length} runner{runners.length !== 1 ? 's' : ''} registered
      </div>
    </div>
  );
};

export default RunnersPage;
