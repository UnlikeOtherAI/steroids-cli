import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelUsageCard, ModelUsageCardEntry } from './ModelUsageCard';

function buildEntry(overrides: Partial<ModelUsageCardEntry> = {}): ModelUsageCardEntry {
  return {
    provider: 'claude',
    model: 'sonnet',
    invocationCount: 10,
    coderCount: 6,
    reviewerCount: 4,
    totalDurationMs: 0,
    avgDurationMs: 0,
    successRate: 95,
    failedCount: 0,
    timeoutCount: 0,
    tokens: {
      input: 2000,
      output: 1000,
      cachedInput: 0,
      cacheRead: 0,
      cacheCreation: 0,
    },
    cacheHitRate: 0,
    totalCostUsd: 1.25,
    ...overrides,
  };
}

describe('ModelUsageCard', () => {
  it('hides cache hit row and failure badges when values are zero', () => {
    render(<ModelUsageCard entry={buildEntry()} />);

    expect(screen.queryByText('Cache Hit Rate')).not.toBeInTheDocument();
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/timeout/)).not.toBeInTheDocument();
  });

  it('shows cache hit row and failure badges when values are present', () => {
    render(
      <ModelUsageCard
        entry={buildEntry({
          cacheHitRate: 23.4,
          failedCount: 2,
          timeoutCount: 1,
        })}
      />,
    );

    expect(screen.getByText('Cache Hit Rate')).toBeInTheDocument();
    expect(screen.getByText('23.4%')).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();
    expect(screen.getByText('1 timeout')).toBeInTheDocument();
  });

  it('applies success-rate color thresholds', () => {
    const { rerender } = render(<ModelUsageCard entry={buildEntry({ successRate: 95 })} />);
    expect(screen.getByText('95%')).toHaveClass('text-success');

    rerender(<ModelUsageCard entry={buildEntry({ successRate: 75 })} />);
    expect(screen.getByText('75%')).toHaveClass('text-warning');

    rerender(<ModelUsageCard entry={buildEntry({ successRate: 65 })} />);
    expect(screen.getByText('65%')).toHaveClass('text-danger');
  });
});
