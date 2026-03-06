import { describe, expect, it } from '@jest/globals';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HuggingFaceUsageMetrics,
  parseHubRateLimitHeaders,
  parseRoutedModel,
} from '../src/huggingface/metrics.js';

function makeTempHome(): string {
  const dir = join('/tmp', `hf-metrics-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('HuggingFaceUsageMetrics', () => {
  it('parses routed model selections', () => {
    expect(parseRoutedModel('deepseek-ai/DeepSeek-V3')).toEqual({
      baseModel: 'deepseek-ai/DeepSeek-V3',
      routingPolicy: 'fastest',
      explicitProvider: null,
    });

    expect(parseRoutedModel('deepseek-ai/DeepSeek-V3:cheapest')).toEqual({
      baseModel: 'deepseek-ai/DeepSeek-V3',
      routingPolicy: 'cheapest',
      explicitProvider: null,
    });

    expect(parseRoutedModel('deepseek-ai/DeepSeek-V3:novita')).toEqual({
      baseModel: 'deepseek-ai/DeepSeek-V3',
      routingPolicy: 'novita',
      explicitProvider: 'novita',
    });
  });

  it('parses hub API rate limit headers', () => {
    const parsed = parseHubRateLimitHeaders({
      rateLimit: '"api";r=489;t=189',
      rateLimitPolicy: '"fixed window";"api";q=500;w=300',
    }, 123456);

    expect(parsed).toEqual({
      remaining: 489,
      limit: 500,
      resetSeconds: 189,
      windowSeconds: 300,
      observedAtMs: 123456,
    });
  });

  it('records usage rows and returns dashboard summaries', async () => {
    const originalHome = process.env.STEROIDS_HOME;
    const homeDir = makeTempHome();
    process.env.STEROIDS_HOME = homeDir;

    const metrics = new HuggingFaceUsageMetrics({
      registry: {
        getCachedModel: () => ({
          id: 'deepseek-ai/DeepSeek-V3',
          pipelineTag: 'text-generation',
          downloads: 0,
          likes: 0,
          tags: [],
          providers: ['novita', 'groq'],
          pricing: {
            novita: { input: 0.05, output: 0.25 },
            groq: { input: 0.15, output: 0.75 },
          },
          addedAt: Date.now(),
          source: 'search',
        }),
      },
    });

    metrics.recordInvocationUsage({
      requestedModel: 'deepseek-ai/DeepSeek-V3:cheapest',
      role: 'coder',
      tokenUsage: {
        inputTokens: 1_000,
        outputTokens: 500,
      },
    });

    metrics.recordInvocationUsage({
      requestedModel: 'deepseek-ai/DeepSeek-V3:groq',
      role: 'reviewer',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 100,
      },
    });

    const usage = metrics.getDashboardUsage();
    expect(usage.today.requests).toBe(2);
    expect(usage.today.totalTokens).toBe(1700);
    expect(usage.byModel7d).toHaveLength(2);
    expect(usage.byModel7d[0].model).toBe('deepseek-ai/DeepSeek-V3');
    expect(usage.byModel7d[0].estimatedCostUsd).toBeGreaterThan(0);

    await rm(homeDir, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.STEROIDS_HOME;
    } else {
      process.env.STEROIDS_HOME = originalHome;
    }
  });
});
