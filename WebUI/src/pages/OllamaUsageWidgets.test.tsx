import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OllamaUsageWidgets } from './OllamaUsageWidgets';
import { modelUsageApi } from '../services/modelUsageApi';

vi.mock('../services/modelUsageApi', async () => {
  const actual = await vi.importActual<typeof import('../services/modelUsageApi')>('../services/modelUsageApi');
  return {
    ...actual,
    modelUsageApi: {
      ...actual.modelUsageApi,
      streamOllamaPull: vi.fn(),
    },
  };
});

describe('OllamaUsageWidgets', () => {
  it('renders usage, throughput, and vram runtime stats', () => {
    render(
      <OllamaUsageWidgets
        ollama={{
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 250,
            total_tokens: 1250,
            requests: 7,
            avg_tokens_per_second: 32.345,
          },
          by_model: [
            {
              model: 'qwen2.5-coder:32b',
              prompt_tokens: 1000,
              completion_tokens: 250,
              total_tokens: 1250,
              requests: 7,
              avg_tokens_per_second: 32.345,
            },
          ],
          runtime: {
            connected: true,
            endpoint: 'http://localhost:11434',
            mode: 'local',
            loaded_models: 1,
            total_vram_bytes: 8_000_000_000,
            total_ram_bytes: 2_000_000_000,
            models: [
              {
                name: 'qwen2.5-coder:32b',
                size_bytes: 10_000_000_000,
                vram_bytes: 8_000_000_000,
                ram_bytes: 2_000_000_000,
                context_length: 32768,
                expires_at: '2999-01-01T00:00:00Z',
                unload_in_seconds: 120,
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText('Ollama Usage')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('32.3 tok/s')).toBeInTheDocument();
    expect(screen.getByText('Per model (1)')).toBeInTheDocument();
    expect(screen.getAllByText(/qwen2.5-coder:32b/)).toHaveLength(2);
    expect(screen.getByText(/unload in 2m 0s/)).toBeInTheDocument();
  });

  it('renders streamed pull progress bar while model download is active', async () => {
    const streamMock = vi.mocked(modelUsageApi.streamOllamaPull);
    streamMock.mockImplementation(async (_model, onProgress) => {
      onProgress({ status: 'downloading', phase: 'downloading', percent: 42, done: false });
      onProgress({ status: 'success', phase: 'complete', percent: 100, done: true });
    });

    const user = userEvent.setup();
    render(
      <OllamaUsageWidgets
        ollama={{
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            requests: 1,
            avg_tokens_per_second: 20,
          },
          by_model: [],
          runtime: {
            connected: true,
            endpoint: 'http://localhost:11434',
            mode: 'local',
            loaded_models: 0,
            total_vram_bytes: 0,
            total_ram_bytes: 0,
            models: [],
          },
        }}
      />,
    );

    await user.type(screen.getByPlaceholderText('e.g. deepseek-coder-v2:33b'), 'qwen2.5-coder:32b');
    await user.click(screen.getByRole('button', { name: 'Pull Model' }));

    expect(streamMock).toHaveBeenCalledWith('qwen2.5-coder:32b', expect.any(Function));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/complete: success/)).toBeInTheDocument();
  });
});
