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
    activityApi: {
      ...actual.activityApi,
      getStats: vi.fn(),
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

const mockActivityApi = api.activityApi as unknown as {
  getStats: ReturnType<typeof vi.fn>;
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
};

const fakeStorage: StorageInfo = {
  total_bytes: 52428800,
  total_human: '50.0 MB',
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
    mockProjectsApi.list.mockResolvedValue([fakeProject]);
    mockProjectsApi.getStorage.mockResolvedValue(fakeStorage);
    mockProjectsApi.openFolder.mockResolvedValue(undefined);
    mockActivityApi.getStats.mockResolvedValue({
      completed: 10, failed: 2, skipped: 1, partial: 0, disputed: 0,
      tasks_per_hour: 1.5, success_rate: 77,
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
      expect(screen.getByText('46.0 MB of old logs can be cleared')).toBeInTheDocument();
    });

    expect(screen.getByText('Clear Old Logs')).toBeInTheDocument();
  });

  it('shows red warning banner when threshold_warning is red', async () => {
    mockProjectsApi.getStorage.mockResolvedValue({
      ...fakeStorage,
      threshold_warning: 'red',
      clearable_human: '120.0 MB',
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('120.0 MB of old logs can be cleared')).toBeInTheDocument();
    });
  });

  it('does not show warning banner when threshold_warning is null', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Database')).toBeInTheDocument();
    });

    expect(screen.queryByText(/of old logs can be cleared/)).not.toBeInTheDocument();
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
      expect(screen.getByText('Clear Old Logs')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Clear Old Logs'));

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
      expect(screen.getByText('Clear Old Logs')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Clear Old Logs'));

    await waitFor(() => {
      expect(screen.getByText('Cleanup failed')).toBeInTheDocument();
    });
  });
});
