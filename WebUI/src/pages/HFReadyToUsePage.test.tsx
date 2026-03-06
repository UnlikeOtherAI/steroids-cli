import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HFReadyToUsePage } from './HFReadyToUsePage';
import * as hfApiModule from '../services/huggingFaceApi';

vi.mock('../services/huggingFaceApi', () => ({
  huggingFaceApi: {
    getReadyModels: vi.fn(),
    updateRoutingPolicy: vi.fn(),
    changeRuntime: vi.fn(),
    unpairModel: vi.fn(),
  },
}));

const mockApi = hfApiModule.huggingFaceApi as unknown as {
  getReadyModels: ReturnType<typeof vi.fn>;
  updateRoutingPolicy: ReturnType<typeof vi.fn>;
  changeRuntime: ReturnType<typeof vi.fn>;
  unpairModel: ReturnType<typeof vi.fn>;
};

describe('HFReadyToUsePage', () => {
  beforeEach(() => {
    mockApi.getReadyModels.mockReset();
    mockApi.updateRoutingPolicy.mockReset();
    mockApi.changeRuntime.mockReset();
    mockApi.unpairModel.mockReset();

    mockApi.getReadyModels.mockResolvedValue({
      models: [
        {
          modelId: 'deepseek-ai/DeepSeek-V3',
          runtime: 'claude-code',
          routingPolicy: 'fastest',
          supportsTools: true,
          available: true,
          addedAt: 1,
          providers: ['groq', 'novita'],
          contextLength: 131072,
          pricing: {
            groq: { input: 0.15, output: 0.75 },
            novita: { input: 0.05, output: 0.25 },
          },
          routingPolicyOptions: ['fastest', 'cheapest', 'preferred', 'groq', 'novita'],
        },
      ],
    });
    mockApi.updateRoutingPolicy.mockResolvedValue(undefined);
    mockApi.changeRuntime.mockResolvedValue(undefined);
    mockApi.unpairModel.mockResolvedValue(undefined);
  });

  it('loads ready-to-use model rows on mount', async () => {
    render(<HFReadyToUsePage />);

    await waitFor(() => {
      expect(mockApi.getReadyModels).toHaveBeenCalledTimes(1);
    });

    expect(await screen.findByText('deepseek-ai/DeepSeek-V3')).toBeInTheDocument();
    expect(screen.getAllByText('Claude Code').length).toBeGreaterThan(0);
    expect(screen.getByText('Price Indicator')).toBeInTheDocument();
    expect(screen.getByText('Context Length')).toBeInTheDocument();
  });

  it('updates routing policy via API', async () => {
    const user = userEvent.setup();
    render(<HFReadyToUsePage />);

    await screen.findByText('deepseek-ai/DeepSeek-V3');
    const select = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    await user.selectOptions(select, 'cheapest');

    await waitFor(() => {
      expect(mockApi.updateRoutingPolicy).toHaveBeenCalledWith({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        routingPolicy: 'cheapest',
      });
    });
  });

  it('removes pairings via API', async () => {
    const user = userEvent.setup();
    render(<HFReadyToUsePage />);

    await screen.findByText('deepseek-ai/DeepSeek-V3');
    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(mockApi.unpairModel).toHaveBeenCalledWith({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
      });
    });
  });

  it('changes runtime via API', async () => {
    const user = userEvent.setup();
    render(<HFReadyToUsePage />);

    await screen.findByText('deepseek-ai/DeepSeek-V3');
    const runtimeSelect = screen.getAllByRole('combobox')[1] as HTMLSelectElement;
    await user.selectOptions(runtimeSelect, 'opencode');

    await waitFor(() => {
      expect(mockApi.changeRuntime).toHaveBeenCalledWith({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        nextRuntime: 'opencode',
      });
    });
  });
});
