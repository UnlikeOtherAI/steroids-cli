import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Project } from '../../types';
import { Badge } from '../atoms/Badge';
import { Tooltip } from '../atoms/Tooltip';

interface ProjectCardProps {
  project: Project;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({ project }) => {
  const navigate = useNavigate();

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

  const handleClick = () => {
    navigate(`/project/${encodeURIComponent(project.path)}`);
  };

  return (
    <div
      onClick={handleClick}
      className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow cursor-pointer"
    >
      <div className="mb-3">
        <Tooltip content={project.path}>
          <h3 className="text-lg font-semibold text-gray-900 truncate">
            {project.name || project.path.split('/').pop() || 'Project'}
          </h3>
        </Tooltip>
        <div className="flex gap-2 mt-1">
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

      <div className="text-xs text-gray-400">
        Last activity: {project.last_activity_at
          ? new Date(project.last_activity_at).toLocaleString()
          : project.runner
            ? 'No recent activity'
            : 'No runner'
        }
      </div>
    </div>
  );
};
