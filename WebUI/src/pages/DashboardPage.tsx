import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Project, ActivityStats, TimeRangeOption, TIME_RANGE_OPTIONS, ActivityStatusType } from '../types';
import { StatTile } from '../components/molecules/StatTile';
import { TimeRangeSelector } from '../components/molecules/TimeRangeSelector';
import { activityApi, projectsApi } from '../services/api';

interface DashboardPageProps {
  project?: Project | null;
}

interface AggregateStats {
  pending: number;
  in_progress: number;
  review: number;
  completed: number;
  enabledProjects: number;
  disabledProjects: number;
  runningRunners: number;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ project }) => {
  const navigate = useNavigate();
  const [selectedRange, setSelectedRange] = useState<TimeRangeOption>(TIME_RANGE_OPTIONS[1]); // Default: 24h
  const [activityStats, setActivityStats] = useState<ActivityStats | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [aggregateStats, setAggregateStats] = useState<AggregateStats | null>(null);

  const fetchActivityStats = useCallback(async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const stats = await activityApi.getStats(selectedRange.hours, project?.path);
      setActivityStats(stats);
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : 'Failed to load activity stats');
    } finally {
      setActivityLoading(false);
    }
  }, [selectedRange.hours, project?.path]);

  const fetchAggregateStats = useCallback(async () => {
    if (project) return;
    try {
      const projects = await projectsApi.list(false);
      const aggregate: AggregateStats = {
        pending: 0,
        in_progress: 0,
        review: 0,
        completed: 0,
        enabledProjects: 0,
        disabledProjects: 0,
        runningRunners: 0,
      };
      for (const p of projects) {
        if (p.enabled) {
          aggregate.enabledProjects++;
        } else {
          aggregate.disabledProjects++;
        }
        if (p.stats) {
          aggregate.pending += p.stats.pending;
          aggregate.in_progress += p.stats.in_progress;
          aggregate.review += p.stats.review;
          aggregate.completed += p.stats.completed;
        }
        if (p.runner?.status === 'running') {
          aggregate.runningRunners++;
        }
      }
      setAggregateStats(aggregate);
    } catch (err) {
      console.error('Failed to load aggregate stats:', err);
    }
  }, [project]);

  useEffect(() => {
    fetchActivityStats();
    fetchAggregateStats();
  }, [fetchActivityStats, fetchAggregateStats]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchActivityStats();
      fetchAggregateStats();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchActivityStats, fetchAggregateStats]);

  const navigateToActivity = (status: ActivityStatusType) => {
    navigate(`/activity?status=${status}&hours=${selectedRange.hours}`);
  };

  function renderActivityStats() {
    return (
      <>
        {activityLoading && !activityStats && (
          <div className="text-center py-4 text-text-muted">Loading activity stats...</div>
        )}

        {activityError && (
          <div className="text-center py-4 text-danger">{activityError}</div>
        )}

        {activityStats && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-4">
              <StatTile
                label="Completed"
                value={activityStats.completed}
                variant="success"
                onClick={() => navigateToActivity('completed')}
              />
              <StatTile
                label="Failed"
                value={activityStats.failed}
                variant="danger"
                onClick={() => navigateToActivity('failed')}
              />
              <StatTile
                label="Skipped"
                value={activityStats.skipped}
                variant="warning"
                onClick={() => navigateToActivity('skipped')}
              />
              <StatTile
                label="Partial"
                value={activityStats.partial}
                variant="info"
                onClick={() => navigateToActivity('partial')}
              />
              <StatTile
                label="Disputed"
                value={activityStats.disputed}
                variant="default"
                onClick={() => navigateToActivity('disputed')}
              />
            </div>
            <div className="flex items-center gap-6 text-sm text-text-secondary">
              <div>
                <span className="font-medium text-text-primary">{activityStats.tasks_per_hour}</span> tasks/hour
              </div>
              <div>
                <span className="font-medium text-text-primary">{activityStats.success_rate}%</span> success rate
              </div>
              <div className="text-text-muted">
                {activityStats.total} total in last {selectedRange.label}
              </div>
            </div>
          </>
        )}

        {!activityLoading && !activityError && activityStats && activityStats.total === 0 && (
          <div className="text-center py-2 text-text-muted">No activity in the selected time range</div>
        )}
      </>
    );
  }

  // Project-specific view
  if (project) {
    const totalTasks = project.stats
      ? project.stats.pending + project.stats.in_progress + project.stats.review + project.stats.completed
      : 0;
    const completionRate = project.stats && totalTasks > 0 ? Math.round((project.stats.completed / totalTasks) * 100) : 0;
    const projectName = project.name || project.path.split('/').pop() || 'Project';

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
                <div
                  className="text-sm font-mono text-accent mt-1 cursor-pointer hover:underline"
                  onClick={() => navigate(`/task/${project.runner!.current_task_id}?project=${encodeURIComponent(project.path)}`)}
                >
                  <i className="fa-solid fa-arrow-up-right-from-square text-xs mr-1"></i>
                  {project.runner.current_task_id.substring(0, 8)}...
                </div>
              </div>
            )}
            <div className="flex-1">
              <div className="text-sm text-text-secondary">Last Seen</div>
              <div className="text-sm text-text-primary mt-1">{new Date(project.last_seen_at).toLocaleString()}</div>
            </div>
          </div>
        </div>

        <div className="card p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-text-primary">Activity</h2>
            <TimeRangeSelector value={selectedRange.value} onChange={setSelectedRange} />
          </div>
          {renderActivityStats()}
        </div>

        {project.stats && (
          <>
            <h2 className="text-lg font-semibold text-text-primary mb-4">Current Queue</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
              <StatTile label="Pending" value={project.stats.pending} description="Waiting to start" />
              <StatTile label="In Progress" value={project.stats.in_progress} description="Currently being worked on" variant="info" />
              <StatTile label="In Review" value={project.stats.review} description="Awaiting review" variant="warning" />
              <StatTile label="Completed" value={project.stats.completed} description="Successfully finished" variant="success" />
            </div>
          </>
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
      </div>
    );
  }

  // Aggregate view (no project selected - home dashboard)
  const totalTasks = aggregateStats
    ? aggregateStats.pending + aggregateStats.in_progress + aggregateStats.review + aggregateStats.completed
    : 0;
  const completionRate = aggregateStats && totalTasks > 0
    ? Math.round((aggregateStats.completed / totalTasks) * 100)
    : 0;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="card p-6 mb-6">
        <h1 className="text-3xl font-bold text-text-primary mb-2">Steroids Dashboard</h1>
        <p className="text-text-muted">Overview of all projects</p>
      </div>

      {aggregateStats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div
            className="card p-6 cursor-pointer hover:bg-bg-surface2 transition-colors"
            onClick={() => navigate('/projects?filter=disabled')}
          >
            <div className="text-sm text-text-secondary mb-2">Disabled Projects</div>
            <div className="text-4xl font-bold text-text-muted">{aggregateStats.disabledProjects}</div>
            <div className="text-xs text-text-muted mt-1">Click to view disabled projects</div>
          </div>
          <div
            className="card p-6 cursor-pointer hover:bg-bg-surface2 transition-colors"
            onClick={() => navigate('/projects?filter=enabled')}
          >
            <div className="text-sm text-text-secondary mb-2">Enabled Projects</div>
            <div className="text-4xl font-bold text-success">{aggregateStats.enabledProjects}</div>
            <div className="text-xs text-text-muted mt-1">Click to view enabled projects</div>
          </div>
          <div
            className="card p-6 cursor-pointer hover:bg-bg-surface2 transition-colors"
            onClick={() => navigate('/runners')}
          >
            <div className="text-sm text-text-secondary mb-2">Active Runners</div>
            <div className="text-4xl font-bold text-accent">{aggregateStats.runningRunners}</div>
            <div className="text-xs text-text-muted mt-1">Click to view runners</div>
          </div>
        </div>
      )}

      <div className="card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Activity</h2>
          <TimeRangeSelector value={selectedRange.value} onChange={setSelectedRange} />
        </div>
        {renderActivityStats()}
      </div>

      {aggregateStats && (
        <>
          <h2 className="text-lg font-semibold text-text-primary mb-4">Current Queue (All Projects)</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <StatTile label="Pending" value={aggregateStats.pending} description="Waiting to start" />
            <StatTile label="In Progress" value={aggregateStats.in_progress} description="Currently being worked on" variant="info" />
            <StatTile label="In Review" value={aggregateStats.review} description="Awaiting review" variant="warning" />
            <StatTile label="Completed" value={aggregateStats.completed} description="Successfully finished" variant="success" />
          </div>
        </>
      )}

      {aggregateStats && totalTasks > 0 && (
        <div className="card p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-text-primary">Overall Progress</h2>
            <span className="text-2xl font-bold text-text-primary">{completionRate}%</span>
          </div>
          <div className="w-full bg-bg-surface rounded-full h-4 overflow-hidden">
            <div className="bg-success h-4 transition-all duration-500" style={{ width: `${completionRate}%` }} />
          </div>
          <div className="text-sm text-text-secondary mt-2">{aggregateStats.completed} of {totalTasks} tasks completed</div>
        </div>
      )}
    </div>
  );
};
