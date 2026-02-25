import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import * as api from '../services/api';
import type { StorageInfo } from '../types';

// Mock the API module
vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      list: vi.fn(),
      getStorage: vi.fn(),
      clearLogs: vi.fn(),
      openFolder: vi.fn(),
    },
    tasksApi: {
      ...actual.tasksApi,
      listForProject: vi.fn(),
    },
    sectionsApi: {
      ...actual.sectionsApi,
      listForProject: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getSchema: vi.fn(),
      getConfig: vi.fn(),
    },
  };
});

const mockProjectsApi = api.projectsApi as unknown as {
  list: ReturnType<typeof vi.fn>;
  getStorage: ReturnType<typeof vi.fn>;
  clearLogs: ReturnType<typeof vi.fn>;
  openFolder: ReturnType<typeof vi.fn>;
};

const mockTasksApi = api.tasksApi as unknown as {
  listForProject: ReturnType<typeof vi.fn>;
};

const mockSectionsApi = api.sectionsApi as unknown as {
  listForProject: ReturnType<typeof vi.fn>;
};

const fakeProject = {
  path: '/tmp/test-project',
  name: 'Test Project',
  enabled: true,
  registered_at: '2025-01-01T00:00:00Z',
  last_seen_at: '2025-01-01T00:00:00Z',
  last_activity_at: '2025-01-15T10:30:00Z',
  last_task_added_at: '2025-01-15T10:30:00Z',
  stats: {
    pending: 3,
    in_progress: 2,
    review: 1,
    completed: 10,
    failed: 2,
    disputed: 1,
    skipped: 1,
  },
};

const fakeStorage: StorageInfo = {
  total_bytes: 52428800,
  total_human: '50.0 MB',
  disk: {
    total_bytes: 536870912000,
    total_human: '500.0 GB',
    available_bytes: 268435456000,
    available_human: '250.0 GB',
  },
  breakdown: {
    database: { bytes: 2097152, human: '2.0 MB' },
    invocations: { bytes: 35651584, human: '34.0 MB', file_count: 847 },
    logs: { bytes: 12582912, human: '12.0 MB', file_count: 423 },
    backups: { bytes: 2097152, human: '2.0 MB', backup_count: 3 },
    other: { bytes: 0, human: '0 B' },
  },
  clearable_bytes: 48234496,
  clearable_human: '46.0 MB',
  threshold_warning: null,
};

function renderPage() {
  const encodedPath = encodeURIComponent('/tmp/test-project');
  return render(
    <MemoryRouter initialEntries={[`/project/${encodedPath}`]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/project/:projectPath" element={<ProjectDetailPageLazy />} />
      </Routes>
    </MemoryRouter>,
  );
}

// Lazy import to ensure mocks are set up first
let ProjectDetailPageLazy: React.FC;
beforeAll(async () => {
  const mod = await import('./ProjectDetailPage');
  ProjectDetailPageLazy = mod.ProjectDetailPage;
});

import React from 'react';
import { beforeAll } from 'vitest';

describe('ProjectDetailPage storage section', () => {
  beforeEach(() => {
    document.cookie = 'steroids_pd_storage_open=; path=/; max-age=0';
    document.cookie = 'steroids_pd_sections_open=; path=/; max-age=0';
    document.cookie = 'steroids_pd_issues_open=; path=/; max-age=0';
    document.cookie = 'steroids_stats_hours=; path=/; max-age=0';
    mockProjectsApi.list.mockResolvedValue([fakeProject]);
    mockProjectsApi.getStorage.mockResolvedValue(fakeStorage);
    mockProjectsApi.openFolder.mockResolvedValue(undefined);
    mockTasksApi.listForProject.mockImplementation((_path: string, options?: { issue?: string }) => {
      if (options?.issue === 'failed_retries') {
        return Promise.resolve({
          success: true,
          project: '/tmp/test-project',
          tasks: [
            {
              id: 'retry-task-1',
              title: 'Retry task',
              status: 'failed',
              section_id: null,
              section_name: null,
              source_file: null,
              rejection_count: 3,
              failure_count: 2,
              created_at: '2025-01-01T00:00:00Z',
              updated_at: '2025-01-01T00:00:00Z',
            },
          ],
          count: 1,
          status_counts: { failed: 1 },
        });
      }

      if (options?.issue === 'stale') {
        return Promise.resolve({
          success: true,
          project: '/tmp/test-project',
          tasks: [],
          count: 0,
          status_counts: {},
        });
      }

      return Promise.resolve({
        success: true,
        project: '/tmp/test-project',
        tasks: [],
        count: 0,
        status_counts: {
          pending: 3,
          in_progress: 2,
          review: 1,
          completed: 10,
          failed: 2,
          disputed: 1,
        },
      });
    });
    mockSectionsApi.listForProject.mockResolvedValue({ sections: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading skeleton while storage is null', async () => {
    // Make getStorage never resolve during this test
    mockProjectsApi.getStorage.mockReturnValue(new Promise(() => {}));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Storage')).toBeInTheDocument();
    });

    expect(screen.getByTestId('storage-loading')).toBeInTheDocument();
  });

  it('renders breakdown bars after storage loads', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Database')).toBeInTheDocument();
    });

    expect(screen.getByText('Invocation Logs')).toBeInTheDocument();
    expect(screen.getByText('Text Logs')).toBeInTheDocument();
    expect(screen.getByText('Backups')).toBeInTheDocument();
    expect(screen.getByText('Disk Available')).toBeInTheDocument();
    expect(screen.getByText('50.0 MB used / 250.0 GB available')).toBeInTheDocument();
    expect(screen.getByText('50.0 MB')).toBeInTheDocument();
  });

  it('shows total size as 0 B when total_bytes is zero', async () => {
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      total_bytes: 0,
      total_human: '0 B',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('0 B')).toBeInTheDocument();
    });
  });

  it('shows orange warning banner when threshold_warning is orange', async () => {
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      threshold_warning: 'orange',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('46.0 MB of old logs and backups can be cleared')).toBeInTheDocument();
    });

    expect(screen.getByText('Cleanup Project')).toBeInTheDocument();
  });

  it('shows red warning banner when threshold_warning is red', async () => {
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      threshold_warning: 'red',
      clearable_human: '120.0 MB',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('120.0 MB of old logs and backups can be cleared')).toBeInTheDocument();
    });
  });

  it('does not show warning banner when threshold_warning is null', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Database')).toBeInTheDocument();
    });

    expect(screen.queryByText(/of old logs and backups can be cleared/)).not.toBeInTheDocument();
  });

  it('shows success message and refetches storage after clearing logs', async () => {
    const user = userEvent.setup();
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      threshold_warning: 'orange',
    });
    mockProjectsApi.clearLogs.mockResolvedValue({
      ok: true,
      deleted_files: 100,
      freed_bytes: 48234496,
      freed_human: '46.0 MB',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Cleanup Project')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Cleanup Project'));

    await waitFor(() => {
      expect(screen.getByText('Freed 46.0 MB')).toBeInTheDocument();
    });

    // Should have called clearLogs with path and 7 day retention
    expect(mockProjectsApi.clearLogs).toHaveBeenCalledWith('/tmp/test-project', 7);
    // Should refetch storage after clearing
    expect(mockProjectsApi.getStorage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows error message when clearing logs fails', async () => {
    const user = userEvent.setup();
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      threshold_warning: 'orange',
    });
    mockProjectsApi.clearLogs.mockRejectedValue(new api.ApiError('Cleanup failed', 500));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Cleanup Project')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Cleanup Project'));

    await waitFor(() => {
      expect(screen.getByText('Cleanup failed')).toBeInTheDocument();
    });
  });

  it('renders project-scoped task stats cards and hides current queue', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Stats')).toBeInTheDocument();
    });

    expect(screen.queryByRole('heading', { name: 'Activity' })).not.toBeInTheDocument();
    expect(screen.queryByText('Current Queue')).not.toBeInTheDocument();
    expect(screen.getByText('Rate: 0 tasks/hour')).toBeInTheDocument();
    expect(screen.getByText('Success Rate: 52.6%')).toBeInTheDocument();
    expect(screen.getByText('19 tasks in selected range')).toBeInTheDocument();

    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Disputed')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: '12h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1w' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1m' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1y' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1y' })).toHaveClass('bg-accent');
  });

  it('persists storage, issues, and sections collapsed state in cookies across renders', async () => {
    const user = userEvent.setup();
    const firstRender = renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Storage' })).toHaveAttribute('aria-expanded', 'true');
    });

    const storageToggle = screen.getByRole('button', { name: 'Storage' });
    const issuesToggle = screen.getByRole('button', { name: 'Issues' });
    const sectionsToggle = screen.getByRole('button', { name: 'Sections' });

    await user.click(storageToggle);
    await user.click(issuesToggle);
    await user.click(sectionsToggle);

    expect(storageToggle).toHaveAttribute('aria-expanded', 'false');
    expect(issuesToggle).toHaveAttribute('aria-expanded', 'false');
    expect(sectionsToggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.cookie).toContain('steroids_pd_storage_open=0');
    expect(document.cookie).toContain('steroids_pd_issues_open=0');
    expect(document.cookie).toContain('steroids_pd_sections_open=0');

    firstRender.unmount();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Storage' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Issues' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Sections' })).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('hides issues section when there are no runner-blocking issues', async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        ...fakeProject,
        stats: {
          pending: 3,
          in_progress: 2,
          review: 1,
          completed: 10,
          failed: 0,
          disputed: 0,
          skipped: 0,
        },
      },
    ]);
    mockTasksApi.listForProject.mockImplementation((_path: string, options?: { issue?: string }) => {
      if (options?.issue === 'failed_retries' || options?.issue === 'stale') {
        return Promise.resolve({
          success: true,
          project: '/tmp/test-project',
          tasks: [],
          count: 0,
          status_counts: {},
        });
      }
      return Promise.resolve({
        success: true,
        project: '/tmp/test-project',
        tasks: [],
        count: 0,
        status_counts: {
          pending: 3,
          in_progress: 2,
          review: 1,
          completed: 10,
          failed: 0,
          disputed: 0,
          skipped: 0,
        },
      });
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Stats')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'Issues' })).not.toBeInTheDocument();
  });
});
