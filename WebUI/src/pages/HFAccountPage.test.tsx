import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HFAccountPage } from './HFAccountPage';
import * as hfApiModule from '../services/huggingFaceApi';

vi.mock('../services/huggingFaceApi', () => ({
  huggingFaceApi: {
    getAccount: vi.fn(),
    getUsage: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  },
}));

const mockApi = hfApiModule.huggingFaceApi as unknown as {
  getAccount: ReturnType<typeof vi.fn>;
  getUsage: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

describe('HFAccountPage', () => {
  beforeEach(() => {
    mockApi.getAccount.mockReset();
    mockApi.getUsage.mockReset();
    mockApi.connect.mockReset();
    mockApi.disconnect.mockReset();
    mockApi.getUsage.mockResolvedValue({
      today: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        requests: 0,
        estimatedCostUsd: 0,
      },
      byModel7d: [],
    });
    mockApi.connect.mockResolvedValue(undefined);
    mockApi.disconnect.mockResolvedValue(undefined);
  });

  it('renders disconnected state and allows connect', async () => {
    mockApi.getAccount
      .mockResolvedValueOnce({ connected: false })
      .mockResolvedValueOnce({ connected: true, valid: true, name: 'alice', tier: 'pro', canPay: true });

    const user = userEvent.setup();
    render(<HFAccountPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connect Account' })).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('hf_...'), 'hf_token_123');
    await user.click(screen.getByRole('button', { name: 'Connect Account' }));

    await waitFor(() => {
      expect(mockApi.connect).toHaveBeenCalledWith('hf_token_123');
    });
    await waitFor(() => {
      expect(screen.getByText('alice')).toBeInTheDocument();
    });
  });

  it('renders connected state and allows disconnect', async () => {
    mockApi.getAccount
      .mockResolvedValueOnce({ connected: true, valid: true, name: 'alice', tier: 'free', canPay: false })
      .mockResolvedValueOnce({ connected: false });

    const user = userEvent.setup();
    render(<HFAccountPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => {
      expect(mockApi.disconnect).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Connect Account' })).toBeInTheDocument();
    });
  });
});
