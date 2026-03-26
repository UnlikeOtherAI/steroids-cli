import React from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../atoms/Badge';
import { Button } from '../atoms/Button';
import type { ProjectRecoverySummary, TaskStatus } from '../../types';

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  review: 'Review',
  completed: 'Completed',
  skipped: 'Skipped',
  failed: 'Failed',
  disputed: 'Disputed',
  blocked_error: 'Blocked',
  blocked_conflict: 'Conflict',
};

const STATUS_VARIANTS: Record<TaskStatus, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  pending: 'default',
  in_progress: 'info',
  review: 'warning',
  completed: 'success',
  skipped: 'warning',
  failed: 'danger',
  disputed: 'danger',
  blocked_error: 'danger',
  blocked_conflict: 'warning',
};

function buildResetSummaryLines(recovery: ProjectRecoverySummary): string[] {
  const counts = recovery.reset_reason_counts;
  const lines: string[] = [];

  if (counts.failed > 0) lines.push(`${counts.failed} failed`);
  if (counts.disputed > 0) lines.push(`${counts.disputed} disputed`);
  if (counts.blocked_error > 0) lines.push(`${counts.blocked_error} blocked-error`);
  if (counts.blocked_conflict > 0) lines.push(`${counts.blocked_conflict} blocked-conflict`);
  if (counts.orphaned_in_progress > 0) lines.push(`${counts.orphaned_in_progress} orphaned in-progress`);

  return lines;
}

function formatRole(role: string | null): string {
  if (!role) return 'unknown role';
  return role.replace(/_/g, ' ');
}

type ProjectRecoveryPanelProps = {
  projectPath: string;
  recovery: ProjectRecoverySummary | null;
  loading?: boolean;
  resetting?: boolean;
  onResetProject?: () => Promise<void> | void;
};

export const ProjectRecoveryPanel: React.FC<ProjectRecoveryPanelProps> = ({
  projectPath,
  recovery,
  loading = false,
  resetting = false,
  onResetProject,
}) => {
  if (!recovery && !loading) {
    return null;
  }

  const lines = recovery ? buildResetSummaryLines(recovery) : [];
  const lastActiveTask = recovery?.last_active_task ?? null;

  const handleReset = async () => {
    if (!recovery?.can_reset_project || !onResetProject) return;
    const summary = lines.length > 0 ? lines.join(', ') : 'the resettable project issues';
    const confirmed = window.confirm(
      `Reset the whole project?\n\nThis will reset ${summary} back to pending where applicable.`
    );
    if (!confirmed) return;
    await onResetProject();
  };

  return (
    <div className="mb-6 rounded-xl border border-border bg-bg-surface p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <i className="fa-solid fa-life-ring text-sm text-text-muted" />
            <h2 className="text-base font-semibold text-text-primary">Project Recovery</h2>
          </div>

          {loading && !recovery ? (
            <p className="text-sm text-text-muted">Loading project recovery…</p>
          ) : (
            <>
              {lastActiveTask ? (
                <div className="space-y-1">
                  <p className="text-sm text-text-secondary">
                    Last active task:
                    {' '}
                    <Link
                      className="font-medium text-accent hover:text-accent/80"
                      to={`/task/${lastActiveTask.id}?project=${encodeURIComponent(projectPath)}`}
                    >
                      {lastActiveTask.title}
                    </Link>
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <Badge variant={STATUS_VARIANTS[lastActiveTask.status as TaskStatus] ?? 'default'}>
                      {STATUS_LABELS[lastActiveTask.status as TaskStatus] ?? lastActiveTask.status}
                    </Badge>
                    <span>{formatRole(lastActiveTask.role)}</span>
                    <span>{new Date(lastActiveTask.last_activity_at).toLocaleString()}</span>
                  </div>
                  {lastActiveTask.dependent_task_count > 0 && (
                    <p className="text-xs text-warning">
                      {lastActiveTask.dependent_task_count} task{lastActiveTask.dependent_task_count === 1 ? '' : 's'} depend on this task.
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-text-muted">No recent task activity found.</p>
              )}

              {recovery?.can_reset_project ? (
                <p className="text-xs text-text-muted">
                  Resettable issues:
                  {' '}
                  {lines.join(', ')}
                </p>
              ) : (
                <p className="text-xs text-text-muted">No project-wide reset conditions are currently detected.</p>
              )}
            </>
          )}
        </div>

        {recovery?.can_reset_project && onResetProject && (
          <Button
            variant="accent"
            onClick={() => void handleReset()}
            disabled={resetting}
            className="justify-center"
          >
            {resetting ? 'Resetting…' : 'Reset Project'}
          </Button>
        )}
      </div>
    </div>
  );
};
