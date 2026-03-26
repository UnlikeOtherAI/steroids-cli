import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ProjectRecoveryPanel } from './ProjectRecoveryPanel';
import type { ProjectRecoverySummary } from '../../types';

const recovery: ProjectRecoverySummary = {
  can_reset_project: true,
  reset_reason_counts: {
    failed: 1,
    disputed: 0,
    blocked_error: 2,
    blocked_conflict: 0,
    orphaned_in_progress: 1,
  },
  last_active_task: {
    id: 'task-1',
    title: 'Core dispatcher',
    status: 'review',
    role: 'reviewer',
    last_activity_at: '2026-03-26T20:47:07.000Z',
    dependent_task_count: 2,
  },
};

describe('ProjectRecoveryPanel', () => {
  const originalConfirm = window.confirm;

  beforeEach(() => {
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    window.confirm = originalConfirm;
  });

  it('shows the last active task context and confirms whole-project reset', async () => {
    const user = userEvent.setup();
    const onResetProject = vi.fn().mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <ProjectRecoveryPanel
          projectPath="/tmp/test-project"
          recovery={recovery}
          onResetProject={onResetProject}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Last active task:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Core dispatcher' })).toBeInTheDocument();
    expect(screen.getByText('2 tasks depend on this task.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset Project' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onResetProject).toHaveBeenCalledTimes(1);
  });
});
