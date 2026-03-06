import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OllamaConnectionPage } from './OllamaConnectionPage';
import * as ollamaApiModule from '../services/ollamaApi';

vi.mock('../services/ollamaApi', () => ({
  ollamaApi: {
    getConnection: vi.fn(),
    updateConnection: vi.fn(),
    testConnection: vi.fn(),
  },
}));

const mockApi = ollamaApiModule.ollamaApi as unknown as {
  getConnection: ReturnType<typeof vi.fn>;
  updateConnection: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
};

describe('OllamaConnectionPage', () => {
  beforeEach(() => {
    mockApi.getConnection.mockReset();
    mockApi.updateConnection.mockReset();
    mockApi.testConnection.mockReset();

    mockApi.getConnection.mockResolvedValue({
      mode: 'local',
      endpoint: 'http://localhost:11434',
      connected: true,
      version: '0.6.4',
      loadedModels: [],
    });
    mockApi.testConnection.mockResolvedValue({
      mode: 'local',
      endpoint: 'http://localhost:11434',
      connected: true,
      version: '0.6.4',
      loadedModels: [],
    });
    mockApi.updateConnection.mockResolvedValue({
      mode: 'cloud',
      endpoint: 'https://ollama.com',
      connected: true,
      version: '0.6.4',
      loadedModels: [],
    });
  });

  it('switching mode updates endpoint defaults and save payload stays mode-consistent', async () => {
    const user = userEvent.setup();
    render(<OllamaConnectionPage />);

    const endpointInput = await screen.findByLabelText('Endpoint');
    expect(endpointInput).toHaveValue('http://localhost:11434');

    await user.click(screen.getByRole('button', { name: 'Cloud' }));
    expect(screen.getByLabelText('Endpoint')).toHaveValue('https://ollama.com');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockApi.updateConnection).toHaveBeenCalledWith({
        mode: 'cloud',
        endpoint: 'https://ollama.com',
        apiKey: undefined,
      });
    });
  });
});
