import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelUsageResponse, Project } from '../types';
import { ModelUsagePage } from './ModelUsagePage';
import * as usageApiModule from '../services/modelUsageApi';

vi.mock('../services/modelUsageApi', () => ({
  modelUsageApi: {
    getUsage: vi.fn(),
  },
}));

vi.mock('../contexts/ProjectContext', () => ({
  useProject: () => ({ selectedProject: null }),
}));

const mockModelUsageApi = usageApiModule.modelUsageApi as unknown as {
  getUsage: ReturnType<typeof vi.fn>;
};

const emptyResponse: ModelUsageResponse = {
  success: true,
  hours: 24,
  stats: {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    invocations: 0,
  },
  by_model: [],
  by_project: [],
};

const project: Project = {
  path: '/tmp/model-usage-test',
  name: 'Model Usage Test',
  enabled: true,
  registered_at: '2026-01-01T00:00:00Z',
  last_seen_at: '2026-01-01T00:00:00Z',
  last_activity_at: null,
  last_task_added_at: null,
};

describe('ModelUsagePage orchestration', () => {
  beforeEach(() => {
    mockModelUsageApi.getUsage.mockReset();
    mockModelUsageApi.getUsage.mockResolvedValue(emptyResponse);
  });

  it('calls getUsage on initial mount with default range and project path', async () => {
    render(<ModelUsagePage project={project} />);

    await waitFor(() => {
      expect(mockModelUsageApi.getUsage).toHaveBeenCalledWith(24, project.path);
    });
  });

  it('re-fetches when the selected time range changes', async () => {
    const user = userEvent.setup();
    render(<ModelUsagePage project={project} />);

    await waitFor(() => {
      expect(mockModelUsageApi.getUsage).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: '1w' }));

    await waitFor(() => {
      expect(mockModelUsageApi.getUsage).toHaveBeenCalledTimes(2);
    });
    expect(mockModelUsageApi.getUsage).toHaveBeenNthCalledWith(2, 168, project.path);
  });

  it('passes undefined project filter when no project is selected', async () => {
    render(<ModelUsagePage project={null} />);

    await waitFor(() => {
      expect(mockModelUsageApi.getUsage).toHaveBeenCalledWith(24, undefined);
    });
  });
});
