import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../../services/api';
import { AISetupModal } from './AISetupModal';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    aiApi: {
      ...actual.aiApi,
      getProviders: vi.fn(),
      getModels: vi.fn(),
    },
    configApi: {
      ...actual.configApi,
      getConfig: vi.fn(),
      setConfig: vi.fn(),
    },
  };
});

const mockAiApi = api.aiApi as unknown as {
  getProviders: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
};

const mockConfigApi = api.configApi as unknown as {
  getConfig: ReturnType<typeof vi.fn>;
  setConfig: ReturnType<typeof vi.fn>;
};

const globalConfig = {
  ai: {
    orchestrator: { provider: 'claude', model: 'claude-sonnet-4-6' },
    coder: { provider: 'claude', model: 'claude-sonnet-4-6' },
    reviewer: { provider: 'claude', model: 'claude-sonnet-4-6' },
    reviewers: [],
  },
};

const projectOverrideConfig = {
  ai: {
    orchestrator: { provider: 'codex', model: 'gpt-5.3-codex' },
    coder: { provider: 'codex', model: 'gpt-5.3-codex' },
    reviewer: { provider: 'codex', model: 'gpt-5.3-codex' },
    reviewers: [],
  },
};

describe('AISetupModal project inheritance', () => {
  beforeEach(() => {
    mockAiApi.getProviders.mockResolvedValue([
      { id: 'claude', name: 'Claude', installed: true },
      { id: 'codex', name: 'Codex', installed: true },
    ]);
    mockAiApi.getModels.mockImplementation(async (provider: string) => ({
      success: true,
      provider,
      source: 'cache',
      models: [
        { id: provider === 'codex' ? 'gpt-5.3-codex' : 'claude-sonnet-4-6', name: 'Default Model' },
      ],
    }));
    mockConfigApi.getConfig.mockImplementation(async (scope: string) => {
      if (scope === 'global') return globalConfig;
      return projectOverrideConfig;
    });
    mockConfigApi.setConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setAllRolesToInherited() {
    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.queryByText('Loading providers...')).not.toBeInTheDocument();
    });

    const selects = screen.getAllByRole('combobox');
    const providerSelects = [selects[0], selects[2], selects[4]];
    for (const select of providerSelects) {
      await user.selectOptions(select, '');
    }

    const saveButton = screen.getByRole('button', { name: /Save & Continue/i });
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);
  }

  it('saves project config when all roles are switched to inherited', async () => {
    const onComplete = vi.fn();

    render(
      <AISetupModal
        onComplete={onComplete}
        isProjectLevel={true}
        projectPath="/tmp/test-project"
        inheritedConfig={globalConfig}
      />
    );

    await setAllRolesToInherited();

    await waitFor(() => {
      expect(mockConfigApi.setConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          'ai.orchestrator.provider': '',
          'ai.orchestrator.model': '',
          'ai.coder.provider': '',
          'ai.coder.model': '',
          'ai.reviewer.provider': '',
          'ai.reviewer.model': '',
          'ai.reviewers': [],
        }),
        'project',
        '/tmp/test-project'
      );
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it('uses fetched global config as inheritance source when parent inheritedConfig is missing', async () => {
    const onComplete = vi.fn();

    render(
      <AISetupModal
        onComplete={onComplete}
        isProjectLevel={true}
        projectPath="/tmp/test-project"
      />
    );

    await setAllRolesToInherited();

    await waitFor(() => {
      expect(mockConfigApi.setConfig).toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalled();
    });
  });

});
