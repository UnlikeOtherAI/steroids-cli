import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OllamaModelLibraryPage } from './OllamaModelLibraryPage';
import * as ollamaApiModule from '../services/ollamaApi';

vi.mock('../services/ollamaApi', () => ({
  ollamaApi: {
    getLibraryModels: vi.fn(),
    pullModel: vi.fn(),
    pairInstalledModel: vi.fn(),
  },
}));

const mockApi = ollamaApiModule.ollamaApi as unknown as {
  getLibraryModels: ReturnType<typeof vi.fn>;
  pullModel: ReturnType<typeof vi.fn>;
  pairInstalledModel: ReturnType<typeof vi.fn>;
};

describe('OllamaModelLibraryPage', () => {
  beforeEach(() => {
    mockApi.getLibraryModels.mockReset();
    mockApi.pullModel.mockReset();
    mockApi.pairInstalledModel.mockReset();

    mockApi.getLibraryModels.mockResolvedValue({
      models: [
        {
          name: 'deepseek-coder-v2:33b',
          description: 'Coding model',
          parameterSize: '33B',
          quantization: 'Q4_K_M',
        },
      ],
    });
    mockApi.pullModel.mockResolvedValue(undefined);
    mockApi.pairInstalledModel.mockResolvedValue(undefined);
  });

  it('loads library models and triggers pull action', async () => {
    const user = userEvent.setup();
    render(<OllamaModelLibraryPage />);

    expect(await screen.findByText('deepseek-coder-v2:33b')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pull' }));

    await waitFor(() => {
      expect(mockApi.pullModel).toHaveBeenCalledWith('deepseek-coder-v2:33b');
    });
  });
});
