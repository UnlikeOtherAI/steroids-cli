import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { MonitorPage } from './MonitorPage';
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

vi.mock('../components/onboarding/AISetupRoleSelector', () => ({
  AISetupRoleSelector: () => <div data-testid="ai-setup-role-selector" />,
}));

const mockMonitorApi = apiModule.monitorApi as unknown as {
  getConfig: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  listRuns: ReturnType<typeof vi.fn>;
};

const mockAiApi = apiModule.aiApi as unknown as {
  getProviders: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
};

const baseConfig = {
  enabled: true,
  interval_seconds: 300,
  first_responder_agents: [],
  response_preset: 'triage_only',
  canonical_response_mode: 'triage_only' as const,
  response_preset_deprecated: false,
  custom_prompt: null,
  escalation_rules: { min_severity: 'warning' as const },
  first_responder_timeout_seconds: 900,
  updated_at: Date.now(),
};

describe('MonitorPage response modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiApi.getProviders.mockResolvedValue([]);
    mockMonitorApi.listRuns.mockResolvedValue({ runs: [], total: 0 });
    mockMonitorApi.updateConfig.mockResolvedValue(undefined);
  });

  it('shows the four canonical response modes and not the legacy presets', async () => {
    mockMonitorApi.getConfig.mockResolvedValue(baseConfig);

    render(
      <MemoryRouter>
        <MonitorPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Just Monitor')).toBeInTheDocument();
    });

    expect(screen.getByText('Triage Only')).toBeInTheDocument();
    expect(screen.getByText('Fix & Monitor')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.queryByText('Stop on Error')).not.toBeInTheDocument();
    expect(screen.queryByText('Investigate & Stop')).not.toBeInTheDocument();
  });

  it('shows a migration warning when the stored preset is legacy', async () => {
    mockMonitorApi.getConfig.mockResolvedValue({
      ...baseConfig,
      response_preset: 'investigate_and_stop',
      canonical_response_mode: 'triage_only',
      response_preset_deprecated: true,
    });

    render(
      <MemoryRouter>
        <MonitorPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/legacy monitor preset is configured/i)).toBeInTheDocument();
    });
  });
});
