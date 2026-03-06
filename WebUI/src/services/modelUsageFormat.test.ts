import { describe, expect, it } from 'vitest';
import {
  formatModelLabel,
  formatProjectLabel,
  formatTokenCount,
  formatUsdCost,
} from './modelUsageFormat';

describe('modelUsageFormat', () => {
  it('formats token counts with locale separators', () => {
    expect(formatTokenCount(1234567)).toBe('1,234,567');
  });

  it('normalizes invalid token values to zero', () => {
    expect(formatTokenCount(-1)).toBe('0');
    expect(formatTokenCount(Number.NaN)).toBe('0');
  });

  it('formats USD cost by magnitude', () => {
    expect(formatUsdCost(0)).toBe('$0.00');
    expect(formatUsdCost(1.234)).toBe('$1.23');
    expect(formatUsdCost(0.1056)).toBe('$0.1056');
    expect(formatUsdCost(0.000456)).toBe('$0.000456');
    expect(formatUsdCost(0.00001)).toBe('<$0.0001');
  });

  it('builds model and project labels', () => {
    expect(formatModelLabel('claude', 'claude-3-7-sonnet')).toBe('claude/claude-3-7-sonnet');
    expect(formatProjectLabel('Project One', '/repo/project')).toBe('Project One');
    expect(formatProjectLabel(null, '/repo/project')).toBe('/repo/project');
  });
});
