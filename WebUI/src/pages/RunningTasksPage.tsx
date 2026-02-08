import React, { useEffect, useState } from 'react';
import { runnersApi, ApiError } from '../services/api';
import { ActiveTask } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';

function truncateMiddle(str: string, maxLen: number = 40): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '...';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
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

export const RunningTasksPage: React.FC = () => {
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await runnersApi.getActiveTasks();
      setTasks(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load running tasks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTasks();
    const interval = setInterval(loadTasks, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && tasks.length === 0) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading running tasks...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Running Tasks</h1>
          <p className="text-gray-600 mt-1">
            {tasks.length} task{tasks.length !== 1 ? 's' : ''} currently in progress
          </p>
        </div>
        <Button size="sm" onClick={loadTasks}>
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

      {tasks.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg">No tasks currently running</p>
          <p className="text-gray-400 mt-2">Tasks will appear here when runners pick them up</p>
        </div>
      ) : (
        <div className="space-y-4">
          {tasks.map((task, index) => (
            <div
              key={`${task.runner_id}-${task.current_task_id}-${index}`}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {task.current_task_id}
                    </h3>
                    <Badge variant="info">In Progress</Badge>
                  </div>

                  <p
                    className="text-sm text-gray-500 mt-1 font-mono cursor-help"
                    title={task.project_path}
                  >
                    {task.project_name || truncateMiddle(task.project_path, 50)}
                  </p>
                </div>

                <div className="text-right text-sm text-gray-500">
                  <p>Runner: {task.runner_id.slice(0, 8)}</p>
                  <p>Started: {formatTimeAgo(task.started_at)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default RunningTasksPage;
