import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectProvider, useProject } from './contexts/ProjectContext';
import App from './App';
import * as api from './services/api';
import type { CreditAlert } from './services/api';

// Mock the API module
vi.mock('./services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    configApi: {
      ...actual.configApi,
      getConfig: vi.fn(),
    },
    creditAlertsApi: {
      getActive: vi.fn(),
      dismiss: vi.fn(),
      retry: vi.fn(),
    },
  };
});

const mockConfigApi = api.configApi as unknown as { getConfig: ReturnType<typeof vi.fn> };
const mockCreditAlertsApi = api.creditAlertsApi as unknown as {
  getActive: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
};

const fakeConfig = {
  ai: {
    orchestrator: { provider: 'claude', model: 'opus' },
    coder: { provider: 'claude', model: 'opus' },
    reviewer: { provider: 'claude', model: 'opus' },
  },
};

const fakeAlert: CreditAlert = {
  id: 'alert-1',
  provider: 'claude',
  model: 'opus',
  role: 'coder',
  message: 'Insufficient credits',
  createdAt: '2025-01-15T10:30:00Z',
};

// Helper to pre-select a project in context so the modal renders
function ProjectSetter({ children }: { children: React.ReactNode }) {
  const { setSelectedProject } = useProject();
  useEffect(() => {
    setSelectedProject({
      path: '/test/project',
      name: 'Test Project',
      enabled: true,
      registered_at: '2025-01-01T00:00:00Z',
      last_seen_at: '2025-01-01T00:00:00Z',
      last_activity_at: null,
    });
  }, [setSelectedProject]);
  return <>{children}</>;
}

function renderApp({ withProject = false } = {}) {
  const wrapper = withProject ? (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProjectProvider>
        <ProjectSetter>
          <App />
        </ProjectSetter>
      </ProjectProvider>
    </MemoryRouter>
  ) : (
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ProjectProvider>
        <App />
      </ProjectProvider>
    </MemoryRouter>
  );
  return render(wrapper);
}

describe('App credit alert integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockConfigApi.getConfig.mockResolvedValue(fakeConfig);
    mockCreditAlertsApi.getActive.mockResolvedValue([]);
    mockCreditAlertsApi.dismiss.mockResolvedValue(undefined);
    mockCreditAlertsApi.retry.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('polls for credit alerts on mount', async () => {
    renderApp();

    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive).toHaveBeenCalled();
    });
  });

  it('polls credit alerts periodically', async () => {
    renderApp();

    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive).toHaveBeenCalled();
    });

    const initialCount = mockCreditAlertsApi.getActive.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive.mock.calls.length).toBeGreaterThan(initialCount);
    });
  });

  it('shows the modal when an alert is active and project is selected', async () => {
    mockCreditAlertsApi.getActive.mockResolvedValue([fakeAlert]);

    renderApp({ withProject: true });

    await waitFor(() => {
      expect(screen.getByText('Out of Credits')).toBeInTheDocument();
    });
  });

  it('does not show the modal or blur UI when no project is selected even if alert exists', async () => {
    mockCreditAlertsApi.getActive.mockResolvedValue([fakeAlert]);

    const { container } = renderApp({ withProject: false });

    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive).toHaveBeenCalled();
    });

    // Modal must not render
    expect(screen.queryByText('Out of Credits')).not.toBeInTheDocument();
    // Blur/lock class must NOT be applied (regression: hidden-lock prevention)
    expect(container.querySelector('.blur-sm.pointer-events-none')).toBeNull();
  });

  it('shows the modal and applies blur when alert exists and project is selected', async () => {
    mockCreditAlertsApi.getActive.mockResolvedValue([fakeAlert]);

    const { container } = renderApp({ withProject: true });

    await waitFor(() => {
      expect(screen.getByText('Out of Credits')).toBeInTheDocument();
    });

    // Blur/lock class must be applied when modal is visible
    expect(container.querySelector('.blur-sm.pointer-events-none')).not.toBeNull();
  });

  it('does not show the modal when there are no alerts', async () => {
    mockCreditAlertsApi.getActive.mockResolvedValue([]);

    renderApp({ withProject: true });

    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive).toHaveBeenCalled();
    });

    expect(screen.queryByText('Out of Credits')).not.toBeInTheDocument();
  });

  it('calls dismiss API with project path when Dismiss is clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCreditAlertsApi.getActive.mockResolvedValue([fakeAlert]);

    renderApp({ withProject: true });

    await waitFor(() => {
      expect(screen.getByText('Out of Credits')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /dismiss/i }));

    await waitFor(() => {
      expect(mockCreditAlertsApi.dismiss).toHaveBeenCalledWith('alert-1', '/test/project');
    });

    await waitFor(() => {
      expect(screen.queryByText('Out of Credits')).not.toBeInTheDocument();
    });
  });

  it('calls retry API with project path when Retry is clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockCreditAlertsApi.getActive.mockResolvedValue([fakeAlert]);

    renderApp({ withProject: true });

    await waitFor(() => {
      expect(screen.getByText('Out of Credits')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(mockCreditAlertsApi.retry).toHaveBeenCalledWith('alert-1', '/test/project');
    });

    await waitFor(() => {
      expect(screen.queryByText('Out of Credits')).not.toBeInTheDocument();
    });
  });

  it('silently ignores polling errors', async () => {
    mockCreditAlertsApi.getActive.mockRejectedValue(new Error('Network error'));

    renderApp();

    // App should render without crashing
    await waitFor(() => {
      expect(mockCreditAlertsApi.getActive).toHaveBeenCalled();
    });
  });
});
