import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { TaskListItem, TaskStatus, Section } from '../types';
import { tasksApi, sectionsApi } from '../services/api';
import { Badge } from '../components/atoms/Badge';
import { PageLayout } from '../components/templates/PageLayout';

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
  const sectionParam = searchParams.get('section');
  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [sections, setSections] = useState<Section[]>([]);
  const [currentSection, setCurrentSection] = useState<Section | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch sections for the filter dropdown
  const fetchSections = useCallback(async () => {
    if (!decodedPath) return;
    try {
      const response = await sectionsApi.listForProject(decodedPath);
      setSections(response.sections);
      // Set current section info if filtered by section
      if (sectionParam) {
        const section = response.sections.find(s => s.id === sectionParam);
        setCurrentSection(section || null);
      } else {
        setCurrentSection(null);
      }
    } catch (err) {
      console.error('Failed to load sections:', err);
    }
  }, [decodedPath, sectionParam]);

  const fetchTasks = useCallback(async () => {
    if (!decodedPath) return;

    setLoading(true);
    setError(null);
    try {
      const response = await tasksApi.listForProject(decodedPath, {
        status: statusParam || undefined,
        section: sectionParam || undefined,
        limit: 100,
      });

      // Sort by status priority (in_progress first, completed/skipped last)
      const statusPriority: Record<string, number> = {
        'in_progress': 1,
        'review': 2,
        'pending': 3,
        'disputed': 4,
        'failed': 5,
        'partial': 6,
        'skipped': 7,
        'completed': 8,
      };

      let sortedTasks = [...response.tasks];
      sortedTasks.sort((a, b) => {
        // Sort by status priority first
        const priorityA = statusPriority[a.status] || 9;
        const priorityB = statusPriority[b.status] || 9;
        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }
        // Within same status, sort by creation time
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

      setTasks(sortedTasks);
      setStatusCounts(response.status_counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [decodedPath, statusParam, sectionParam]);

  useEffect(() => {
    fetchSections();
  }, [fetchSections]);

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

  const handleSectionFilter = (sectionId: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (sectionId) {
      params.set('section', sectionId);
    } else {
      params.delete('section');
    }
    navigate(`?${params.toString()}`, { replace: true });
  };

  const projectName = decodedPath.split('/').pop() || 'Project';
  const pageTitle = currentSection
    ? currentSection.name
    : statusParam
      ? `${STATUS_LABELS[statusParam]} Tasks`
      : 'All Tasks';

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
      {/* Section filter (if filtering by section, show section info) */}
      {currentSection && (
        <div className="mb-4 p-3 bg-bg-surface rounded-lg border border-border flex items-center justify-between">
          <div>
            <span className="text-text-secondary text-sm">Section:</span>
            <span className="ml-2 font-medium text-text-primary">{currentSection.name}</span>
            <span className="ml-2 text-xs text-text-muted">
              ({currentSection.total_tasks} tasks)
            </span>
          </div>
          <button
            onClick={() => handleSectionFilter(null)}
            className="text-sm text-accent hover:text-accent/80"
          >
            Clear section filter
          </button>
        </div>
      )}

      {/* Section dropdown (only show if not filtering by section and sections exist) */}
      {!sectionParam && sections.length > 0 && (
        <div className="mb-4">
          <select
            value=""
            onChange={(e) => e.target.value && handleSectionFilter(e.target.value)}
            className="px-3 py-2 bg-bg-surface border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="">Filter by section...</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.name} ({section.total_tasks} tasks)
              </option>
            ))}
          </select>
        </div>
      )}

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
