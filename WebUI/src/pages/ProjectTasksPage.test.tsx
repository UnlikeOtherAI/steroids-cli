import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../services/api';
import * as recoveryApi from '../services/project-recovery-api';

vi.mock('../hooks/useReloadSelfHeal', () => ({
  useReloadSelfHeal: () => undefined,
}));

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    tasksApi: {
      ...actual.tasksApi,
      listForProject: vi.fn(),
    },
    sectionsApi: {
      ...actual.sectionsApi,
      listForProject: vi.fn(),
    },
    projectsApi: {
      ...actual.projectsApi,
      reset: vi.fn(),
    },
  };
});

vi.mock('../services/project-recovery-api', () => ({
  projectRecoveryApi: {
    get: vi.fn(),
  },
}));

const mockTasksApi = api.tasksApi as unknown as {
  listForProject: ReturnType<typeof vi.fn>;
};

const mockSectionsApi = api.sectionsApi as unknown as {
  listForProject: ReturnType<typeof vi.fn>;
};

const mockProjectsApi = api.projectsApi as unknown as {
  reset: ReturnType<typeof vi.fn>;
};

const mockProjectRecoveryApi = recoveryApi.projectRecoveryApi as unknown as {
  get: ReturnType<typeof vi.fn>;
};

describe('ProjectTasksPage recovery panel', () => {
  const originalConfirm = window.confirm;
  let ProjectTasksPageLazy: React.FC;

  beforeAll(async () => {
    const mod = await import('./ProjectTasksPage');
    ProjectTasksPageLazy = mod.ProjectTasksPage;
  });

  beforeEach(() => {
    window.confirm = vi.fn(() => true);
    mockSectionsApi.listForProject.mockResolvedValue({ sections: [] });
    mockTasksApi.listForProject.mockResolvedValue({
      success: true,
      project: '/tmp/test-project',
      tasks: [
        {
          id: 'blocked-task',
          title: 'Blocked task',
          status: 'blocked_error',
          section_id: null,
          section_name: null,
          source_file: null,
          rejection_count: 0,
          failure_count: 1,
          blocked_reason: 'bad',
          created_at: '2026-03-26T20:00:00Z',
          updated_at: '2026-03-26T20:00:00Z',
        },
      ],
      count: 1,
      status_counts: { blocked_error: 1 },
    });
    mockProjectRecoveryApi.get.mockResolvedValue({
      can_reset_project: true,
      reset_reason_counts: {
        failed: 0,
        disputed: 0,
        blocked_error: 1,
        blocked_conflict: 0,
        orphaned_in_progress: 0,
      },
      last_active_task: {
        id: 'task-1',
        title: 'Core dispatcher',
        status: 'review',
        role: 'reviewer',
        last_activity_at: '2026-03-26T20:47:07.000Z',
        dependent_task_count: 1,
      },
    });
    mockProjectsApi.reset.mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    vi.clearAllMocks();
  });

  it('resets the whole project from the task list page', async () => {
    const user = userEvent.setup();
    const encodedPath = encodeURIComponent('/tmp/test-project');

    render(
      <MemoryRouter initialEntries={[`/project/${encodedPath}/tasks?status=blocked_error`]}>
        <Routes>
          <Route path="/project/:projectPath/tasks" element={<ProjectTasksPageLazy />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reset Project' })).toBeInTheDocument();
    });

    expect(screen.getByRole('link', { name: 'Core dispatcher' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset Project' }));

    await waitFor(() => {
      expect(mockProjectsApi.reset).toHaveBeenCalledWith('/tmp/test-project');
    });
  });
});
