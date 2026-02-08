import React, { useEffect } from 'react';
import { Project } from '../types';
import { Badge } from '../components/atoms/Badge';

interface DashboardPageProps {
  project: Project;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ project }) => {
  // Auto-refresh every 5 seconds
  // Note: In a real implementation, this would trigger a re-fetch of project data
  useEffect(() => {
    const interval = setInterval(() => {
      // TODO: Implement project data refresh
      console.log('Refreshing project data...');
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const getRunnerStatus = () => {
    if (!project.runner) return 'No Runner';
    return project.runner.status.charAt(0).toUpperCase() + project.runner.status.slice(1);
  };

  const getRunnerBadgeVariant = () => {
    if (!project.runner) return 'default';
    const status = project.runner.status.toLowerCase();
    if (status === 'running' || status === 'active') return 'success';
    if (status === 'idle') return 'warning';
    return 'default';
  };

  const totalTasks = project.stats
    ? project.stats.pending +
      project.stats.in_progress +
      project.stats.review +
      project.stats.completed
    : 0;

  const completionRate = project.stats && totalTasks > 0
    ? Math.round((project.stats.completed / totalTasks) * 100)
    : 0;

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Project Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">
              {project.name || project.path.split('/').pop() || 'Project'}
            </h1>
            <p className="text-gray-500 mt-1 text-sm">{project.path}</p>
          </div>
          <div className="flex gap-2">
            <Badge variant={project.enabled ? 'success' : 'default'}>
              {project.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
        </div>

        {/* Runner Status */}
        <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
          <div className="flex-1">
            <div className="text-sm text-gray-600">Runner Status</div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
              {project.runner?.pid && (
                <span className="text-sm text-gray-500">PID {project.runner.pid}</span>
              )}
            </div>
          </div>
          {project.runner?.current_task_id && (
            <div className="flex-1">
              <div className="text-sm text-gray-600">Current Task</div>
              <div className="text-sm font-mono text-gray-900 mt-1">
                {project.runner.current_task_id.substring(0, 8)}...
              </div>
            </div>
          )}
          <div className="flex-1">
            <div className="text-sm text-gray-600">Last Seen</div>
            <div className="text-sm text-gray-900 mt-1">
              {new Date(project.last_seen_at).toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Task Statistics */}
      {project.stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="text-gray-600 text-sm mb-2">Pending</div>
            <div className="text-4xl font-bold text-gray-900">{project.stats.pending}</div>
            <div className="text-xs text-gray-500 mt-1">Waiting to start</div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-blue-200 p-6">
            <div className="text-blue-600 text-sm mb-2">In Progress</div>
            <div className="text-4xl font-bold text-blue-600">{project.stats.in_progress}</div>
            <div className="text-xs text-gray-500 mt-1">Currently being worked on</div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-yellow-200 p-6">
            <div className="text-yellow-600 text-sm mb-2">In Review</div>
            <div className="text-4xl font-bold text-yellow-600">{project.stats.review}</div>
            <div className="text-xs text-gray-500 mt-1">Awaiting review</div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-green-200 p-6">
            <div className="text-green-600 text-sm mb-2">Completed</div>
            <div className="text-4xl font-bold text-green-600">{project.stats.completed}</div>
            <div className="text-xs text-gray-500 mt-1">Successfully finished</div>
          </div>
        </div>
      )}

      {/* Progress Bar */}
      {project.stats && totalTasks > 0 && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Overall Progress</h2>
            <span className="text-2xl font-bold text-gray-900">{completionRate}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
            <div
              className="bg-green-600 h-4 transition-all duration-500"
              style={{ width: `${completionRate}%` }}
            />
          </div>
          <div className="text-sm text-gray-600 mt-2">
            {project.stats.completed} of {totalTasks} tasks completed
          </div>
        </div>
      )}

      {/* Info Message */}
      {!project.stats && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <p className="text-blue-800">
            Statistics not yet available. Runner will update stats during operation.
          </p>
        </div>
      )}

      {/* Project Meta */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Project Information</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-gray-600">Registered</div>
            <div className="text-gray-900 mt-1">
              {new Date(project.registered_at).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-gray-600">Status</div>
            <div className="text-gray-900 mt-1">
              {project.enabled ? 'Enabled for automation' : 'Disabled'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
