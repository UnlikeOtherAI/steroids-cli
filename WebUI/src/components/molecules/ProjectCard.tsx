import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Project } from '../../types';
import { Badge } from '../atoms/Badge';
import { Tooltip } from '../atoms/Tooltip';

interface ProjectCardProps {
  project: Project;
}

function truncateMiddle(str: string, maxLen: number = 40): string {
  if (str.length <= maxLen) return str;
  const ellipsis = '...';
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
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
    if (project.isUnreachable) return;
    navigate(`/project/${encodeURIComponent(project.path)}`);
  };

  const isBlocked = project.isBlocked;
  const isUnreachable = project.isUnreachable;

  const containerClasses = [
    "bg-white rounded-lg shadow-sm border p-4 transition-shadow",
    isUnreachable ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:shadow-md",
    isBlocked ? "border-red-500" : "border-gray-200"
  ].join(" ");

  const titleClasses = [
    "text-lg font-semibold truncate",
    isBlocked ? "text-red-500" : "text-gray-900"
  ].join(" ");

  return (
    <div
      onClick={handleClick}
      className={containerClasses}
      title={isBlocked ? "Project contains failing tasks or disputes" : isUnreachable ? "Project is currently unreachable" : undefined}
      aria-label={isBlocked ? "Project blocked: contains failing tasks or disputes" : isUnreachable ? "Project unreachable" : `Project ${project.name}`}
    >
      <div className="mb-3">
        <h3 className={titleClasses}>
          {project.name || project.path.split('/').pop() || 'Project'}
        </h3>
        <Tooltip content={project.path}>
          <p className="text-xs text-gray-500 font-mono mt-0.5">
            {truncateMiddle(project.path, 35)}
          </p>
        </Tooltip>
        <div className="flex gap-2 mt-1">
          <Badge variant={project.enabled ? 'success' : 'default'}>
            {project.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
        </div>
      </div>

      {project.stats && (
        <div className="grid grid-cols-3 gap-3 mb-3">
          <div className="bg-gray-50 rounded-lg p-2 text-center">
            <div className="text-xl font-bold text-gray-900">{project.stats.pending}</div>
            <div className="text-xs text-gray-500">Pending</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-2 text-center flex flex-col justify-center items-center">
            <div className="text-xl font-bold">
              <span className="text-green-500">{project.stats.in_progress}</span>
              <span className="text-gray-400 mx-1">/</span>
              <span className="text-orange-500">{project.stats.review}</span>
            </div>
            <div className="text-[10px] text-gray-500 mt-1">Dev / Review</div>
          </div>
          <div className="bg-green-50 rounded-lg p-2 text-center">
            <div className="text-xl font-bold text-green-600">{project.stats.completed}</div>
            <div className="text-xs text-gray-500">Completed</div>
          </div>
        </div>
      )}

      <div className="text-xs text-gray-400">
        {project.last_task_added_at
          ? `Last task added: ${new Date(project.last_task_added_at + 'Z').toLocaleString()}`
          : 'No tasks yet'
        }
      </div>
      {project.storage_human && (
        <div className="flex items-center gap-1.5 text-xs text-text-muted mt-1">
          <i className="fa-solid fa-database text-[10px]" />
          <span>{project.storage_human}</span>
          {project.storage_warning === 'red' && (
            <span className="text-danger font-medium">cleanup recommended</span>
          )}
        </div>
      )}
    </div>
  );
};
