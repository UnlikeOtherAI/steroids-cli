import React from 'react';
import { Project } from '../../types';
import { Badge } from '../atoms/Badge';

interface ProjectCardProps {
  project: Project;
  onEnable?: (path: string) => void;
  onDisable?: (path: string) => void;
  onRemove?: (path: string) => void;
}

function truncateMiddle(str: string, maxLen: number = 40): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '...';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  onEnable,
  onDisable,
  onRemove,
}) => {
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

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-gray-900 truncate">
            {project.name || project.path.split('/').pop() || 'Project'}
          </h3>
          <p className="text-xs text-gray-400 mt-1 font-mono cursor-help" title={project.path}>
            {truncateMiddle(project.path, 35)}
          </p>
        </div>
        <div className="flex gap-2 ml-4">
          <Badge variant={project.enabled ? 'success' : 'default'}>
            {project.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
        </div>
      </div>

      {project.stats && (
        <div className="grid grid-cols-4 gap-3 mb-3">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900">{project.stats.pending}</div>
            <div className="text-xs text-gray-500">Pending</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">{project.stats.in_progress}</div>
            <div className="text-xs text-gray-500">In Progress</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-yellow-600">{project.stats.review}</div>
            <div className="text-xs text-gray-500">Review</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600">{project.stats.completed}</div>
            <div className="text-xs text-gray-500">Completed</div>
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-3 border-t border-gray-100">
        {project.enabled ? (
          <button
            onClick={() => onDisable?.(project.path)}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            Disable
          </button>
        ) : (
          <button
            onClick={() => onEnable?.(project.path)}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            Enable
          </button>
        )}
        <span className="text-gray-300">|</span>
        <button
          onClick={() => onRemove?.(project.path)}
          className="text-sm text-red-600 hover:text-red-800"
        >
          Remove
        </button>
      </div>

      <div className="text-xs text-gray-400 mt-2">
        Last seen: {new Date(project.last_seen_at).toLocaleString()}
      </div>
    </div>
  );
};
