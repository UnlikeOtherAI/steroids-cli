import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import { useReloadSelfHeal } from './useReloadSelfHeal';
import * as selfHealModule from '../services/self-heal-api';

vi.mock('../services/self-heal-api', async () => ({
  selfHealApi: {
    scheduleReloadSweep: vi.fn(),
  },
}));

const mockSelfHealApi = selfHealModule.selfHealApi as unknown as {
  scheduleReloadSweep: ReturnType<typeof vi.fn>;
};

function HookHarness(props: { source: 'runners_page' | 'task_page' | 'project_tasks_page'; projectPath?: string | null }) {
  useReloadSelfHeal(props);
  return null;
}

describe('useReloadSelfHeal', () => {
  it('schedules a reload sweep on mount', async () => {
    mockSelfHealApi.scheduleReloadSweep.mockResolvedValue({ success: true, scheduled: true, reason: 'scheduled' });

    render(<HookHarness source="runners_page" />);

    await waitFor(() => {
      expect(mockSelfHealApi.scheduleReloadSweep).toHaveBeenCalledWith('runners_page', undefined);
    });
  });

  it('passes the project path for project-scoped pages', async () => {
    mockSelfHealApi.scheduleReloadSweep.mockResolvedValue({ success: true, scheduled: true, reason: 'scheduled' });

    render(<HookHarness source="task_page" projectPath="/tmp/project-a" />);

    await waitFor(() => {
      expect(mockSelfHealApi.scheduleReloadSweep).toHaveBeenCalledWith('task_page', '/tmp/project-a');
    });
  });
});
