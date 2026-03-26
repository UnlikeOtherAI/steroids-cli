import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { MonitorRunDetailPage } from './MonitorRunDetailPage';
import * as apiModule from '../services/api';

vi.mock('../services/api', async () => ({
  monitorApi: {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    listRuns: vi.fn(),
    triggerRun: vi.fn(),
    clearRuns: vi.fn(),
    getRun: vi.fn(),
    investigate: vi.fn(),
    checkGhAvailable: vi.fn(),
    reportIssue: vi.fn(),
  },
  aiApi: {
    getProviders: vi.fn(),
    getModels: vi.fn(),
  },
}));

const mockMonitorApi = apiModule.monitorApi as unknown as {
  getRun: ReturnType<typeof vi.fn>;
  investigate: ReturnType<typeof vi.fn>;
  checkGhAvailable: ReturnType<typeof vi.fn>;
};

const redispatchRun = {
  id: 42,
  started_at: Date.now(),
  completed_at: Date.now(),
  outcome: 'first_responder_complete',
  scan_results: {
    timestamp: Date.now(),
    projectCount: 1,
    summary: '1 anomaly',
    anomalies: [
      {
        type: 'blocked_task',
        severity: 'critical' as const,
        projectPath: '/tmp/project',
        projectName: 'project',
        taskId: 'task-1',
        taskTitle: 'Blocked task',
        details: 'Task is blocked',
        context: {},
      },
    ],
  },
  escalation_reason: 'Needs another pass',
  first_responder_needed: true,
  first_responder_agent: 'claude/sonnet',
  first_responder_actions: [],
  first_responder_report: 'Needs more work',
  action_results: [],
  error: null,
  duration_ms: 1200,
};

describe('MonitorRunDetailPage response modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMonitorApi.getRun.mockResolvedValue(redispatchRun);
    mockMonitorApi.investigate.mockResolvedValue({ success: true, run_id: 42, status: 'first_responder_dispatched' });
    mockMonitorApi.checkGhAvailable.mockResolvedValue(false);
  });

  it('uses canonical redispatch modes and does not expose the legacy stop preset', async () => {
    render(
      <MemoryRouter initialEntries={['/monitor/run/42']}>
        <Routes>
          <Route path="/monitor/run/:runId" element={<MonitorRunDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Try to Fix')).toBeInTheDocument();
    });

    expect(screen.getByText('Triage Again')).toBeInTheDocument();
    expect(screen.queryByText('Stop All Runners')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Triage Again'));
    await waitFor(() => {
      expect(mockMonitorApi.investigate).toHaveBeenCalledWith(42, 'triage_only');
    });

    fireEvent.click(screen.getByText('Try to Fix'));
    await waitFor(() => {
      expect(mockMonitorApi.investigate).toHaveBeenCalledWith(42, 'fix_and_monitor');
    });
  });
});
