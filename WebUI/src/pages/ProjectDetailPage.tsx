import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { projectsApi, activityApi, ApiError } from '../services/api';
import { Project, ActivityStats, TimeRangeOption } from '../types';
import { Badge } from '../components/atoms/Badge';
import { Button } from '../components/atoms/Button';
import { Tooltip } from '../components/atoms/Tooltip';
import { StatTile } from '../components/molecules/StatTile';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';

export const ProjectDetailPage: React.FC = () => {
  const { projectPath } = useParams<{ projectPath: string }>();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHours, setSelectedHours] = useState(24);

  const decodedPath = projectPath ? decodeURIComponent(projectPath) : '';

  const loadProject = async () => {
    if (!decodedPath) return;

    try {
      setLoading(true);
      setError(null);
      const projects = await projectsApi.list(true);
      const found = projects.find((p) => p.path === decodedPath);
      if (found) {
        setProject(found);
      } else {
        setError('Project not found');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load project');
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    if (!decodedPath) return;

    try {
      const data = await activityApi.getStats(selectedHours, decodedPath);
      setStats(data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  useEffect(() => {
    loadProject();
  }, [decodedPath]);

  useEffect(() => {
    loadStats();
  }, [decodedPath, selectedHours]);

  const handleEnable = async () => {
    if (!project) return;
    try {
      await projectsApi.enable(project.path);
      await loadProject();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to enable project');
    }
  };

  const handleDisable = async () => {
    if (!project) return;
    try {
      await projectsApi.disable(project.path);
      await loadProject();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to disable project');
    }
  };

  const handleRemove = async () => {
    if (!project) return;
    if (!confirm(`Are you sure you want to remove this project?\n\n${project.path}`)) {
      return;
    }

    try {
      await projectsApi.remove(project.path);
      navigate('/projects');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Failed to remove project');
    }
  };

  const getRunnerStatus = () => {
    if (!project?.runner) return 'No Runner';
    return project.runner.status.charAt(0).toUpperCase() + project.runner.status.slice(1);
  };

  const getRunnerBadgeVariant = () => {
    if (!project?.runner) return 'default';
    const status = project.runner.status.toLowerCase();
    if (status === 'running' || status === 'active') return 'success';
    if (status === 'idle') return 'warning';
    return 'default';
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="text-center">
          <div className="text-gray-500">Loading project...</div>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-8">
        <div className="text-center">
          <p className="text-red-500">{error || 'Project not found'}</p>
          <Button className="mt-4" onClick={() => navigate('/projects')}>
            Back to Projects
          </Button>
        </div>
      </div>
    );
  }

  const projectName = project.name || project.path.split('/').pop() || 'Project';

  const getTimeRangeValue = () => {
    switch (selectedHours) {
      case 12: return '12h';
      case 24: return '24h';
      case 168: return '1w';
      case 720: return '1m';
      default: return '1y';
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <button
          onClick={() => navigate('/projects')}
          className="text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          &larr; Back to Projects
        </button>

        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">{projectName}</h1>
            <Tooltip content={project.path}>
              <p className="text-sm text-gray-500 font-mono mt-1 truncate max-w-lg">
                {project.path}
              </p>
            </Tooltip>
          </div>
          <div className="flex gap-2">
            <Badge variant={project.enabled ? 'success' : 'default'}>
              {project.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge variant={getRunnerBadgeVariant()}>{getRunnerStatus()}</Badge>
          </div>
        </div>
      </div>

      <div className="mb-8 flex gap-3">
        {project.enabled ? (
          <Button variant="secondary" onClick={handleDisable}>
            Disable Project
          </Button>
        ) : (
          <Button onClick={handleEnable}>Enable Project</Button>
        )}
        <Button variant="secondary" onClick={handleRemove}>
          Remove Project
        </Button>
      </div>

      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-gray-900">Activity</h2>
          <TimeRangeSelector
            value={getTimeRangeValue()}
            onChange={(option: TimeRangeOption) => setSelectedHours(option.hours)}
          />
        </div>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <StatTile label="Completed" value={stats.completed} variant="success" />
            <StatTile label="Failed" value={stats.failed} variant="danger" />
            <StatTile label="Skipped" value={stats.skipped} variant="warning" />
            <StatTile label="Partial" value={stats.partial} variant="info" />
            <StatTile label="Disputed" value={stats.disputed} variant="default" />
          </div>
        )}

        {stats && (
          <div className="mt-4 flex gap-6 text-sm text-gray-600">
            <span>Rate: {stats.tasks_per_hour} tasks/hour</span>
            <span>Success Rate: {stats.success_rate}%</span>
          </div>
        )}
      </div>

      {project.stats && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4">Current Queue</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatTile label="Pending" value={project.stats.pending} variant="default" />
            <StatTile label="In Progress" value={project.stats.in_progress} variant="info" />
            <StatTile label="Review" value={project.stats.review} variant="warning" />
            <StatTile label="Completed" value={project.stats.completed} variant="success" />
          </div>
        </div>
      )}

      <div className="text-sm text-gray-500">
        <p>Registered: {new Date(project.registered_at).toLocaleString()}</p>
        <p>
          Last activity: {project.last_activity_at
            ? new Date(project.last_activity_at).toLocaleString()
            : project.runner
              ? 'No recent activity'
              : 'No runner'
          }
        </p>
        {project.runner?.current_task_id && (
          <p
            className="mt-2 cursor-pointer text-blue-600 hover:text-blue-800"
            onClick={() => navigate(`/task/${project.runner!.current_task_id}?project=${encodeURIComponent(project.path)}`)}
          >
            <i className="fa-solid fa-arrow-up-right-from-square text-xs mr-1"></i>
            Current Task: {project.runner.current_task_id}
          </p>
        )}
      </div>
    </div>
  );
};

export default ProjectDetailPage;
