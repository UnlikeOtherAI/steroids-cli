import type { ModelInfo } from './interface.js';

export type SemaphoreRelease = () => void;

export class EndpointSemaphore {
  private maxConcurrent: number;
  private inUse = 0;
  private queue: Array<{
    resolve: (release: SemaphoreRelease) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  setMaxConcurrent(maxConcurrent: number): void {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.drainQueue();
  }

  async acquire(timeoutMs: number): Promise<SemaphoreRelease> {
    if (this.inUse < this.maxConcurrent) {
      this.inUse += 1;
      return this.buildRelease();
    }

    return new Promise<SemaphoreRelease>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter((entry) => entry.reject !== reject);
        reject(new Error(`All Ollama slots busy after waiting ${timeoutMs}ms`));
      }, Math.max(1, timeoutMs));

      this.queue.push({ resolve, reject, timer });
    });
  }

  private buildRelease(): SemaphoreRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inUse = Math.max(0, this.inUse - 1);
      this.drainQueue();
    };
  }

  private drainQueue(): void {
    while (this.inUse < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) {
        continue;
      }
      clearTimeout(next.timer);
      this.inUse += 1;
      next.resolve(this.buildRelease());
    }
  }
}

export function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

export function recommendRoles(modelId: string): Array<'orchestrator' | 'coder' | 'reviewer'> {
  const lower = modelId.toLowerCase();
  if (lower.includes('coder') || lower.includes('code')) {
    return ['coder', 'reviewer'];
  }
  if (lower.includes('instruct') || lower.includes('chat')) {
    return ['orchestrator', 'reviewer'];
  }
  return [];
}

export function extractContextLength(modelInfo?: Record<string, unknown>): number | undefined {
  if (!modelInfo || typeof modelInfo !== 'object') {
    return undefined;
  }

  for (const value of Object.values(modelInfo)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const candidate = (value as { context_length?: unknown }).context_length;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }

  return undefined;
}

export const OLLAMA_FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'qwen2.5-coder:32b',
    name: 'qwen2.5-coder:32b',
    recommendedFor: ['coder', 'reviewer'],
    supportsStreaming: true,
    contextWindow: 32768,
  },
  {
    id: 'deepseek-coder-v2:33b',
    name: 'deepseek-coder-v2:33b',
    recommendedFor: ['coder'],
    supportsStreaming: true,
    contextWindow: 32768,
  },
  {
    id: 'llama3.3:70b',
    name: 'llama3.3:70b',
    recommendedFor: ['orchestrator', 'reviewer'],
    supportsStreaming: true,
    contextWindow: 32768,
  },
];
