import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HFModelLibraryPage } from './HFModelLibraryPage';
import * as hfApiModule from '../services/huggingFaceApi';

vi.mock('../services/huggingFaceApi', () => ({
  huggingFaceApi: {
    getModels: vi.fn(),
    pairModel: vi.fn(),
  },
}));

const mockApi = hfApiModule.huggingFaceApi as unknown as {
  getModels: ReturnType<typeof vi.fn>;
  pairModel: ReturnType<typeof vi.fn>;
};

describe('HFModelLibraryPage', () => {
  beforeEach(() => {
    mockApi.getModels.mockReset();
    mockApi.pairModel.mockReset();

    mockApi.getModels.mockImplementation(async (query?: string) => {
      if (query) {
        return {
          source: 'search',
          models: [
            {
              id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
              pipelineTag: 'text-generation',
              downloads: 5000,
              likes: 400,
              tags: [],
              providers: ['novita'],
              addedAt: Date.now(),
              source: 'search',
            },
          ],
        };
      }

      return {
        source: 'curated',
        models: [
          {
            id: 'deepseek-ai/DeepSeek-V3',
            pipelineTag: 'text-generation',
            downloads: 100000,
            likes: 999,
            tags: [],
            providers: ['groq', 'novita'],
            addedAt: Date.now(),
            source: 'curated',
          },
        ],
      };
    });
    mockApi.pairModel.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads curated models on mount', async () => {
    render(<HFModelLibraryPage />);

    await waitFor(() => {
      expect(mockApi.getModels).toHaveBeenCalledWith();
    });

    expect(screen.getByText('deepseek-ai/DeepSeek-V3')).toBeInTheDocument();
  });

  it('falls back to remote search after debounce when curated has no local matches', async () => {
    const user = userEvent.setup();
    render(<HFModelLibraryPage />);

    await screen.findByText('deepseek-ai/DeepSeek-V3');
    await user.type(screen.getByPlaceholderText('Search model ID...'), 'qwen');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });

    await waitFor(() => {
      expect(mockApi.getModels).toHaveBeenCalledWith('qwen');
    });

    expect(screen.getByText('Qwen/Qwen2.5-Coder-32B-Instruct')).toBeInTheDocument();
  });

  it('pairs model with Claude Code runtime', async () => {
    const user = userEvent.setup();
    render(<HFModelLibraryPage />);

    await screen.findByText('deepseek-ai/DeepSeek-V3');
    await user.click(screen.getByRole('button', { name: 'Pair Claude Code' }));

    await waitFor(() => {
      expect(mockApi.pairModel).toHaveBeenCalledWith({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        routingPolicy: 'fastest',
      });
    });
  });
});
