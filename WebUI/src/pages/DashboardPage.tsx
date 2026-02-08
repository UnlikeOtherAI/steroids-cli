import React, { useEffect } from 'react';
import { Project } from '../types';
import { StatTile } from '../components/molecules/StatTile';

interface DashboardPageProps {
  project: Project;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ project }) => {
  useEffect(() => {
    const interval = setInterval(() => console.log('Refreshing project data...'), 5000);
    return () => clearInterval(interval);
  }, []);

  const getRunnerStatus = () => {
    if (!project.runner) return 'No Runner';
    return project.runner.status.charAt(0).toUpperCase() + project.runner.status.slice(1);
  };

  const getRunnerBadgeClass = () => {
    if (!project.runner) return 'badge-accent';
    const status = project.runner.status.toLowerCase();
    if (status === 'running' || status === 'active') return 'badge-success';
    if (status === 'idle') return 'badge-warning';
    return 'badge-accent';
  };

  const totalTasks = project.stats
    ? project.stats.pending + project.stats.in_progress + project.stats.review + project.stats.completed
    : 0;
  const completionRate = project.stats && totalTasks > 0 ? Math.round((project.stats.completed / totalTasks) * 100) : 0;
  const projectName = project.name || project.path.split('/').pop() || 'Project';

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="card p-6 mb-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">{projectName}</h1>
            <p className="text-text-muted mt-1 text-sm">{project.path}</p>
          </div>
          <span className={project.enabled ? 'badge-success' : 'badge-accent'}>
            {project.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
        <div className="flex items-center gap-6 p-4 bg-bg-surface rounded-lg">
          <div className="flex-1">
            <div className="text-sm text-text-secondary">Runner Status</div>
            <div className="flex items-center gap-2 mt-1">
              <span className={getRunnerBadgeClass()}>{getRunnerStatus()}</span>
              {project.runner?.pid && <span className="text-sm text-text-muted">PID {project.runner.pid}</span>}
            </div>
          </div>
          {project.runner?.current_task_id && (
            <div className="flex-1">
              <div className="text-sm text-text-secondary">Current Task</div>
              <div className="text-sm font-mono text-text-primary mt-1">{project.runner.current_task_id.substring(0, 8)}...</div>
            </div>
          )}
          <div className="flex-1">
            <div className="text-sm text-text-secondary">Last Seen</div>
            <div className="text-sm text-text-primary mt-1">{new Date(project.last_seen_at).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {project.stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <StatTile label="Pending" value={project.stats.pending} description="Waiting to start" />
          <StatTile label="In Progress" value={project.stats.in_progress} description="Currently being worked on" variant="info" />
          <StatTile label="In Review" value={project.stats.review} description="Awaiting review" variant="warning" />
          <StatTile label="Completed" value={project.stats.completed} description="Successfully finished" variant="success" />
        </div>
      )}

      {project.stats && totalTasks > 0 && (
        <div className="card p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-text-primary">Overall Progress</h2>
            <span className="text-2xl font-bold text-text-primary">{completionRate}%</span>
          </div>
          <div className="w-full bg-bg-surface rounded-full h-4 overflow-hidden">
            <div className="bg-success h-4 transition-all duration-500" style={{ width: `${completionRate}%` }} />
          </div>
          <div className="text-sm text-text-secondary mt-2">{project.stats.completed} of {totalTasks} tasks completed</div>
        </div>
      )}

      {!project.stats && (
        <div className="card p-6 text-center border border-info/20 bg-info-soft/30">
          <p className="text-info">Statistics not yet available. Runner will update stats during operation.</p>
        </div>
      )}

      <div className="card p-6">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Project Information</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-text-secondary">Registered</div>
            <div className="text-text-primary mt-1">{new Date(project.registered_at).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-text-secondary">Status</div>
            <div className="text-text-primary mt-1">{project.enabled ? 'Enabled for automation' : 'Disabled'}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
