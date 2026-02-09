import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { TaskListItem, TaskStatus } from '../types';
import { tasksApi } from '../services/api';
import { Badge } from '../components/atoms/Badge';
import { PageLayout } from '../components/templates/PageLayout';

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

// Queue statuses for "next to run" sorting (pending first, then in_progress, then review)
const QUEUE_STATUSES = ['pending', 'in_progress', 'review', 'completed'];

// Strip GUID prefix from task title (format: "#<uuid>: <title>")
function stripGuidPrefix(title: string): string {
  const match = title.match(/^#[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\s*/i);
  return match ? title.slice(match[0].length) : title;
}

export const ProjectTasksPage: React.FC = () => {
  const { projectPath } = useParams<{ projectPath: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const statusParam = searchParams.get('status') as TaskStatus | null;
  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    if (!decodedPath) return;

    setLoading(true);
    setError(null);
    try {
      const response = await tasksApi.listForProject(decodedPath, {
        status: statusParam || undefined,
        limit: 100,
      });

      let sortedTasks = [...response.tasks];
      if (statusParam && QUEUE_STATUSES.includes(statusParam) && statusParam !== 'completed') {
        sortedTasks.sort((a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
      } else {
        sortedTasks.sort((a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      }

      setTasks(sortedTasks);
      setStatusCounts(response.status_counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [decodedPath, statusParam]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const handleStatusFilter = (status: TaskStatus | null) => {
    const params = new URLSearchParams(searchParams);
    if (status) {
      params.set('status', status);
    } else {
      params.delete('status');
    }
    navigate(`?${params.toString()}`, { replace: true });
  };

  const projectName = decodedPath.split('/').pop() || 'Project';
  const pageTitle = statusParam ? `${STATUS_LABELS[statusParam]} Tasks` : 'All Tasks';

  if (!decodedPath) {
    return (
      <PageLayout title="Error" error="Missing project path">
        <div />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title={pageTitle}
      titleSuffix={`in ${projectName}`}
      subtitle={`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}
      backTo={`/project/${encodeURIComponent(decodedPath)}`}
      backLabel={`Back to ${projectName}`}
      loading={loading}
      loadingMessage="Loading tasks..."
      error={error}
    >
      {/* Status filter pills */}
      <div className="flex gap-2 mb-6 flex-wrap">
        <button
          onClick={() => handleStatusFilter(null)}
          className={`px-3 py-1 text-sm rounded-full transition-all ${
            !statusParam
              ? 'bg-accent text-white'
              : 'bg-bg-surface text-text-secondary hover:text-text-primary'
          }`}
        >
          All ({Object.values(statusCounts).reduce((a, b) => a + b, 0)})
        </button>
        {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
          <button
            key={status}
            onClick={() => handleStatusFilter(status)}
            className={`px-3 py-1 text-sm rounded-full transition-all ${
              statusParam === status
                ? 'bg-accent text-white'
                : 'bg-bg-surface text-text-secondary hover:text-text-primary'
            }`}
          >
            {STATUS_LABELS[status]} ({statusCounts[status] || 0})
          </button>
        ))}
      </div>

      {/* Empty state */}
      {!loading && !error && tasks.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-text-muted">No tasks found for the selected filter</p>
        </div>
      )}

      {/* Task list */}
      {!loading && !error && tasks.length > 0 && (
        <div className="space-y-2">
          {tasks.map((task, index) => (
            <div
              key={task.id}
              onClick={() => navigate(`/task/${task.id}?project=${encodeURIComponent(decodedPath)}`)}
              className="card p-4 flex items-center gap-4 cursor-pointer hover:border-accent transition-colors"
            >
              {statusParam && QUEUE_STATUSES.includes(statusParam) && statusParam !== 'completed' && (
                <div className="text-lg font-bold text-text-muted w-8 text-center">
                  #{index + 1}
                </div>
              )}
              <Badge variant={STATUS_VARIANTS[task.status]}>
                {STATUS_LABELS[task.status]}
              </Badge>
              <div className="flex-1 min-w-0">
                <div className="font-medium text-text-primary truncate">
                  <i className="fa-solid fa-arrow-up-right-from-square text-xs text-text-muted mr-2"></i>
                  {stripGuidPrefix(task.title)}
                </div>
                <div className="text-xs text-text-muted flex gap-2 mt-1">
                  {task.section_name && (
                    <span>
                      <i className="fa-solid fa-folder mr-1"></i>
                      {task.section_name}
                    </span>
                  )}
                  {task.rejection_count > 0 && (
                    <span className="text-warning">
                      <i className="fa-solid fa-rotate-left mr-1"></i>
                      {task.rejection_count} rejection{task.rejection_count > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-sm text-text-muted whitespace-nowrap">
                {new Date(task.updated_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </PageLayout>
  );
};
