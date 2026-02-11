import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CreditExhaustionModal } from './CreditExhaustionModal';
import type { CreditAlert } from '../../services/api';

const mockAlert: CreditAlert = {
  id: 'alert-1',
  provider: 'claude',
  model: 'opus',
  role: 'coder',
  message: 'Insufficient credits',
  createdAt: '2025-01-15T10:30:00Z',
};

describe('CreditExhaustionModal', () => {
  it('renders the Out of Credits title', () => {
    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={vi.fn()}
        onChangeModel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('Out of Credits')).toBeInTheDocument();
  });

  it('displays provider, model, and role from the alert', () => {
    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={vi.fn()}
        onChangeModel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('opus')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it('renders all three action buttons', () => {
    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={vi.fn()}
        onChangeModel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /change ai model/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('calls onChangeModel when Change AI Model is clicked', async () => {
    const user = userEvent.setup();
    const onChangeModel = vi.fn();

    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={vi.fn()}
        onChangeModel={onChangeModel}
        onRetry={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /change ai model/i }));
    expect(onChangeModel).toHaveBeenCalledOnce();
  });

  it('calls onRetry when Retry is clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={vi.fn()}
        onChangeModel={vi.fn()}
        onRetry={onRetry}
      />,
    );

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when Dismiss is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={onDismiss}
        onChangeModel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when the backdrop is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();

    const { container } = render(
      <CreditExhaustionModal
        alert={mockAlert}
        onDismiss={onDismiss}
        onChangeModel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    // The backdrop is the element with bg-black/40 class
    const backdrop = container.querySelector('.bg-black\\/40');
    expect(backdrop).toBeTruthy();
    await user.click(backdrop!);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
