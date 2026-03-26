import React from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
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
      getDetails: vi.fn(),
      getTimeline: vi.fn(),
    },
    projectsApi: {
      ...actual.projectsApi,
      reset: vi.fn(),
      openFolder: vi.fn(),
    },
  };
});

vi.mock('../services/project-recovery-api', () => ({
  projectRecoveryApi: {
    get: vi.fn(),
  },
}));

const mockTasksApi = api.tasksApi as unknown as {
  getDetails: ReturnType<typeof vi.fn>;
  getTimeline: ReturnType<typeof vi.fn>;
};

const mockProjectsApi = api.projectsApi as unknown as {
  reset: ReturnType<typeof vi.fn>;
  openFolder: ReturnType<typeof vi.fn>;
};

const mockProjectRecoveryApi = recoveryApi.projectRecoveryApi as unknown as {
  get: ReturnType<typeof vi.fn>;
};

const taskDetails = {
  id: 'blocked-task',
  title: 'Blocked task',
  status: 'blocked_error',
  section_id: null,
  section_name: null,
  source_file: null,
  rejection_count: 0,
  blocked_reason: 'bad',
  created_at: '2026-03-26T20:00:00Z',
  updated_at: '2026-03-26T20:00:00Z',
  duration: {
    total_seconds: 0,
    in_progress_seconds: 0,
    review_seconds: 0,
  },
  audit_trail: [],
  invocations: [],
  disputes: [],
  github_url: null,
};

describe('TaskDetailPage recovery panel', () => {
  const originalConfirm = window.confirm;
  const originalEventSource = globalThis.EventSource;
  let TaskDetailPageLazy: React.FC;

  beforeAll(async () => {
    const mod = await import('./TaskDetailPage');
    TaskDetailPageLazy = mod.TaskDetailPage;
  });

  beforeEach(() => {
    window.confirm = vi.fn(() => true);
    vi.stubGlobal('EventSource', class {
      onopen: ((this: EventSource, ev: Event) => any) | null = null;
      onmessage: ((this: EventSource, ev: MessageEvent<any>) => any) | null = null;
      onerror: ((this: EventSource, ev: Event) => any) | null = null;
      close() {}
    });
    mockTasksApi.getDetails.mockResolvedValue(taskDetails);
    mockTasksApi.getTimeline.mockResolvedValue([]);
    mockProjectsApi.reset.mockResolvedValue(undefined);
    mockProjectsApi.openFolder.mockResolvedValue(undefined);
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
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    if (originalEventSource) {
      vi.stubGlobal('EventSource', originalEventSource);
    } else {
      vi.unstubAllGlobals();
    }
    vi.clearAllMocks();
  });

  it('resets the whole project from task detail without removing task-specific restart', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/task/blocked-task?project=/tmp/test-project']}>
        <Routes>
          <Route path="/task/:taskId" element={<TaskDetailPageLazy />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Reset Project' })).toBeInTheDocument();
    });

    expect(screen.getByText('Task Blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset Project' }));

    await waitFor(() => {
      expect(mockProjectsApi.reset).toHaveBeenCalledWith('/tmp/test-project');
    });
  });
});
