/**
 * Formatting helpers for model usage UI values.
 */

function safeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function formatTokenCount(value: number): string {
  return safeNumber(value).toLocaleString();
}

export function formatUsdCost(value: number): string {
  const safeValue = safeNumber(value);
  if (safeValue === 0) return '$0.00';

  if (safeValue >= 1) {
    return `$${safeValue.toFixed(2)}`;
  }

  if (safeValue >= 0.01) {
    return `$${safeValue.toFixed(4)}`;
  }

  if (safeValue >= 0.0001) {
    return `$${safeValue.toFixed(6)}`;
  }

  return '<$0.0001';
}

export function formatModelLabel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function formatProjectLabel(projectName: string | null, projectPath: string): string {
  return projectName || projectPath;
}
