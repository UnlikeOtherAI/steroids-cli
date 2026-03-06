import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelUsageSummary } from './ModelUsageSummary';

describe('ModelUsageSummary', () => {
  it('renders aggregate stat values and token breakdown', () => {
    render(
      <ModelUsageSummary
        summary={{
          totalDurationMs: 3661000,
          totalInvocations: 42,
          totalCostUsd: 12.5,
          totalInputTokens: 1200,
          totalOutputTokens: 300,
        }}
      />,
    );

    expect(screen.getByText('1h 1m')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('1,200 in / 300 out')).toBeInTheDocument();
  });

  it('renders 0s when total execution time is zero', () => {
    render(
      <ModelUsageSummary
        summary={{
          totalDurationMs: 0,
          totalInvocations: 1,
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        }}
      />,
    );

    expect(screen.getByText('0s')).toBeInTheDocument();
  });
});
