import type { OllamaConnectionMode } from '../ollama/connection.js';

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function formatOllamaHttpError(
  status: number,
  responseBody: string,
  model: string,
): string {
  const body = responseBody.toLowerCase();
  if (status === 401) {
    return 'Ollama API key rejected. Check OLLAMA_API_KEY.';
  }
  if (status === 404) {
    return `Model '${model}' not found on Ollama. Run: ollama pull ${model}`;
  }
  if (status === 500 && body.includes('model requires more system memory')) {
    return `Insufficient VRAM for model '${model}'.`;
  }
  if (status >= 500) {
    return `Ollama server error (${status}).`;
  }
  return `Ollama request failed (${status}).`;
}

export function formatOllamaInvocationError(
  error: unknown,
  context: {
    hostPort: string;
    model: string;
    coldStartTimedOut: boolean;
    timeoutMs: number;
    mode: OllamaConnectionMode;
  },
): string {
  if (context.coldStartTimedOut) {
    return `Ollama model '${context.model}' is taking too long to load. It may be too large for available VRAM.`;
  }

  if (isAbortError(error)) {
    return `Ollama request timed out after ${context.timeoutMs}ms`;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.includes('econnrefused') || lower.includes('connection refused') || lower.includes('fetch failed')) {
    return `Cannot connect to Ollama at ${context.hostPort}. Is Ollama running?`;
  }
  if (lower.includes('model not found')) {
    return `Model '${context.model}' not found on Ollama. Run: ollama pull ${context.model}`;
  }
  if (lower.includes('model requires more system memory') || lower.includes('insufficient memory')) {
    return `Insufficient VRAM for model '${context.model}'.`;
  }
  if (context.mode === 'cloud' && (lower.includes('401') || lower.includes('unauthorized'))) {
    return 'Ollama API key rejected. Check OLLAMA_API_KEY.';
  }
  return message;
}

export function resolveOllamaHostPort(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return endpoint;
  }
}
