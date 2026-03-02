import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AIRoleSettings } from './AIRoleSettings';
import { aiApi } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    aiApi: {
      ...actual.aiApi,
      getProviders: vi.fn(),
      getModels: vi.fn(),
    },
  };
});

const mockAiApi = aiApi as unknown as {
  getProviders: ReturnType<typeof vi.fn>;
  getModels: ReturnType<typeof vi.fn>;
};

const reviewerSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: ['claude'] },
    model: { type: 'string' },
    customInstructions: { type: 'string' },
  },
} as any;

describe('AIRoleSettings reviewer focus instructions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAiApi.getProviders.mockResolvedValue([{ id: 'claude', name: 'Claude', installed: true }]);
    mockAiApi.getModels.mockResolvedValue({ models: [{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4' }] });
  });

  it('renders focus instructions for reviewer role and propagates changes', async () => {
    const onChange = vi.fn();

    render(
      <AIRoleSettings
        role="reviewer"
        schema={reviewerSchema}
        values={{ ai: { reviewer: { provider: 'claude', model: 'claude-sonnet-4', customInstructions: '' } } }}
        onChange={onChange}
        basePath="ai.reviewer"
      />
    );

    const textarea = await screen.findByLabelText('Focus Instructions');
    fireEvent.change(textarea, { target: { value: 'Prioritize migration safety.' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('ai.reviewer.customInstructions', 'Prioritize migration safety.');
    });
  });

  it('uses inherited focus instructions and disables editing in project scope', async () => {
    render(
      <AIRoleSettings
        role="reviewer"
        schema={reviewerSchema}
        values={{ ai: { reviewer: { provider: '', model: '', customInstructions: '' } } }}
        globalValues={{ ai: { reviewer: { provider: 'claude', model: 'claude-sonnet-4', customInstructions: 'Global rule' } } }}
        onChange={vi.fn()}
        basePath="ai.reviewer"
        scope="project"
      />
    );

    const textarea = await screen.findByLabelText('Focus Instructions');
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveValue('Global rule');
  });
});
